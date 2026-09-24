import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp, type Firestore, type Transaction } from "firebase-admin/firestore";

import { buildApplication } from "../src/api/app.js";
import { FirestoreProgressStore } from "../src/modules/progress/store.js";
import { adoptionTransferRecordKey, createAdoptionSnapshotSeal, createAdoptionTransferChunkFingerprint } from "../src/modules/users/adoptionTransfer.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { createFirebaseTokenVerifier } from "../src/infrastructure/firebase/verifier.js";
import { progressDocumentId } from "../src/infrastructure/firestore/paths.js";
import { testEnvironment } from "./support.js";
import { TEST_APP_CHECK_TOKEN, clearFirestore, createEmulatorContext, createRegisteredAuthUser, firestore, setAuthCustomClaimsAndSignIn, type EmulatorContext } from "./support.js";

const deviceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const guestUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const trackId = "coding-interview-dsa-problem-solving";
const canonicalVersion = "canonical-json-v1" as const;
let context: EmulatorContext;

function activeRecord(recordId: string, recordTrackId: string, value = recordId): Readonly<{ recordType: "active_track"; recordId: string; trackId: string; state: Readonly<Record<string, unknown>>; version: number; fingerprint: string }> {
  const state = { trackId: recordTrackId, value };
  return { recordType: "active_track", recordId, trackId: recordTrackId, state, version: 0, fingerprint: createMergeRecordFingerprint({ recordType: "active_track", recordId, trackId: recordTrackId, state }) };
}

async function prepareConfirmedTransfer(auth: Awaited<ReturnType<typeof createRegisteredAuthUser>>, sessionId: string, records: ReturnType<typeof activeRecord>[]) {
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const recordKeys = records.map(adoptionTransferRecordKey);
  const chunkBase = { chunkId: "chunk-0", index: 0, recordKeys, bytes: 512 };
  const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
  const start = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { canonicalVersion, sessionId, idempotencyKey: sessionId, guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } });
  assert.equal(start.statusCode, 200, JSON.stringify(start.json()));
  if (records.length > 0) {
    const upload = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/upload`, headers, payload: { canonicalVersion, deviceId, chunk, records } });
    assert.equal(upload.statusCode, 200, JSON.stringify(upload.json()));
  }
  const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records, chunks: records.length > 0 ? [chunk] : [] });
  const seal = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/seal`, headers, payload: { canonicalVersion, deviceId, snapshotFingerprint, recordCount: records.length, chunkCount: records.length > 0 ? 1 : 0 } });
  assert.equal(seal.statusCode, 200, JSON.stringify(seal.json()));
  const preview = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/preview`, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.json()));
  const confirmation = { canonicalVersion, deviceId, operationId: preview.json().preview.operationId as string, previewFingerprint: preview.json().preview.fingerprint as string, resolutions: [], groupChoices: [] };
  const confirm = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/confirm`, headers, payload: confirmation });
  assert.equal(confirm.statusCode, 200, JSON.stringify(confirm.json()));
  return { headers, confirm, preview, chunk };
}

test.before(async () => {
  context = createEmulatorContext();
  await clearFirestore();
});

test.afterEach(async () => {
  await clearFirestore();
});

test.after(async () => {
  await context.close();
});

test("canonical transfer persists chunks, applies one generation, and retries safely", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const accountId = (await context.app.inject({ method: "GET", url: "/v1/me", headers })).json().user.id as string;
  const records = Array.from({ length: 201 }, (_, index) => activeRecord(`record-${index}`, `track-${index}`));
  const sessionId = "canonical-transfer-test";
  const { confirm, preview } = await prepareConfirmedTransfer(auth, sessionId, records);
  assert.equal(preview.json().plan.uploadRecordIds.length, records.length);
  const apply = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: confirm.json().decisionFingerprint } });
  assert.equal(apply.statusCode, 200, JSON.stringify(apply.json()));
  const retry = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: confirm.json().decisionFingerprint } });
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.json()));
  const status = await context.app.inject({ method: "GET", url: `/v1/account-data/adoption/transfer/${sessionId}/status?deviceId=${deviceId}`, headers });
  assert.equal(status.statusCode, 200, JSON.stringify(status.json()));
  assert.equal(status.json().state, "complete");
  assert.equal(status.json().applyCursor, records.length);
  assert.equal(Object.hasOwn(status.json(), "protocolVersion"), false);
  assert.equal(Object.hasOwn(status.json(), "contentIdentitySchema"), false);

  const progress = await context.app.inject({ method: "GET", url: "/v1/progress", headers });
  assert.equal(progress.statusCode, 200);
  assert.equal(progress.json().records.length, records.length);
  const operation = (await firestore().collection("accounts").doc(accountId).collection("adoptionTransfers").doc(sessionId).get()).data();
  assert.ok(operation);
  assert.equal(Object.hasOwn(operation!, "protocolVersion"), false);
  assert.equal(Object.hasOwn(operation!, "contentIdentitySchema"), false);
  assert.equal((await firestore().collection("users").doc(accountId).collection("progressGenerations").doc("1").collection("records").get()).size, records.length);
});

