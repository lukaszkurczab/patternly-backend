import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { getAuth } from "firebase-admin/auth";
import { Timestamp } from "firebase-admin/firestore";
import { COLLECTIONS, identityDocumentId } from "../src/infrastructure/firestore/paths.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { attemptState } from "./progressFixtures.js";
import {
  clearFirestore,
  createAuthUser,
  createEmulatorContext,
  createRegisteredAuthUser,
  TEST_APP_CHECK_TOKEN,
  type EmulatorContext,
} from "./support.js";

const projectId = process.env.FIREBASE_PROJECT_ID ?? "";
if (projectId !== "demo-patternly-r01-id") throw new Error("deleted_identity_r01_demo_project_required");
const portBase = process.env.PATTERNLY_ISOLATED_TEST_PORT_BASE;
const authPort = portBase ? Number(portBase) : 19119;
const firestorePort = portBase ? authPort + 1 : 18119;
if (!Number.isSafeInteger(authPort) || authPort < 10000 || authPort > 65532
  || process.env.FIREBASE_AUTH_EMULATOR_HOST !== `127.0.0.1:${authPort}`) throw new Error("deleted_identity_r01_auth_emulator_required");
if (process.env.FIRESTORE_EMULATOR_HOST !== `127.0.0.1:${firestorePort}`) throw new Error("deleted_identity_r01_firestore_emulator_required");

let context: EmulatorContext;
const createdUids = new Set<string>();

test.before(async () => {
  context = createEmulatorContext({ projectId });
  await clearFirestore();
});

test.after(async () => {
  for (const uid of createdUids) await getAuth().deleteUser(uid).catch(() => undefined);
  await context?.close();
});

