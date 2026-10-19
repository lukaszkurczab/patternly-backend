import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { COLLECTIONS, identityDocumentId } from "../src/infrastructure/firestore/paths.js";
import { PseudonymKeyRing } from "../src/infrastructure/security/pseudonymKeyRing.js";
import { fingerprintDatabase, fingerprintDeletionMarkers, OFFLINE_RESTORE_DATABASES, reconcileOfflineDeletionRestore } from "../src/modules/account-lifecycle/offlineDeletionRestore.js";
import { seedStagedErasureFixture } from "./stagedErasureFixtures.js";

const PROJECT = "demo-patternly-account-restore";
assert.equal(process.env.FIREBASE_PROJECT_ID, PROJECT);
assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? "", /^127\.0\.0\.1:\d+$/u);
assert.match(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "", /^127\.0\.0\.1:\d+$/u);
const configuredPortBase = process.env.PATTERNLY_ISOLATED_TEST_PORT_BASE;
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, `127.0.0.1:${configuredPortBase ? Number(configuredPortBase) + 1 : 18119}`);
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, `127.0.0.1:${configuredPortBase ?? 19119}`);

const app = initializeApp({ projectId: PROJECT }, "account-deletion-restore-emulator");
const source = getFirestore(app, OFFLINE_RESTORE_DATABASES.source);
const target = getFirestore(app, OFFLINE_RESTORE_DATABASES.target);
const keyA = randomBytes(32).toString("base64");
const keyB = randomBytes(32).toString("base64");
const ring = new PseudonymKeyRing([
  { version: "v2", status: "active", keyBase64: keyB },
  { version: "v1", status: "verify_only", keyBase64: keyA },
]);

async function clear(db: FirebaseFirestore.Firestore): Promise<void> {
  for (const collection of await db.listCollections()) await db.recursiveDelete(collection);
}

async function seedRestoredTarget(identityIds: readonly string[], restoreAt: Timestamp) {
  const oldUser = target.collection(COLLECTIONS.users).doc("restored-old-user");
  await oldUser.set({ createdAt: Timestamp.fromDate(new Date("2026-10-01T12:00:00.000Z")), profile: { displayName: "Old account" } });
  const staged = await seedStagedErasureFixture(target, oldUser.id, { missingParents: true, recordCount: 3 });
  await oldUser.collection("progress").doc("attempt").set({ status: "complete" });
  await oldUser.collection("security").doc("recoveryCodes").set({ hashes: ["hash"] });
  const fingerprintBeforeOrphans = await fingerprintDatabase(target);
  await oldUser.collection("orphaned-private").doc("missing-intermediate").collection("nested").doc("record").set({ private: true });
  await target.collection(COLLECTIONS.identityMappings).doc(identityDocumentId("firebase", "old-firebase-subject"))
    .set({ userId: oldUser.id, provider: "firebase", subject: "old-firebase-subject" });
  await target.collection(COLLECTIONS.recoveryCodeIndex).doc("recovery-index").set({ userId: oldUser.id });
  await target.collection(COLLECTIONS.accountRecoveryOperations).doc("recovery-op").set({ userId: oldUser.id });
  await target.collection(COLLECTIONS.accountRecoveryOperationResults).doc("recovery-result").set({ userId: oldUser.id });
  await target.collection(COLLECTIONS.sessionRevocationOperations).doc("session-revocation").set({ userId: oldUser.id });
  const purchase = target.collection("revenueCatTransactions").doc("purchase");
  await purchase.set({ ownerAccountId: oldUser.id });
  await purchase.collection("events").doc("nested").set({ private: true });
  await purchase.collection("orphaned-events").doc("missing-intermediate").collection("deep").doc("record").set({ private: true });
  assert.notEqual(await fingerprintDatabase(target), fingerprintBeforeOrphans, "the restore fingerprint includes descendants below missing parent docs");
  const fingerprintBeforeNestedControls = await fingerprintDatabase(target);
  await oldUser.collection("restoreReconciliationControls").doc("private-record").set({ private: true });
  assert.notEqual(await fingerprintDatabase(target), fingerprintBeforeNestedControls, "only top-level restore controls are excluded from the fingerprint");
  await target.collection(COLLECTIONS.accountDataExportAudits).doc("export-audit").set({ userId: oldUser.id });
  await target.collection(COLLECTIONS.accountDataExportRateLimits).doc(oldUser.id).set({ count: 1 });
  await target.collection(COLLECTIONS.contentReports).doc("report").set({ accountId: oldUser.id, contactEmail: "private@example.test" });
  await target.collection(COLLECTIONS.privacyRequests).doc("privacy-request").set({ userId: oldUser.id, subjectPseudonym: "private-pseudonym" });
  const unrelated = target.collection(COLLECTIONS.users).doc("unrelated-user");
  await unrelated.set({ marker: "preserve" });
  await unrelated.collection("progress").doc("keep").set({ status: "keep" });
  await target.collection(COLLECTIONS.identityMappings).doc(identityDocumentId("firebase", "unrelated-subject"))
    .set({ userId: unrelated.id, provider: "firebase", subject: "unrelated-subject" });
  const paginationBatch = target.batch();
  for (let index = 0; index < 205; index += 1) paginationBatch.set(target.collection("restoreFingerprintPagination").doc(`entry-${String(index).padStart(3, "0")}`), { index });
  await paginationBatch.commit();
  const targetFingerprint = await fingerprintDatabase(target);
  await target.collection("restoreReconciliationControls").doc("restore-point").set({ status: "restored_snapshot", restoreAt, targetFingerprint });
  await target.collection("restoreReconciliationControls").doc("live-fence").set({
    phase: "firestore_deleting", fence: "offline-restore-test-fence", userId: oldUser.id,
    leaseUntil: Timestamp.fromMillis(Date.now() + 10 * 60_000),
  });
  return { oldUser, unrelated, targetFingerprint, stagedRefs: staged.refs };
}