test("apply fences reservation, every chunk, and empty-transfer promotion against authorization rotation", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };

  const reserveSession = "apply-rotation-reservation";
  const reserve = await prepareConfirmedTransfer(auth, reserveSession, [activeRecord("reserve-record", "reserve-track")]);
  const reserveApp = buildTransferTransactionRotationApp(auth.userId, 1);
  const reserveResult = await reserveApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${reserveSession}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: reserve.confirm.json().decisionFingerprint } });
  assert.equal(reserveResult.statusCode, 409, JSON.stringify(reserveResult.json()));
  assert.deepEqual(reserveResult.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await transferRefFor(auth.userId, reserveSession).get()).data()?.state, "preview_ready");
  assert.equal((await firestore().collection("users").doc(auth.userId).collection("progressGenerations").doc("1").get()).exists, false);
  await reserveApp.close();

  await firestore().collection("users").doc(auth.userId).update({ authorizationGeneration: 1, authorizationState: "active" });
  const chunkSession = "apply-rotation-between-chunks";
  const chunkRecords = Array.from({ length: 201 }, (_, index) => activeRecord(`chunk-record-${index}`, `chunk-track-${index}`));
  const chunk = await prepareConfirmedTransfer(auth, chunkSession, chunkRecords);
  const chunkApp = buildTransferTransactionRotationApp(auth.userId, 3);
  const chunkResult = await chunkApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${chunkSession}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: chunk.confirm.json().decisionFingerprint } });
  assert.equal(chunkResult.statusCode, 409, JSON.stringify(chunkResult.json()));
  assert.deepEqual(chunkResult.json(), { error: { code: "authorization_generation_conflict" } });
  const chunkOperation = (await transferRefFor(auth.userId, chunkSession).get()).data();
  assert.equal(chunkOperation?.state, "applying");
  assert.equal(chunkOperation?.applyCursor, 200);
  assert.equal((await firestore().collection("users").doc(auth.userId).collection("progressGenerations").doc(String(chunkOperation?.targetGeneration)).collection("records").get()).size, 200);
  await chunkApp.close();

  await firestore().collection("users").doc(auth.userId).collection("syncMetadata").doc("account").set({ adoptionPromotionLeaseExpiresAt: Timestamp.fromMillis(Date.now() - 1) }, { merge: true });
  await firestore().collection("users").doc(auth.userId).update({ authorizationGeneration: 1, authorizationState: "active" });
  const emptySession = "apply-rotation-final-promotion";
  const empty = await prepareConfirmedTransfer(auth, emptySession, []);
  const finalApp = buildTransferTransactionRotationApp(auth.userId, 2);
  const finalResult = await finalApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${emptySession}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: empty.confirm.json().decisionFingerprint } });
  assert.equal(finalResult.statusCode, 409, JSON.stringify(finalResult.json()));
  assert.deepEqual(finalResult.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await transferRefFor(auth.userId, emptySession).get()).data()?.state, "applying");
  assert.equal((await firestore().collection("users").doc(auth.userId).collection("syncMetadata").doc("account").get()).data()?.generation ?? 0, 0);
  await finalApp.close();
});

test("apply resumes an expired same-session lease only while the pinned progress revision still matches", async () => {
  const auth = await createRegisteredAuthUser(context);
  const sessionId = "apply-expired-lease-resume";
  const { headers, confirm } = await prepareConfirmedTransfer(auth, sessionId, [activeRecord("expired-lease-record", "expired-lease-track")]);
  const metadataRef = firestore().collection("users").doc(auth.userId).collection("syncMetadata").doc("account");
  const operationRef = transferRefFor(auth.userId, sessionId);
  const targetRef = firestore().collection("users").doc(auth.userId).collection("progressGenerations").doc("1");
  await firestore().runTransaction(async (transaction) => {
    const operation = await transaction.get(operationRef);
    const metadata = await transaction.get(metadataRef);
    const operationData = operation.data()!;
    transaction.update(operationRef, { state: "applying", targetGeneration: 1, applyCursor: 0, applyTotal: 1, applyAccountRevision: 0, applySourceGeneration: 0, applySourceRevision: 0 });
    transaction.set(targetRef, { userId: auth.userId, generation: 1, sourceSessionId: sessionId, state: "building", createdAt: operationData.createdAt, expiresAt: operationData.expiresAt });
    transaction.set(metadataRef, { ...metadata.data(), adoptionPromotionSessionId: sessionId, adoptionPromotionTargetGeneration: 1, adoptionPromotionSourceGeneration: 0, adoptionPromotionSourceRevision: 0, adoptionPromotionLeaseExpiresAt: Timestamp.fromMillis(Date.now() - 1) }, { merge: true });
  });
  const apply = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: confirm.json().decisionFingerprint } });
  assert.equal(apply.statusCode, 200, JSON.stringify(apply.json()));
  assert.equal(apply.json().state, "complete");
  assert.equal(apply.json().applyCursor, 1);
});

