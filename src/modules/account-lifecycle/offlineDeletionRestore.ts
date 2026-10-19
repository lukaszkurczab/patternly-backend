import { createHash } from "node:crypto";
import type { App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore, Timestamp as TimestampType } from "firebase-admin/firestore";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import type { PseudonymKeyRing } from "../../infrastructure/security/pseudonymKeyRing.js";
import { COLLECTIONS, identityDocumentId } from "../../infrastructure/firestore/paths.js";
import { ACCOUNT_DELETION_TOMBSTONE_RETENTION_MS, LEGACY_ACCOUNT_DELETION_TOMBSTONE_RETENTION_MS, assertFirestoreAccountErasureComplete, deletedIdentityLogicalExpiryMs, eraseFirestoreAccountData, type AccountErasureCounts, type StoredDeletionIdentity } from "./firestoreAccountErasure.js";

export const OFFLINE_RESTORE_DATABASES = Object.freeze({ source: "r01-source", target: "r01-target" });

type SourceFreeze = Readonly<{ status: "frozen"; earliestVersionAt: TimestampType; cutoffAt: TimestampType; ledgerFingerprint: string }>;
type RestoreMetadata = Readonly<{ status: "restored_snapshot"; restoreAt: TimestampType; targetFingerprint: string }>;
export type OfflineRestoreReceipt = Readonly<{
  scope: "offline_emulator_only_not_deployable";
  status: "reconciled";
  sourceLedgerFingerprint: string;
  targetBeforeFingerprint: string;
  targetAfterFingerprint: string;
  markerCount: number;
  affectedAccountCount: number;
  erased: AccountErasureCounts;
}>;