test("offline restore reconciliation refuses pending or partial clones and scrubs a clean restored clone", async (t) => {
  await clear(source);
  await clear(target);
  t.after(async () => {
    await clear(source);
    await clear(target);
    await deleteApp(app);
  });

  // Probe the installed Admin SDK against the real emulator: listDocuments must
  // expose a missing parent document whose subcollection still contains data.
  const probeRoot = target.collection(COLLECTIONS.users).doc("orphan-list-documents-probe");
  const probeLeaf = probeRoot.collection("orphaned-private").doc("missing-intermediate").collection("nested").doc("record");
  await probeLeaf.set({ marker: "probe" });
  assert.equal((await probeRoot.get()).exists, false);
  assert.equal((await probeRoot.collection("orphaned-private").get()).empty, true);
  const listedParents = await probeRoot.collection("orphaned-private").listDocuments();
  assert.deepEqual(listedParents.map(({ id }) => id), ["missing-intermediate"]);
  assert.deepEqual((await listedParents[0]!.collection("nested").listDocuments()).map(({ id }) => id), ["record"]);
  await target.recursiveDelete(probeRoot);

  const deletedAt = Timestamp.fromMillis(Date.now() - 10_000);
  const expiresAt = Timestamp.fromMillis(deletedAt.toMillis() + 45 * 24 * 60 * 60 * 1000);
  const cutoffAt = Timestamp.fromMillis(Date.now() - 1_000);
  const restoreAt = Timestamp.fromMillis(deletedAt.toMillis() - 24 * 60 * 60 * 1000);
  const identities = ring.candidates("firebase", "old-firebase-subject");
  const identity = identities.find(({ keyVersion }) => keyVersion === "v1")!;
  const tombstones = identities.map((item) => ({ provider: "firebase", keyVersion: item.keyVersion, subjectHmac: item.subjectHmac, deletedAt, expiresAt }));
  for (let index = 0; index < identities.length; index += 1) await source.collection(COLLECTIONS.deletedIdentities).doc(identities[index]!.documentId).set(tombstones[index]!);
  const sourceFreezeData = {
    status: "frozen", earliestVersionAt: Timestamp.fromDate(new Date("2026-09-01T00:00:00.000Z")), cutoffAt,
    ledgerFingerprint: await fingerprintDeletionMarkers(source),
  };
  await source.collection("restoreReconciliationControls").doc("source-freeze").set(sourceFreezeData);

  // A completed legacy deletion may have left descendants beneath its missing
  // root. An identical pre-restore marker cannot establish whose data remains.
  for (let index = 0; index < identities.length; index += 1) {
    await target.collection(COLLECTIONS.deletedIdentities).doc(identities[index]!.documentId).set(tombstones[index]!);
  }
  const orphanRoot = target.collection(COLLECTIONS.users).doc("legacy-deleted-user-root");
  const orphanRecord = orphanRoot.collection("legacy-profile").doc("orphan").collection("private").doc("record");
  await orphanRecord.set({ private: true });
  const orphanFingerprint = await fingerprintDatabase(target);
  await target.collection("restoreReconciliationControls").doc("restore-point").set({
    status: "restored_snapshot", restoreAt: Timestamp.fromMillis(deletedAt.toMillis() + 5_000), targetFingerprint: orphanFingerprint,
  });
  let orphanWriteGateReached = false;
  await assert.rejects(reconcileOfflineDeletionRestore({
    app, keyRing: ring, assertWriteAllowed: async () => { orphanWriteGateReached = true; },
  }), /offline_restore_orphan_user_root/u);
  assert.equal(orphanWriteGateReached, false, "an unowned orphan is rejected before any mutation gate");
  assert.equal(await fingerprintDatabase(target), orphanFingerprint);
  assert.equal((await orphanRoot.get()).exists, false);
  assert.equal((await orphanRecord.get()).exists, true, "unknown ownership is not guessed or silently erased");
  await clear(target);

  let { oldUser, unrelated, targetFingerprint, stagedRefs } = await seedRestoredTarget(identities.map(({ documentId }) => documentId), restoreAt);
  const gate = async (transaction: FirebaseFirestore.Transaction) => {
    assert.equal(source.databaseId, OFFLINE_RESTORE_DATABASES.source);
    assert.equal(target.databaseId, OFFLINE_RESTORE_DATABASES.target);
    assert.equal(process.env.FIREBASE_PROJECT_ID, PROJECT);
    assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? "", /^127\.0\.0\.1:\d+$/u);
    const operation = await transaction.get(target.collection("restoreReconciliationControls").doc("live-fence"));
    const operationData = operation.data();
    assert.equal(operationData?.phase, "firestore_deleting");
    assert.equal(operationData?.fence, "offline-restore-test-fence");
    assert.ok((operationData?.leaseUntil as Timestamp).toMillis() > Date.now());
    assert.equal(await fingerprintDeletionMarkers(source), await source.collection("restoreReconciliationControls").doc("source-freeze").get().then((snapshot) => snapshot.get("ledgerFingerprint")));
  };
  let failAtRootMappingGap = true;
  let markerExpiryAfterInterruption: number | null = null;
  const injectedGate = async (transaction: FirebaseFirestore.Transaction) => {
    await gate(transaction);
    const [user, mappings] = await Promise.all([
      oldUser.get(), target.collection(COLLECTIONS.identityMappings).where("userId", "==", oldUser.id).get(),
    ]);
    if (failAtRootMappingGap && user.exists && mappings.empty
      && (await target.collection(COLLECTIONS.deletedIdentities).doc(identity.documentId).get()).exists) {
      failAtRootMappingGap = false;
      markerExpiryAfterInterruption = (await target.collection(COLLECTIONS.deletedIdentities).doc(identity.documentId).get()).get("expiresAt") instanceof Timestamp
        ? ((await target.collection(COLLECTIONS.deletedIdentities).doc(identity.documentId).get()).get("expiresAt") as Timestamp).toMillis()
        : null;
      throw new Error("injected_interruption_after_marker_mapping_transaction");
    }
  };
  const run = (assertWriteAllowed: typeof gate = gate) => reconcileOfflineDeletionRestore({
    app, keyRing: ring, assertWriteAllowed,
  });

  // A no-active-marker run still must bind its receipt to unchanged evidence.
  for (const item of identities) await source.collection(COLLECTIONS.deletedIdentities).doc(item.documentId).delete();
  await source.collection("restoreReconciliationControls").doc("source-freeze").update({ ledgerFingerprint: await fingerprintDeletionMarkers(source) });
  let finalGateCalled = false;
  const lateSourceDriftGate = async (transaction: FirebaseFirestore.Transaction) => {
    await gate(transaction);
    finalGateCalled = true;
    await source.collection("restoreReconciliationControls").doc("source-freeze").update({ cutoffAt: Timestamp.fromMillis(cutoffAt.toMillis() + 1) });
  };
  await assert.rejects(run(lateSourceDriftGate), /offline_restore_final_drift/u);
  assert.equal(finalGateCalled, true, "final evidence gate runs when there is no active marker to reconcile");
  let finalTargetGateCalled = false;
  const lateTargetDriftGate = async (transaction: FirebaseFirestore.Transaction) => {
    await gate(transaction);
    finalTargetGateCalled = true;
    await target.collection("restoreReconciliationControls").doc("restore-point").update({ restoreAt: Timestamp.fromMillis(restoreAt.toMillis() + 1) });
  };
  await assert.rejects(run(lateTargetDriftGate), /offline_restore_final_drift/u);
  assert.equal(finalTargetGateCalled, true, "final gate binds the receipt to the target restore point");
  await target.collection("restoreReconciliationControls").doc("restore-point").set({ status: "restored_snapshot", restoreAt, targetFingerprint });
  for (let index = 0; index < identities.length; index += 1) await source.collection(COLLECTIONS.deletedIdentities).doc(identities[index]!.documentId).set(tombstones[index]!);
  await source.collection("restoreReconciliationControls").doc("source-freeze").set(sourceFreezeData);

  const beforeBadBoundary = await fingerprintDatabase(target);
  await source.collection("restoreReconciliationControls").doc("source-freeze").update({ cutoffAt: Timestamp.fromMillis(Date.now() + 10_000) });
  await assert.rejects(run(), /offline_restore_future_cutoff/u);
  assert.equal(await fingerprintDatabase(target), beforeBadBoundary);
  await source.collection("restoreReconciliationControls").doc("source-freeze").set(sourceFreezeData);
  await source.collection(COLLECTIONS.accountDeletionOperations).doc("source-pending").set({ phase: "auth_deleting", status: "pending" });
  await assert.rejects(run(), /offline_restore_source_pending_deletion/u);
  assert.equal(await fingerprintDatabase(target), beforeBadBoundary);
  await source.collection(COLLECTIONS.accountDeletionOperations).doc("source-pending").delete();
  await target.collection(COLLECTIONS.accountDeletionOperations).doc("target-pending").set({ phase: "firestore_deleting", status: "pending" });
  await assert.rejects(run(), /offline_restore_target_pending_deletion/u);
  await target.collection(COLLECTIONS.accountDeletionOperations).doc("target-pending").delete();
  await source.collection(COLLECTIONS.deletedIdentities).doc("malformed-ledger-entry").set({ provider: "firebase", keyVersion: "v1" });
  await assert.rejects(run(), /offline_restore_marker_invalid/u);
  assert.equal(await fingerprintDatabase(target), beforeBadBoundary);
  await source.collection(COLLECTIONS.deletedIdentities).doc("malformed-ledger-entry").delete();
  const driftIdentity = ring.active("firebase", "source-ledger-drift");
  await source.collection(COLLECTIONS.deletedIdentities).doc(driftIdentity.documentId).set({
    provider: "firebase", keyVersion: driftIdentity.keyVersion, subjectHmac: driftIdentity.subjectHmac,
    deletedAt, expiresAt,
  });
  await assert.rejects(run(), /offline_restore_source_drift/u);
  assert.equal(await fingerprintDatabase(target), beforeBadBoundary);
  await source.collection(COLLECTIONS.deletedIdentities).doc(driftIdentity.documentId).delete();
  await target.collection("restoreReconciliationControls").doc("restore-point").update({ restoreAt: Timestamp.fromMillis(Date.now() - 7 * 24 * 60 * 60 * 1000) });
  await assert.rejects(run(), /offline_restore_outside_retention/u);
  assert.equal(await fingerprintDatabase(target), beforeBadBoundary);
  await target.collection("restoreReconciliationControls").doc("restore-point").update({ restoreAt });

  const wrongRing = new PseudonymKeyRing([{ version: "v2", status: "active", keyBase64: randomBytes(32).toString("base64") }]);
  await assert.rejects(reconcileOfflineDeletionRestore({
    app, keyRing: wrongRing, assertWriteAllowed: gate,
  }), /offline_restore_key_unavailable/u);
  assert.equal(await fingerprintDatabase(target), targetFingerprint);

  await assert.rejects(run(injectedGate), /injected_interruption_after_marker_mapping_transaction/u);
  assert.equal(markerExpiryAfterInterruption, expiresAt.toMillis(), "the interrupted attempt preserved the source expiry without renewal");
  assert.equal((await oldUser.get()).exists, true, "account data remains visible while a target operation is interrupted");
  assert.equal((await target.collection(COLLECTIONS.identityMappings).doc(identityDocumentId("firebase", "old-firebase-subject")).get()).exists, false);
  await assert.rejects(run(), /offline_restore_target_drift/u, "a partial target is rejected and must be discarded");
  await clear(target);
  ({ oldUser, unrelated, targetFingerprint, stagedRefs } = await seedRestoredTarget(identities.map(({ documentId }) => documentId), restoreAt));
  const receipt = await run();
  assert.equal(receipt.status, "reconciled");
  assert.equal(receipt.markerCount, identities.length);
  assert.equal(receipt.affectedAccountCount, 1);
  assert.ok(receipt.erased.accountTreeDocuments > 0, "the receipt counts physically erased staged account-tree documents");
  const stagedReadback = await target.getAll(...stagedRefs);
  assert.ok(stagedReadback.length > 0);
  assert.ok(stagedReadback.every((snapshot) => !snapshot.exists), "staged account documents, including children below a missing transfer parent, are physically erased");
  assert.equal((await target.collection(COLLECTIONS.accounts).doc(oldUser.id).get()).exists, false);
  assert.equal((await target.collection(COLLECTIONS.identityMappings).doc(identity.documentId).get()).exists, false);
  for (const item of identities) assert.equal((await target.collection(COLLECTIONS.deletedIdentities).doc(item.documentId).get()).get("expiresAt").toMillis(), expiresAt.toMillis());
  assert.equal((await target.collection(COLLECTIONS.recoveryCodeIndex).where("userId", "==", oldUser.id).get()).empty, true);
  assert.equal((await target.collection("revenueCatTransactions").where("ownerAccountId", "==", oldUser.id).get()).empty, true);
  assert.deepEqual(await oldUser.collection("orphaned-private").listDocuments(), [], "nested user data beneath a missing document is erased");
  assert.deepEqual(await target.collection("revenueCatTransactions").doc("purchase").collection("orphaned-events").listDocuments(), [], "purchase subtrees beneath a missing document are erased");
  assert.equal((await target.collection(COLLECTIONS.contentReports).doc("report").get()).get("accountId"), undefined);
  assert.equal((await target.collection(COLLECTIONS.privacyRequests).doc("privacy-request").get()).get("userId"), undefined);
  assert.equal((await unrelated.get()).get("marker"), "preserve");
  assert.equal((await unrelated.collection("progress").doc("keep").get()).exists, true);
  assert.equal((await target.collection(COLLECTIONS.identityMappings).doc(identityDocumentId("firebase", "unrelated-subject")).get()).exists, true);
  assert.equal((await target.collection("restoreFingerprintPagination").get()).size, 205);
  const receiptText = JSON.stringify(receipt);
  assert.equal(receiptText.includes("old-firebase-subject"), false);
  assert.equal(receiptText.includes("private@example.test"), false);
  assert.equal(receiptText.includes("restored-old-user"), false);
  await assert.rejects(run(), /offline_restore_target_drift/u, "completed clone cannot be replayed as the original restored snapshot");
});