test("sync loses during an active transfer lease and wins after expiry without allowing stale promotion", async () => {
  const auth = await createRegisteredAuthUser(context);
  const sessionId = "apply-sync-versus-lease";
  const { headers, confirm } = await prepareConfirmedTransfer(auth, sessionId, [activeRecord("lease-guest-record", "lease-guest-track")]);
  const userRef = firestore().collection("users").doc(auth.userId);
  const metadataRef = userRef.collection("syncMetadata").doc("account");
  const operationRef = transferRefFor(auth.userId, sessionId);
  const operation = (await operationRef.get()).data()!;
  const targetGeneration = Number(operation.targetGeneration);
  const targetGenerationRef = userRef.collection("progressGenerations").doc(String(targetGeneration));
  await firestore().runTransaction(async (transaction) => {
    const currentOperation = await transaction.get(operationRef);
    const currentMetadata = await transaction.get(metadataRef);
    const data = currentOperation.data()!;
    transaction.update(operationRef, { state: "applying", targetGeneration, applyCursor: 0, applyTotal: 1, applyAccountRevision: 0, applySourceGeneration: 0, applySourceRevision: 0 });
    transaction.set(targetGenerationRef, { userId: auth.userId, generation: targetGeneration, sourceSessionId: sessionId, state: "building", createdAt: data.createdAt, expiresAt: data.expiresAt });
    transaction.set(metadataRef, { ...currentMetadata.data(), adoptionPromotionSessionId: sessionId, adoptionPromotionTargetGeneration: targetGeneration, adoptionPromotionSourceGeneration: 0, adoptionPromotionSourceRevision: 0, adoptionPromotionLeaseExpiresAt: Timestamp.fromMillis(Date.now() + 60_000) }, { merge: true });
  });
  const state = { value: "from-sync" };
  const mutation = { mutationId: "lease-race-mutation-0001", kind: "node" as const, recordType: "active_track" as const, trackId: "lease-sync-track", targetId: "lease-sync-record", expectedVersion: null, fingerprint: createMergeRecordFingerprint({ recordType: "active_track", recordId: "lease-sync-record", trackId: "lease-sync-track", state }), state };
  await assert.rejects(context.stores.progress.applyBatch(auth.userId, 1, deviceId, 0, [mutation], { sessionId: "lease-sync-session", batchId: "lease-sync-batch", highWatermark: 1 }), /progress_generation_conflict/u);

  await metadataRef.set({ adoptionPromotionLeaseExpiresAt: Timestamp.fromMillis(Date.now() - 1) }, { merge: true });
  const sync = await context.stores.progress.applyBatch(auth.userId, 1, deviceId, 0, [mutation], { sessionId: "lease-sync-session", batchId: "lease-sync-batch", highWatermark: 1 });
  assert.equal(sync.applied.length, 1);
  const apply = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: confirm.json().decisionFingerprint } });
  assert.equal(apply.statusCode, 409, JSON.stringify(apply.json()));
  assert.deepEqual(apply.json(), { error: { code: "adoption_transfer_preview_stale" } });
  assert.equal((await operationRef.get()).data()?.state, "applying");
  assert.equal((await metadataRef.get()).data()?.generation ?? 0, 0);
});

test("transfer status rejects a stale bearer after authorization rotation", async () => {
  const auth = await createRegisteredAuthUser(context);
  const sessionId = "stale-transfer-status";
  await prepareConfirmedTransfer(auth, sessionId, [activeRecord("status-record", "status-track")]);
  await firestore().collection("users").doc(auth.userId).update({ authorizationGeneration: 2 });
  const status = await context.app.inject({ method: "GET", url: `/v1/account-data/adoption/transfer/${sessionId}/status?deviceId=${deviceId}`, headers: { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  assert.equal(status.statusCode, 401, JSON.stringify(status.json()));
  assert.deepEqual(status.json(), { error: { code: "authorization_generation_stale" } });
});

test("apply splits target transactions by both document count and serialized write bytes", async () => {
  const auth = await createRegisteredAuthUser(context);
  const userRef = firestore().collection("users").doc(auth.userId);
  const storedAt = Timestamp.now();
  const seedValue = "x".repeat(40_000);
  for (let offset = 0; offset < 190; offset += 50) {
    const batch = firestore().batch();
    for (let index = offset; index < Math.min(offset + 50, 190); index += 1) {
      const record = activeRecord(`large-remote-${index}`, `large-track-${index}`, seedValue);
      batch.set(userRef.collection("progress").doc(progressDocumentId({ kind: "node", recordType: "active_track", targetId: record.recordId, trackId: record.trackId })), { kind: "node", recordType: record.recordType, trackId: record.trackId, targetId: record.recordId, version: 0, fingerprint: record.fingerprint, state: record.state, lastMutationId: `seed_large_${String(index).padStart(4, "0")}_mutation`, updatedAt: storedAt });
    }
    await batch.commit();
  }
  const sessionId = "apply-byte-bounded-chunks";
  const { headers, confirm } = await prepareConfirmedTransfer(auth, sessionId, [activeRecord("byte-bound-guest", "byte-bound-guest-track")]);
  const chunkStats: Array<{ count: number; bytes: number }> = [];
  const measuredApp = buildTransferWriteMeasuringApp(auth.userId, chunkStats);
  const apply = await measuredApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: confirm.json().decisionFingerprint } });
  assert.equal(apply.statusCode, 200, JSON.stringify(apply.json()));
  assert.equal(apply.json().applyCursor, 191);
  assert.equal(chunkStats.length, 2);
  assert.ok(chunkStats.every((chunk) => chunk.count > 0 && chunk.count <= 200 && chunk.bytes <= 6 * 1024 * 1024), JSON.stringify(chunkStats));
  assert.equal(chunkStats.reduce((sum, chunk) => sum + chunk.count, 0), 191);
  await measuredApp.close();
});