test("deleted Firebase UID is rejected while the same email can immediately register under a new UID", async () => {
  const email = `deleted-identity-r01-${randomUUID()}@example.test`;
  const original = await createRegisteredAuthUser(context, email);
  createdUids.add(original.localId);

  const trackId = "coding-interview-dsa-problem-solving";
  const targetId = "deleted-identity-r01-progress";
  const state = attemptState(targetId, trackId);
  const mutation = {
    mutationId: randomUUID(),
    kind: "item" as const,
    recordType: "training_attempt" as const,
    trackId,
    targetId,
    expectedVersion: null,
    state,
    fingerprint: createMergeRecordFingerprint({ recordId: targetId, recordType: "training_attempt", state, trackId }),
  };
  const progress = await context.app.inject({
    method: "POST",
    url: "/v1/progress/sync",
    headers: { authorization: `Bearer ${original.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN },
    payload: {
      canonicalVersion: "canonical-json-v1",
      expectedAccountRevision: 0,
      deviceId: randomUUID(),
      sessionId: "deleted-identity-r01-session",
      batchId: "deleted-identity-r01-batch",
      highWatermark: 1,
      mutations: [mutation],
    },
  });
  assert.equal(progress.statusCode, 200, "old account has a real backend progress record before deletion");

  const originalUserRef = context.db.collection(COLLECTIONS.users).doc(original.userId);
  await originalUserRef.collection("entitlements").doc("premium").set({
    entitlement: "premium",
    status: "active",
    source: "revenuecat",
    expiresAt: null,
    updatedAt: Timestamp.now(),
  });
  await context.db.collection("revenueCatTransactions").doc(`r01-${randomUUID()}`).set({ ownerAccountId: original.userId, status: "bound" });

  const issueRecovery = await context.app.inject({
    method: "POST",
    url: "/v1/account/recovery-codes",
    headers: { authorization: `Bearer ${original.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN },
    payload: { operationId: randomUUID() },
  });
  assert.equal(issueRecovery.statusCode, 200);
  const oldRecoveryCode = issueRecovery.json().codes?.[0];
  assert.equal(typeof oldRecoveryCode, "string");
  const oldRecoveryCodeHash = createHash("sha256").update(oldRecoveryCode, "utf8").digest("hex");
  const recoveryIndexRef = context.db.collection(COLLECTIONS.recoveryCodeIndex).doc(oldRecoveryCodeHash);
  const issueAcknowledgement = await context.app.inject({
    method: "POST",
    url: "/v1/account/recovery-codes/issue/saved-ack",
    headers: { authorization: `Bearer ${original.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN },
    payload: { operationId: issueRecovery.json().operationId },
  });
  assert.equal(issueAcknowledgement.statusCode, 200);
  const recoveryIndexBeforeDeletion = (await recoveryIndexRef.get()).data();
  assert.ok(recoveryIndexBeforeDeletion);
  const recoverySetBeforeDeletion = (await originalUserRef.collection("security").doc("recoveryCodes").get()).data();
  assert.ok(recoverySetBeforeDeletion);
  const preDeleteUser = (await originalUserRef.get()).data();
  assert.ok(preDeleteUser);
  const oldIdentityRef = context.db.collection(COLLECTIONS.identityMappings).doc(identityDocumentId("firebase", original.localId));
  const preDeleteIdentity = (await oldIdentityRef.get()).data();
  assert.ok(preDeleteIdentity);

  const deleteOperationId = randomUUID();
  const deletion = await context.app.inject({
    method: "POST",
    url: "/v1/account/deletion",
    headers: { authorization: `Bearer ${original.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN },
    payload: { operationId: deleteOperationId, operationSecret: randomBytes(32).toString("hex") },
  });
  assert.equal(deletion.statusCode, 200);
  assert.equal(deletion.json().status, "deleted");
  assert.equal((await originalUserRef.collection("progress").get()).size, 0, "deletion removes old account progress");
  assert.equal((await originalUserRef.collection("entitlements").get()).size, 0, "deletion removes old backend Premium entitlements");
  assert.equal((await context.db.collection("revenueCatTransactions").where("ownerAccountId", "==", original.userId).get()).size, 0, "deletion removes old account purchase mappings");

  await assert.rejects(getAuth().verifyIdToken(original.idToken, true));
  const oldTokenRequest = await context.app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${original.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN },
  });
  assert.equal(oldTokenRequest.statusCode, 401, "the backend verifier rejects the same old token");

  const recoveryReplay = await context.app.inject({
    method: "POST",
    url: "/v1/public/recovery-codes/consume",
    headers: { "x-firebase-appcheck": TEST_APP_CHECK_TOKEN },
    payload: { operationId: randomUUID(), code: oldRecoveryCode },
  });
  assert.equal(recoveryReplay.statusCode, 200);
  assert.equal(recoveryReplay.json().status, "expired_or_invalid", "a deleted account's old recovery code cannot mint a replacement session");
  assert.equal((await context.db.collection(COLLECTIONS.users).doc(original.userId).get()).exists, false);

  // A recovery snapshot fixture is restored while the current deletion marker is preserved.
  // This tests the backend's tombstone guard; it is not a Firestore PITR/restore drill.
  await originalUserRef.set(preDeleteUser);
  await originalUserRef.collection("security").doc("recoveryCodes").set(recoverySetBeforeDeletion);
  await oldIdentityRef.set(preDeleteIdentity);
  await recoveryIndexRef.set(recoveryIndexBeforeDeletion);
  const customTokensBeforeRestoredRecovery = context.customTokenSubjects.length;
  const restoredRecoveryReplay = await context.app.inject({
    method: "POST",
    url: "/v1/public/recovery-codes/consume",
    headers: { "x-firebase-appcheck": TEST_APP_CHECK_TOKEN },
    payload: { operationId: randomUUID(), code: oldRecoveryCode },
  });
  assert.equal(restoredRecoveryReplay.statusCode, 200);
  assert.equal(restoredRecoveryReplay.json().status, "expired_or_invalid", "an active tombstone blocks a restored old recovery snapshot");
  assert.equal(context.customTokenSubjects.length, customTokensBeforeRestoredRecovery, "restored recovery does not mint a custom Firebase token");
  await context.db.recursiveDelete(originalUserRef);
  await oldIdentityRef.delete();
  await recoveryIndexRef.delete();

  const replacementAuth = await createAuthUser(email);
  createdUids.add(replacementAuth.localId);
  assert.notEqual(replacementAuth.localId, original.localId, "Firebase creates a new UID after deletion for the same email");
  const replacement = await createRegisteredAuthUser(context, email);
  assert.equal(replacement.localId, replacementAuth.localId);
  assert.notEqual(replacement.userId, original.userId, "registration creates a distinct Patternly account");

  assert.equal((await context.db.collection(COLLECTIONS.users).doc(replacement.userId).collection("progress").get()).size, 0);
  assert.deepEqual(await context.stores.entitlements.read(replacement.userId), []);
  assert.equal((await context.db.collection("revenueCatTransactions").where("ownerAccountId", "==", replacement.userId).get()).size, 0);
  assert.equal((await context.db.collection(COLLECTIONS.identityMappings).where("subject", "==", original.localId).get()).size, 0);
});