function fail(code: string): never { throw new Error(code); }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("offline_restore_record_invalid");
  return value as Record<string, unknown>;
}
function millis(value: unknown): number {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  return fail("offline_restore_timestamp_invalid");
}
function stable(value: unknown): string {
  if (value instanceof Timestamp) return JSON.stringify({ __timestampMillis: value.toMillis() });
  if (value instanceof Date) return JSON.stringify({ __timestampMillis: value.getTime() });
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function expectedLocalFirestoreEmulatorHost(): string | null {
  const baseValue = process.env.PATTERNLY_ISOLATED_TEST_PORT_BASE;
  if (baseValue === undefined || baseValue === "") return "127.0.0.1:18119";
  if (!/^\d{4,5}$/u.test(baseValue)) return null;
  const base = Number(baseValue);
  if (!Number.isSafeInteger(base) || base < 10000 || base > 65532) return null;
  return `127.0.0.1:${base + 1}`;
}

/** Full named-database fingerprint for the bounded local restore harness; never emitted as row data. */
export async function fingerprintDatabase(db: Firestore): Promise<string> {
  const entries: string[] = [];
  const visit = async (collection: FirebaseFirestore.CollectionReference): Promise<void> => {
    if (collection.path === "restoreReconciliationControls") return;
    // listDocuments includes missing parent refs with descendants, but has no
    // cursor option. Keep each read/recurse group bounded and hash missing refs.
    const refs = await collection.listDocuments();
    refs.sort((left, right) => left.id.localeCompare(right.id));
    const pageSize = 200;
    for (let offset = 0; offset < refs.length; offset += pageSize) {
      const page = refs.slice(offset, offset + pageSize);
      const snapshots = await db.getAll(...page);
      for (let index = 0; index < page.length; index += 1) {
        const ref = page[index];
        const snapshot = snapshots[index];
        if (!ref) continue;
        if (!snapshot) continue;
        entries.push([ref.path, snapshot.exists ? stable(snapshot.data()) : "<missing-document-with-descendants>"].join("\0"));
        for (const child of await ref.listCollections()) await visit(child);
      }
    }
  };
  for (const collection of await db.listCollections()) await visit(collection);
  entries.sort();
  return sha256(entries.join("\n"));
}

function readMarker(snapshot: FirebaseFirestore.DocumentSnapshot): StoredDeletionIdentity & { deletedAt: Timestamp; expiresAt: Timestamp } {
  const data = record(snapshot.data());
  const keys = Object.keys(data).sort();
  if (keys.join(",") !== "deletedAt,expiresAt,keyVersion,provider,subjectHmac"
    || typeof data.provider !== "string" || typeof data.keyVersion !== "string" || typeof data.subjectHmac !== "string"
    || !/^[a-f0-9]{64}$/u.test(data.subjectHmac)) return fail("offline_restore_marker_invalid");
  const deletedAt = data.deletedAt;
  const expiresAt = data.expiresAt;
  const deletedMs = millis(deletedAt);
  const expiresMs = millis(expiresAt);
  if ((expiresMs !== deletedMs + ACCOUNT_DELETION_TOMBSTONE_RETENTION_MS && expiresMs !== deletedMs + LEGACY_ACCOUNT_DELETION_TOMBSTONE_RETENTION_MS)
    || deletedIdentityLogicalExpiryMs(data) === null || snapshot.id !== `${data.keyVersion}_${data.subjectHmac}`) return fail("offline_restore_marker_invalid");
  return Object.freeze({ identityId: snapshot.id, provider: data.provider, keyVersion: data.keyVersion, subjectHmac: data.subjectHmac, deletedAt: deletedAt as Timestamp, expiresAt: expiresAt as Timestamp });
}

async function assertNoPendingDeletionOperations(db: Firestore, failureCode: string): Promise<void> {
  const operations = await db.collection(COLLECTIONS.accountDeletionOperations).get();
  if (operations.docs.some((snapshot) => {
    const data = record(snapshot.data());
    return data.phase !== "complete" || data.status !== "complete";
  })) fail(failureCode);
}

async function assertNoOrphanUserRoots(db: Firestore): Promise<void> {
  const refs = await db.collection(COLLECTIONS.users).listDocuments();
  for (let offset = 0; offset < refs.length; offset += 200) {
    const snapshots = await db.getAll(...refs.slice(offset, offset + 200));
    // listDocuments includes missing roots that still have descendants. A
    // tombstone contains no userId, so their owner cannot be safely inferred.
    if (snapshots.some((snapshot) => !snapshot.exists)) fail("offline_restore_orphan_user_root");
  }
}

export async function fingerprintDeletionMarkers(db: Firestore): Promise<string> {
  const snapshots = await db.collection(COLLECTIONS.deletedIdentities).orderBy(FieldPath.documentId()).get();
  return sha256(snapshots.docs.map(readMarker).map((marker) => stable(marker)).join("\n"));
}

/**
 * Emulator-only account-deletion model. It opens only fixed demo named DBs and
 * refuses ambiguous/interrupted clones; it is not a PITR/backup adapter or a
 * production maintenance command. Legal/privacy request retention catalogs
 * remain outside the current account-erasure catalog and this model. A source
 * marker without a verified mapping or an already-present pre-restore marker
 * fails with `offline_restore_identity_mapping_missing`, since the current
 * ledger cannot prove the identity was absent rather than orphaned at restore.
 */
export async function reconcileOfflineDeletionRestore(options: Readonly<{
  app: App;
  keyRing: PseudonymKeyRing;
  /** Local write gate; revalidates environment and frozen source evidence for every guarded mutation. */
  assertWriteAllowed: (transaction: FirebaseFirestore.Transaction) => Promise<void>;
}>): Promise<OfflineRestoreReceipt> {
  const { keyRing } = options;
  const expectedProjectId = "demo-patternly-account-restore";
  const expectedFirestoreHost = expectedLocalFirestoreEmulatorHost();
  if (process.env.FIREBASE_PROJECT_ID !== expectedProjectId || !expectedFirestoreHost || process.env.FIRESTORE_EMULATOR_HOST !== expectedFirestoreHost
    || options.app.options.projectId !== expectedProjectId) return fail("offline_restore_environment_rejected");
  const source = getFirestore(options.app, OFFLINE_RESTORE_DATABASES.source);
  const target = getFirestore(options.app, OFFLINE_RESTORE_DATABASES.target);
  if (source.databaseId !== OFFLINE_RESTORE_DATABASES.source || target.databaseId !== OFFLINE_RESTORE_DATABASES.target
    || String(source.databaseId) === String(target.databaseId)) return fail("offline_restore_environment_rejected");

  const freezeSnapshot = await source.collection("restoreReconciliationControls").doc("source-freeze").get();
  const restoreSnapshot = await target.collection("restoreReconciliationControls").doc("restore-point").get();
  if (!freezeSnapshot.exists || !restoreSnapshot.exists) return fail("offline_restore_control_missing");
  const freeze = record(freezeSnapshot.data()) as unknown as SourceFreeze;
  const restore = record(restoreSnapshot.data()) as unknown as RestoreMetadata;
  if (freeze.status !== "frozen" || restore.status !== "restored_snapshot" || !(freeze.earliestVersionAt instanceof Timestamp)
    || !(freeze.cutoffAt instanceof Timestamp) || !(restore.restoreAt instanceof Timestamp)
    || !/^[a-f0-9]{64}$/u.test(freeze.ledgerFingerprint) || !/^[a-f0-9]{64}$/u.test(restore.targetFingerprint)) return fail("offline_restore_control_invalid");
  const restoreAt = restore.restoreAt.toMillis();
  const cutoffAt = freeze.cutoffAt.toMillis();
  const admissionAt = Date.now();
  if (cutoffAt > admissionAt) return fail("offline_restore_future_cutoff");
  if (restoreAt < freeze.earliestVersionAt.toMillis() || restoreAt > cutoffAt || admissionAt < restoreAt || admissionAt - restoreAt >= ACCOUNT_DELETION_TOMBSTONE_RETENTION_MS) return fail("offline_restore_outside_retention");
  await assertNoPendingDeletionOperations(source, "offline_restore_source_pending_deletion");
  await assertNoPendingDeletionOperations(target, "offline_restore_target_pending_deletion");
  await assertNoOrphanUserRoots(target);

  const markerSnapshots = await source.collection(COLLECTIONS.deletedIdentities).orderBy(FieldPath.documentId()).get();
  const markers = markerSnapshots.docs.map(readMarker);
  if (markers.some((marker) => marker.deletedAt.toMillis() > freeze.cutoffAt.toMillis())) return fail("offline_restore_source_marker_after_cutoff");
  const sourceFingerprint = sha256(markers.map((marker) => stable(marker)).join("\n"));
  if (sourceFingerprint !== freeze.ledgerFingerprint) return fail("offline_restore_source_drift");
  const activeMarkers = markers.filter((marker) => (deletedIdentityLogicalExpiryMs({ provider: marker.provider, keyVersion: marker.keyVersion, subjectHmac: marker.subjectHmac, deletedAt: marker.deletedAt, expiresAt: marker.expiresAt }) ?? 0) > Date.now());
  if (activeMarkers.some((marker) => !keyRing.candidates(marker.provider, "key-availability-probe").some(({ keyVersion }) => keyVersion === marker.keyVersion))) return fail("offline_restore_key_unavailable");

  const targetBefore = await fingerprintDatabase(target);
  if (targetBefore !== restore.targetFingerprint) return fail("offline_restore_target_drift");
  const mappingsSnapshot = await target.collection(COLLECTIONS.identityMappings).orderBy(FieldPath.documentId()).get();
  const mappingRows = mappingsSnapshot.docs.map((snapshot) => ({ snapshot, data: record(snapshot.data()) }));
  const identitiesByUser = new Map<string, StoredDeletionIdentity[]>();
  const matchedMappingIds = new Set<string>();
  for (const { snapshot, data } of mappingRows) {
    if (typeof data.userId !== "string" || typeof data.provider !== "string" || typeof data.subject !== "string" || !data.subject) return fail("offline_restore_target_mapping_invalid");
    if (snapshot.id !== identityDocumentId(data.provider, data.subject)) return fail("offline_restore_identity_mapping_mismatch");
    const matching = activeMarkers.filter((marker) => marker.provider === data.provider && keyRing.verify(marker.provider, data.subject as string, marker));
    if (matching.length === 0) continue;
    matchedMappingIds.add(snapshot.id);
    const refs = identitiesByUser.get(data.userId) ?? [];
    for (const marker of matching) if (!refs.some(({ identityId }) => identityId === marker.identityId)) refs.push(marker);
    identitiesByUser.set(data.userId, refs);
  }
  for (const marker of activeMarkers) {
    const mapped = [...identitiesByUser.values()].some((refs) => refs.some(({ identityId }) => identityId === marker.identityId));
    if (mapped) continue;
    const existing = await target.collection(COLLECTIONS.deletedIdentities).doc(marker.identityId).get();
    if (!existing.exists || stable(readMarker(existing)) !== stable(marker) || marker.deletedAt.toMillis() > restoreAt) return fail("offline_restore_identity_mapping_missing");
  }
  for (const [userId, refs] of identitiesByUser) {
    const mappedForUser = mappingRows.filter(({ data }) => data.userId === userId);
    if (mappedForUser.some(({ snapshot }) => !matchedMappingIds.has(snapshot.id)) || refs.length === 0) return fail("offline_restore_incomplete_identity_set");
  }

  const counts: AccountErasureCounts[] = [];
  for (const marker of activeMarkers) {
    const existing = await target.collection(COLLECTIONS.deletedIdentities).doc(marker.identityId).get();
    if (existing.exists) {
      const current = readMarker(existing);
      if (stable(current) !== stable(marker)) return fail("offline_restore_target_marker_conflict");
    }
  }
  // Recheck both controls and both snapshots immediately before the first mutation.
  const [sourceNow, targetNow, freezeNow, restoreNow] = await Promise.all([
    source.collection(COLLECTIONS.deletedIdentities).orderBy(FieldPath.documentId()).get(),
    fingerprintDatabase(target),
    source.collection("restoreReconciliationControls").doc("source-freeze").get(),
    target.collection("restoreReconciliationControls").doc("restore-point").get(),
  ]);
  if (sha256(sourceNow.docs.map(readMarker).map((marker) => stable(marker)).join("\n")) !== freeze.ledgerFingerprint
    || targetNow !== restore.targetFingerprint || stable(freezeNow.data()) !== stable(freezeSnapshot.data())
    || stable(restoreNow.data()) !== stable(restoreSnapshot.data())) return fail("offline_restore_preflight_drift");
  const assertFrozenSource = async (transaction: FirebaseFirestore.Transaction): Promise<void> => {
    const currentTime = Date.now();
    if (cutoffAt > currentTime) return fail("offline_restore_future_cutoff");
    if (currentTime < restoreAt || currentTime - restoreAt >= ACCOUNT_DELETION_TOMBSTONE_RETENTION_MS) return fail("offline_restore_outside_retention");
    await options.assertWriteAllowed(transaction);
    await assertNoPendingDeletionOperations(source, "offline_restore_source_pending_deletion");
    await assertNoPendingDeletionOperations(target, "offline_restore_target_pending_deletion");
    const [currentMarkers, currentFreeze] = await Promise.all([
      source.collection(COLLECTIONS.deletedIdentities).orderBy(FieldPath.documentId()).get(),
      source.collection("restoreReconciliationControls").doc("source-freeze").get(),
    ]);
    const fingerprint = sha256(currentMarkers.docs.map(readMarker).map((marker) => stable(marker)).join("\n"));
    if (fingerprint !== freeze.ledgerFingerprint || stable(currentFreeze.data()) !== stable(freezeSnapshot.data())) return fail("offline_restore_source_drift");
  };

  for (const [userId, refs] of identitiesByUser) {
    const countsForUser = await eraseFirestoreAccountData({
      db: target,
      userId,
      identityRefs: refs,
      assertWriteAllowed: assertFrozenSource,
      verifyMapping: (provider, subject, expected) => provider === expected.provider && keyRing.verify(provider, subject, expected),
      tombstoneWrite: (identity, existing) => {
        const sourceMarker = activeMarkers.find(({ identityId }) => identityId === identity.identityId);
        if (!sourceMarker) return fail("offline_restore_source_marker_missing");
        if (existing.exists && stable(readMarker(existing as FirebaseFirestore.DocumentSnapshot)) !== stable(sourceMarker)) return fail("offline_restore_target_marker_conflict");
        return { provider: sourceMarker.provider, keyVersion: sourceMarker.keyVersion, subjectHmac: sourceMarker.subjectHmac, deletedAt: sourceMarker.deletedAt, expiresAt: sourceMarker.expiresAt };
      },
    });
    counts.push(countsForUser);
    for (const ref of refs) await assertFirestoreAccountErasureComplete(target, userId, [ref]);
  }
  for (const marker of activeMarkers.filter((candidate) => ![...identitiesByUser.values()].some((refs) => refs.some(({ identityId }) => identityId === candidate.identityId)))) {
    counts.push(await eraseFirestoreAccountData({
      db: target,
      userId: null,
      identityRefs: [marker],
      assertWriteAllowed: assertFrozenSource,
      verifyMapping: (provider, subject, expected) => provider === expected.provider && keyRing.verify(provider, subject, expected),
      tombstoneWrite: (identity, existing) => {
        const sourceMarker = activeMarkers.find(({ identityId }) => identityId === identity.identityId);
        if (!sourceMarker) return fail("offline_restore_source_marker_missing");
        if (existing.exists && stable(readMarker(existing as FirebaseFirestore.DocumentSnapshot)) !== stable(sourceMarker)) return fail("offline_restore_target_marker_conflict");
        return { provider: sourceMarker.provider, keyVersion: sourceMarker.keyVersion, subjectHmac: sourceMarker.subjectHmac, deletedAt: sourceMarker.deletedAt, expiresAt: sourceMarker.expiresAt };
      },
    }));
  }
  const targetAfter = await fingerprintDatabase(target);
  // The final gate runs even when no marker was active and no target mutation
  // was needed. Bind the receipt to unchanged source, freeze, and restore-point
  // evidence after all work, then verify the target has not drifted since hash.
  await target.runTransaction(async (transaction) => {
    await options.assertWriteAllowed(transaction);
    const currentRestorePoint = await transaction.get(target.collection("restoreReconciliationControls").doc("restore-point"));
    if (stable(currentRestorePoint.data()) !== stable(restoreSnapshot.data())) return fail("offline_restore_final_drift");
  });
  await assertNoPendingDeletionOperations(source, "offline_restore_source_pending_deletion");
  await assertNoPendingDeletionOperations(target, "offline_restore_target_pending_deletion");
  const [finalMarkers, finalFreeze, finalRestorePoint, finalTargetFingerprint] = await Promise.all([
    source.collection(COLLECTIONS.deletedIdentities).orderBy(FieldPath.documentId()).get(),
    source.collection("restoreReconciliationControls").doc("source-freeze").get(),
    target.collection("restoreReconciliationControls").doc("restore-point").get(),
    fingerprintDatabase(target),
  ]);
  const finalLedgerFingerprint = sha256(finalMarkers.docs.map(readMarker).map((marker) => stable(marker)).join("\n"));
  if (finalLedgerFingerprint !== freeze.ledgerFingerprint || stable(finalFreeze.data()) !== stable(freezeSnapshot.data())
    || stable(finalRestorePoint.data()) !== stable(restoreSnapshot.data()) || finalTargetFingerprint !== targetAfter) return fail("offline_restore_final_drift");
  const finalAdmissionAt = Date.now();
  if (cutoffAt > finalAdmissionAt) return fail("offline_restore_future_cutoff");
  if (finalAdmissionAt < restoreAt || finalAdmissionAt - restoreAt >= ACCOUNT_DELETION_TOMBSTONE_RETENTION_MS) return fail("offline_restore_outside_retention");
  const sum = (key: keyof AccountErasureCounts): number => counts.reduce((total, item) => total + item[key], 0);
  const erased = Object.freeze({
    userTreeDocuments: sum("userTreeDocuments"), accountTreeDocuments: sum("accountTreeDocuments"), identityMappings: sum("identityMappings"), recoveryCodeIndex: sum("recoveryCodeIndex"),
    recoveryOperations: sum("recoveryOperations"), recoveryOperationResults: sum("recoveryOperationResults"), sessionRevocations: sum("sessionRevocations"),
    exportAudits: sum("exportAudits"), exportRateLimits: sum("exportRateLimits"), purchaseTransactions: sum("purchaseTransactions"),
    contentReportsUnlinked: sum("contentReportsUnlinked"), privacyRequestsUnlinked: sum("privacyRequestsUnlinked"),
  });
  return Object.freeze({ scope: "offline_emulator_only_not_deployable", status: "reconciled", sourceLedgerFingerprint: sourceFingerprint, targetBeforeFingerprint: targetBefore, targetAfterFingerprint: targetAfter, markerCount: activeMarkers.length, affectedAccountCount: counts.filter((count) => count.identityMappings > 0 || count.userTreeDocuments > 0 || count.accountTreeDocuments > 0).length, erased });
}