test("concurrent apply requests leave one complete generation and can be safely replayed", async () => {
  const auth = await createRegisteredAuthUser(context);
  const sessionId = "apply-concurrent-retry";
  const records = Array.from({ length: 201 }, (_, index) => activeRecord(`concurrent-record-${index}`, `concurrent-track-${index}`));
  const { headers, confirm } = await prepareConfirmedTransfer(auth, sessionId, records);
  const payload = { canonicalVersion, deviceId, decisionFingerprint: confirm.json().decisionFingerprint };
  const results = await Promise.all([
    context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload }),
    context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload }),
  ]);
  assert.ok(results.some((result) => result.statusCode === 200), JSON.stringify(results.map((result) => ({ statusCode: result.statusCode, body: result.json() }))));
  assert.ok(results.every((result) => result.statusCode === 200 || (result.statusCode === 409 && result.json().error?.code === "adoption_transfer_apply_cursor_conflict")), JSON.stringify(results.map((result) => ({ statusCode: result.statusCode, body: result.json() }))));
  const replay = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload });
  assert.equal(replay.statusCode, 200, JSON.stringify(replay.json()));
  assert.equal(replay.json().state, "complete");
  const operation = (await transferRefFor(auth.userId, sessionId).get()).data();
  assert.equal((await firestore().collection("users").doc(auth.userId).collection("progressGenerations").doc(String(operation?.targetGeneration)).collection("records").get()).size, records.length);
});

test("transfer decision lock and child rows recheck account authorization generation", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const sessionId = "rotation-transfer-confirm";
  const records = [activeRecord("confirm-rotation-record", "confirm-rotation-track")];
  const chunkBase = { chunkId: "chunk-0", index: 0, recordKeys: records.map(adoptionTransferRecordKey), bytes: 64 };
  const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
  const start = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { canonicalVersion, sessionId, idempotencyKey: sessionId, guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } });
  assert.equal(start.statusCode, 200, JSON.stringify(start.json()));
  const upload = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/upload`, headers, payload: { canonicalVersion, deviceId, chunk, records } });
  assert.equal(upload.statusCode, 200, JSON.stringify(upload.json()));
  const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records, chunks: [chunk] });
  const seal = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/seal`, headers, payload: { canonicalVersion, deviceId, snapshotFingerprint, recordCount: records.length, chunkCount: 1 } });
  assert.equal(seal.statusCode, 200, JSON.stringify(seal.json()));
  const preview = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/preview`, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.json()));
  const confirmation = { canonicalVersion, deviceId, operationId: preview.json().preview.operationId as string, previewFingerprint: preview.json().preview.fingerprint as string, resolutions: [], groupChoices: [] };
  const userRef = firestore().collection("users").doc(auth.userId);
  let transactionCount = 0;
  const racedDb = new Proxy(firestore(), {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "runTransaction" && typeof value === "function") {
        return async (...args: unknown[]) => {
          transactionCount += 1;
          if (transactionCount === 2) await userRef.update({ authorizationGeneration: 2 });
          return (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Firestore;
  const progress = new FirestoreProgressStore(racedDb);
  const app = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, progress },
  });
  const confirm = await app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/confirm`, headers, payload: confirmation });
  assert.equal(transactionCount, 2);
  assert.equal(confirm.statusCode, 409, JSON.stringify(confirm.json()));
  assert.deepEqual(confirm.json(), { error: { code: "authorization_generation_conflict" } });
  const transferRef = transferRefFor(auth.userId, sessionId);
  assert.equal(typeof (await transferRef.get()).data()?.decisionFingerprint, "string");
  assert.equal((await transferRef.collection("decisions").get()).size, 0);

  const refreshed = await setAuthCustomClaimsAndSignIn(auth, { authorizationGeneration: 2 });
  const freshHeaders = { ...headers, authorization: `Bearer ${refreshed.idToken}` };
  const resumed = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/confirm`, headers: freshHeaders, payload: confirmation });
  assert.equal(resumed.statusCode, 200, JSON.stringify(resumed.json()));
  assert.equal(typeof resumed.json().decisionFingerprint, "string");
  assert.equal((await transferRef.collection("decisions").get()).size, 1);

  const alternate = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/confirm`, headers: freshHeaders, payload: { ...confirmation, decisionFingerprint: "a".repeat(64) } });
  assert.equal(alternate.statusCode, 409, JSON.stringify(alternate.json()));

  const rejected = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/confirm`, headers, payload: confirmation });
  assert.equal(rejected.statusCode, 401, JSON.stringify(rejected.json()));
  assert.deepEqual(rejected.json(), { error: { code: "authorization_generation_stale" } });
  await app.close();
});

test("transfer decision chunks stop on rotation and a fresh generation resumes the same decision", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const accountRef = firestore().collection("users").doc(auth.userId);
  const records = Array.from({ length: 201 }, (_, index) => {
    const recordId = `chunk-conflict-${index}`;
    const state = { mastery: "guest" };
    return { recordType: "training_attempt" as const, recordId, trackId, state, version: 0, fingerprint: createMergeRecordFingerprint({ recordId, recordType: "training_attempt", trackId, state }) };
  });
  const storedAt = Timestamp.now();
  const existing = records.map((record) => {
    const state = { mastery: "account" };
    const accountRecord = { ...record, state, fingerprint: createMergeRecordFingerprint({ recordId: record.recordId, recordType: record.recordType, state, trackId: record.trackId }) };
    return { ...accountRecord, targetId: record.recordId, refId: progressDocumentId({ kind: "item", recordType: "training_attempt", targetId: record.recordId, trackId: record.trackId }) };
  });
  const seed = firestore().batch();
  for (const record of existing) {
    const { refId, ...value } = record;
    seed.set(accountRef.collection("progress").doc(refId), { ...value, kind: "item", version: 0, lastMutationId: `seed-${value.recordId}`, updatedAt: storedAt });
  }
  await seed.commit();

  const sessionId = "rotation-between-confirm-chunks";
  const chunkBase = { chunkId: "chunk-0", index: 0, recordKeys: records.map(adoptionTransferRecordKey), bytes: 64 };
  const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
  const start = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { canonicalVersion, sessionId, idempotencyKey: sessionId, guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } });
  assert.equal(start.statusCode, 200, JSON.stringify(start.json()));
  const upload = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/upload`, headers, payload: { canonicalVersion, deviceId, chunk, records } });
  assert.equal(upload.statusCode, 200, JSON.stringify(upload.json()));
  const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records, chunks: [chunk] });
  const seal = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/seal`, headers, payload: { canonicalVersion, deviceId, snapshotFingerprint, recordCount: records.length, chunkCount: 1 } });
  assert.equal(seal.statusCode, 200, JSON.stringify(seal.json()));
  const preview = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/preview`, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.json()));
  assert.equal(preview.json().preview.conflicts.length, records.length);
  const confirmation = { canonicalVersion, deviceId, operationId: preview.json().preview.operationId as string, previewFingerprint: preview.json().preview.fingerprint as string, resolutions: preview.json().preview.conflicts.map((conflict: { conflictId: string }) => ({ conflictId: conflict.conflictId, resolution: "keep_guest" as const })), groupChoices: [] };
  const userRef = firestore().collection("users").doc(auth.userId);
  let transactionCount = 0;
  const racedDb = new Proxy(firestore(), {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "runTransaction" && typeof value === "function") {
        return async (...args: unknown[]) => {
          transactionCount += 1;
          if (transactionCount === 3) await userRef.update({ authorizationGeneration: 2 });
          return (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Firestore;
  const progress = new FirestoreProgressStore(racedDb);
  const app = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, progress },
  });
  const interrupted = await app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/confirm`, headers, payload: confirmation });
  assert.equal(transactionCount, 3);
  assert.equal(interrupted.statusCode, 409, JSON.stringify(interrupted.json()));
  assert.deepEqual(interrupted.json(), { error: { code: "authorization_generation_conflict" } });
  const transferRef = transferRefFor(auth.userId, sessionId);
  assert.equal((await transferRef.collection("decisions").get()).size, 200);
  assert.equal(Object.keys((await transferRef.get()).data()?.decisionChunkFingerprints ?? {}).length, 1);

  const refreshed = await setAuthCustomClaimsAndSignIn(auth, { authorizationGeneration: 2 });
  const freshHeaders = { ...headers, authorization: `Bearer ${refreshed.idToken}` };
  const resumed = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/confirm`, headers: freshHeaders, payload: confirmation });
  assert.equal(resumed.statusCode, 200, JSON.stringify(resumed.json()));
  assert.equal((await transferRef.collection("decisions").get()).size, 202);
  assert.equal(Object.keys((await transferRef.get()).data()?.decisionChunkFingerprints ?? {}).length, 2);
  await app.close();
});

test("the retired transfer route and retired query selector are unavailable", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const oldRoute = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/start", headers, payload: {} });
  assert.equal(oldRoute.statusCode, 404);
  const oldQuery = await context.app.inject({ method: "GET", url: "/v1/progress?protocolVersion=2", headers });
  assert.equal(oldQuery.statusCode, 400);
  const accountId = (await context.app.inject({ method: "GET", url: "/v1/me", headers })).json().user.id as string;
  const state = { result: "correct" };
  await firestore().collection("users").doc(accountId).collection("progress").doc("retired").set({
    kind: "item",
    recordType: "training_attempt",
    trackId,
    targetId: "retired",
    version: 0,
    fingerprint: createMergeRecordFingerprint({ recordId: "retired", recordType: "training_attempt", trackId, state }),
    state,
    lastMutationId: "retired-mutation",
    updatedAt: new Date().toISOString(),
    protocolVersion: 3,
    contentIdentitySchema: "patternly:content-identity:v2",
  });
  const legacyRead = await context.app.inject({ method: "GET", url: "/v1/progress", headers });
  assert.equal(legacyRead.statusCode, 409);
  assert.deepEqual(legacyRead.json(), { error: { code: "content_identity_schema_conflict" } });
});

test("transfer start, upload, and seal fence account rotation after request authentication", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const userRef = firestore().collection("users").doc(auth.userId);
  const startPayload = { canonicalVersion, sessionId: "rotation-transfer-start", idempotencyKey: "rotation-transfer-start", guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId };
  const startApp = buildTransferRotationApp(auth.userId, "startAdoptionTransfer", "authorizationGeneration");
  const start = await startApp.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: startPayload });
  assert.equal(start.statusCode, 409, JSON.stringify(start.json()));
  assert.deepEqual(start.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await firestore().collection("accounts").doc(auth.userId).get()).exists, false);
  assert.equal((await firestore().collection("users").doc(auth.userId).collection("syncMetadata").doc("account").get()).exists, false);
  assert.equal((await firestore().collection("accounts").doc(auth.userId).collection("adoptionTransfers").doc(startPayload.sessionId).get()).exists, false);
  assert.equal((await firestore().collection("accounts").doc(auth.userId).collection("adoptionTransferIdempotency").get()).size, 0);
  await startApp.close();

  await userRef.update({ authorizationGeneration: 1, authorizationState: "active" });
  const uploadSessionId = "rotation-transfer-upload";
  const initialStart = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { ...startPayload, sessionId: uploadSessionId, idempotencyKey: uploadSessionId } });
  assert.equal(initialStart.statusCode, 200, JSON.stringify(initialStart.json()));
  const uploadRecords = [activeRecord("rotation-upload-record", "rotation-track")];
  const uploadChunkBase = { chunkId: "chunk-0", index: 0, recordKeys: uploadRecords.map(adoptionTransferRecordKey), bytes: 64 };
  const uploadChunk = { ...uploadChunkBase, fingerprint: createAdoptionTransferChunkFingerprint(uploadChunkBase) };
  const uploadApp = buildTransferRotationApp(auth.userId, "uploadAdoptionTransfer", "authorizationGeneration");
  const upload = await uploadApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${uploadSessionId}/upload`, headers, payload: { canonicalVersion, deviceId, chunk: uploadChunk, records: uploadRecords } });
  assert.equal(upload.statusCode, 409, JSON.stringify(upload.json()));
  assert.deepEqual(upload.json(), { error: { code: "authorization_generation_conflict" } });
  const transferRef = firestore().collection("accounts").doc(auth.userId).collection("adoptionTransfers").doc(uploadSessionId);
  assert.equal((await transferRef.collection("chunks").get()).size, 0);
  assert.equal((await transferRef.collection("records").get()).size, 0);
  assert.equal((await transferRef.get()).data()?.recordCount, 0);
  assert.equal((await transferRef.get()).data()?.chunkCount, 0);
  await uploadApp.close();

  await userRef.update({ authorizationGeneration: 1, authorizationState: "active" });
  const sealSessionId = "rotation-transfer-seal";
  const sealStart = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { ...startPayload, sessionId: sealSessionId, idempotencyKey: sealSessionId } });
  assert.equal(sealStart.statusCode, 200, JSON.stringify(sealStart.json()));
  const sealRecords = [activeRecord("rotation-seal-record", "rotation-seal-track")];
  const sealChunkBase = { chunkId: "chunk-0", index: 0, recordKeys: sealRecords.map(adoptionTransferRecordKey), bytes: 64 };
  const sealChunk = { ...sealChunkBase, fingerprint: createAdoptionTransferChunkFingerprint(sealChunkBase) };
  const seededUpload = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sealSessionId}/upload`, headers, payload: { canonicalVersion, deviceId, chunk: sealChunk, records: sealRecords } });
  assert.equal(seededUpload.statusCode, 200, JSON.stringify(seededUpload.json()));
  const sealPayload = { canonicalVersion, deviceId, snapshotFingerprint: createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records: sealRecords, chunks: [sealChunk] }), recordCount: 1, chunkCount: 1 };
  const sealApp = buildTransferRotationApp(auth.userId, "sealAdoptionTransfer", "authorizationGeneration");
  const seal = await sealApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sealSessionId}/seal`, headers, payload: sealPayload });
  assert.equal(seal.statusCode, 409, JSON.stringify(seal.json()));
  assert.deepEqual(seal.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await transferRefFor(auth.userId, sealSessionId).get()).data()?.state, "collecting");
  await sealApp.close();

  await userRef.update({ authorizationGeneration: 1, authorizationState: "active" });
  const stale = await setAuthCustomClaimsAndSignIn(auth, { authorizationGeneration: 2 });
  const staleStart = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers: { ...headers, authorization: `Bearer ${stale.idToken}` }, payload: { ...startPayload, sessionId: "rotation-transfer-stale-token", idempotencyKey: "rotation-transfer-stale-token" } });
  assert.equal(staleStart.statusCode, 401, JSON.stringify(staleStart.json()));
  assert.deepEqual(staleStart.json(), { error: { code: "authorization_generation_stale" } });

  const inactiveApp = buildTransferRotationApp(auth.userId, "startAdoptionTransfer", "authorizationState");
  const inactiveStart = await inactiveApp.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { ...startPayload, sessionId: "rotation-transfer-inactive", idempotencyKey: "rotation-transfer-inactive" } });
  assert.equal(inactiveStart.statusCode, 401, JSON.stringify(inactiveStart.json()));
  assert.deepEqual(inactiveStart.json(), { error: { code: "account_deleted" } });
  assert.equal((await transferRefFor(auth.userId, "rotation-transfer-inactive").get()).exists, false);
  await inactiveApp.close();
});

test("transfer seal rechecks authorization generation in its final transaction", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const sessionId = "rotation-between-seal-transactions";
  const records = [activeRecord("between-seal-record", "between-seal-track")];
  const chunkBase = { chunkId: "chunk-0", index: 0, recordKeys: records.map(adoptionTransferRecordKey), bytes: 64 };
  const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
  const start = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { canonicalVersion, sessionId, idempotencyKey: sessionId, guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } });
  assert.equal(start.statusCode, 200, JSON.stringify(start.json()));
  const upload = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/upload`, headers, payload: { canonicalVersion, deviceId, chunk, records } });
  assert.equal(upload.statusCode, 200, JSON.stringify(upload.json()));

  const userRef = firestore().collection("users").doc(auth.userId);
  let transactionCount = 0;
  const racedDb = new Proxy(firestore(), {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "runTransaction" && typeof value === "function") {
        return async (...args: unknown[]) => {
          transactionCount += 1;
          if (transactionCount === 2) await userRef.update({ authorizationGeneration: 2 });
          return (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Firestore;
  const progress = new FirestoreProgressStore(racedDb);
  const app = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, progress },
  });
  const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records, chunks: [chunk] });
  const seal = await app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/seal`, headers, payload: { canonicalVersion, deviceId, snapshotFingerprint, recordCount: records.length, chunkCount: 1 } });
  assert.equal(transactionCount, 2);
  assert.equal(seal.statusCode, 409, JSON.stringify(seal.json()));
  assert.deepEqual(seal.json(), { error: { code: "authorization_generation_conflict" } });
  const stored = (await transferRefFor(auth.userId, sessionId).get()).data();
  assert.equal(stored?.state, "sealing");
  assert.equal(stored?.snapshotFingerprint, null);
  await app.close();
});

test("transfer preview fences reservation, finalization, and ready replay", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const userRef = firestore().collection("users").doc(auth.userId);

  async function seedSealedTransfer(sessionId: string) {
    const records = [activeRecord(`preview-${sessionId}`, `preview-track-${sessionId}`, "preview-value")];
    const start = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { canonicalVersion, sessionId, idempotencyKey: sessionId, guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } });
    assert.equal(start.statusCode, 200, JSON.stringify(start.json()));
    const chunkBase = { chunkId: "chunk-0", index: 0, recordKeys: records.map(adoptionTransferRecordKey), bytes: 64 };
    const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
    const upload = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/upload`, headers, payload: { canonicalVersion, deviceId, chunk, records } });
    assert.equal(upload.statusCode, 200, JSON.stringify(upload.json()));
    const chunks = [chunk];
    const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records, chunks });
    const seal = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/seal`, headers, payload: { canonicalVersion, deviceId, snapshotFingerprint, recordCount: records.length, chunkCount: chunks.length } });
    assert.equal(seal.statusCode, 200, JSON.stringify(seal.json()));
    return records;
  }

  // Rotation after request authentication but before the reservation transaction must not create result data.
  const beforeStage = "preview-rotate-before-stage";
  await seedSealedTransfer(beforeStage);
  const beforeStageApp = buildTransferRotationApp(auth.userId, "previewAdoptionTransfer", "authorizationGeneration");
  const beforeStageResponse = await beforeStageApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${beforeStage}/preview`, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(beforeStageResponse.statusCode, 409, JSON.stringify(beforeStageResponse.json()));
  assert.deepEqual(beforeStageResponse.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await transferRefFor(auth.userId, beforeStage).get()).data()?.state, "sealed");
  assert.equal((await transferRefFor(auth.userId, beforeStage).collection("results").get()).size, 0);
  await beforeStageApp.close();

  await userRef.update({ authorizationGeneration: 1, authorizationState: "active" });
  // Rotation after the one bounded result transaction but before finalization leaves no ready preview.
  const beforeFinalization = "preview-rotate-before-finalization";
  await seedSealedTransfer(beforeFinalization);
  let transactionCount = 0;
  const racedDb = new Proxy(firestore(), {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "runTransaction" && typeof value === "function") {
        return async (...args: unknown[]) => {
          transactionCount += 1;
          if (transactionCount === 3) await userRef.update({ authorizationGeneration: 2 });
          return (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Firestore;
  const racedProgress = new FirestoreProgressStore(racedDb);
  const chunkApp = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, progress: racedProgress },
  });
  const beforeFinalizationResponse = await chunkApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${beforeFinalization}/preview`, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(transactionCount, 3);
  assert.equal(beforeFinalizationResponse.statusCode, 409, JSON.stringify(beforeFinalizationResponse.json()));
  assert.deepEqual(beforeFinalizationResponse.json(), { error: { code: "authorization_generation_conflict" } });
  const partial = (await transferRefFor(auth.userId, beforeFinalization).get()).data();
  assert.equal(partial?.state, "result_building");
  assert.equal(partial?.previewFingerprint, undefined);
  assert.equal((await transferRefFor(auth.userId, beforeFinalization).collection("results").get()).size, 1);
  await chunkApp.close();

  await userRef.update({ authorizationGeneration: 1, authorizationState: "active" });
  // The retry fills any missing chunk, then finalization stores preview_ready.
  const retry = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${beforeFinalization}/preview`, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.json()));
  assert.equal((await transferRefFor(auth.userId, beforeFinalization).collection("results").get()).size, 1);
  assert.equal((await transferRefFor(auth.userId, beforeFinalization).get()).data()?.state, "preview_ready");

  // A ready preview replay also validates authorization before returning its stored result.
  const replayApp = buildTransferRotationApp(auth.userId, "previewAdoptionTransfer", "authorizationGeneration");
  const replay = await replayApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${beforeFinalization}/preview`, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(replay.statusCode, 409, JSON.stringify(replay.json()));
  assert.deepEqual(replay.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await transferRefFor(auth.userId, beforeFinalization).get()).data()?.state, "preview_ready");
  await replayApp.close();
});

test("empty transfer preview fences finalization and replays without result chunks", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const sessionId = "preview-empty-transfer";
  const start = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { canonicalVersion, sessionId, idempotencyKey: sessionId, guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } });
  assert.equal(start.statusCode, 200, JSON.stringify(start.json()));
  const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records: [], chunks: [] });
  const seal = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/seal`, headers, payload: { canonicalVersion, deviceId, snapshotFingerprint, recordCount: 0, chunkCount: 0 } });
  assert.equal(seal.statusCode, 200, JSON.stringify(seal.json()));

  const userRef = firestore().collection("users").doc(auth.userId);
  let transactionCount = 0;
  const racedDb = new Proxy(firestore(), {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "runTransaction" && typeof value === "function") {
        return async (...args: unknown[]) => {
          transactionCount += 1;
          if (transactionCount === 2) await userRef.update({ authorizationGeneration: 2 });
          return (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Firestore;
  const racedProgress = new FirestoreProgressStore(racedDb);
  const racedApp = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, progress: racedProgress },
  });
  const previewPath = `/v1/account-data/adoption/transfer/${sessionId}/preview`;
  const rotated = await racedApp.inject({ method: "POST", url: previewPath, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(transactionCount, 2);
  assert.equal(rotated.statusCode, 409, JSON.stringify(rotated.json()));
  assert.deepEqual(rotated.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await transferRefFor(auth.userId, sessionId).get()).data()?.state, "result_building");
  assert.equal((await transferRefFor(auth.userId, sessionId).collection("results").get()).size, 0);
  await racedApp.close();

  await userRef.update({ authorizationGeneration: 1, authorizationState: "active" });
  const preview = await context.app.inject({ method: "POST", url: previewPath, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.json()));
  assert.equal((await transferRefFor(auth.userId, sessionId).get()).data()?.state, "preview_ready");
  assert.equal((await transferRefFor(auth.userId, sessionId).collection("results").get()).size, 0);
  const replay = await context.app.inject({ method: "POST", url: previewPath, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(replay.statusCode, 200, JSON.stringify(replay.json()));
  assert.equal(replay.json().preview.fingerprint, preview.json().preview.fingerprint);
  assert.equal((await transferRefFor(auth.userId, sessionId).get()).data()?.state, "preview_ready");
});

function transferRefFor(userId: string, sessionId: string) {
  return firestore().collection("accounts").doc(userId).collection("adoptionTransfers").doc(sessionId);
}

function buildTransferRotationApp(userId: string, method: "startAdoptionTransfer" | "uploadAdoptionTransfer" | "sealAdoptionTransfer" | "previewAdoptionTransfer", field: "authorizationGeneration" | "authorizationState") {
  const original = context.stores.progress;
  const userRef = firestore().collection("users").doc(userId);
  const progress = new Proxy(original, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property !== method || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await userRef.update(field === "authorizationGeneration" ? { authorizationGeneration: 2 } : { authorizationState: "rotating" });
        return (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, args);
      };
    },
  });
  return buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, progress },
  });
}

function buildTransferTransactionRotationApp(userId: string, rotateBeforeTransaction: number) {
  const userRef = firestore().collection("users").doc(userId);
  let transactionCount = 0;
  const racedDb = new Proxy(firestore(), {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "runTransaction" && typeof value === "function") {
        return async (...args: unknown[]) => {
          transactionCount += 1;
          if (transactionCount === rotateBeforeTransaction) await userRef.update({ authorizationGeneration: 2 });
          return (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Firestore;
  const progress = new FirestoreProgressStore(racedDb);
  return buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, progress },
  });
}

function buildTransferWriteMeasuringApp(userId: string, chunks: Array<{ count: number; bytes: number }>) {
  const baseDb = firestore();
  const targetPrefix = `users/${userId}/progressGenerations/`;
  const measuredDb = new Proxy(baseDb, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property !== "runTransaction" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        const callback = args[0] as (transaction: Transaction) => Promise<unknown>;
        let attempted: { count: number; bytes: number } | undefined;
        const result = await (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, [async (transaction: Transaction) => {
          let count = 0;
          let bytes = 0;
          const observed = new Proxy(transaction, {
            get(tx, txProperty) {
              const txValue = Reflect.get(tx, txProperty, tx) as unknown;
              if (txProperty === "set" && typeof txValue === "function") {
                return (...writeArgs: unknown[]) => {
                  const ref = writeArgs[0] as { path?: string } | undefined;
                  if (ref?.path?.startsWith(targetPrefix) && ref.path.includes("/records/")) {
                    count += 1;
                    bytes += Buffer.byteLength(JSON.stringify(writeArgs[1]), "utf8") + 512;
                  }
                  return (txValue as (...callArgs: unknown[]) => unknown).apply(tx, writeArgs);
                };
              }
              return typeof txValue === "function" ? txValue.bind(tx) : txValue;
            },
          });
          const transactionResult = await callback(observed);
          attempted = { count, bytes };
          return transactionResult;
        }, ...args.slice(1)]);
        if (attempted && attempted.count > 0) chunks.push(attempted);
        return result;
      };
    },
  }) as Firestore;
  const progress = new FirestoreProgressStore(measuredDb);
  return buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, progress },
  });
}
