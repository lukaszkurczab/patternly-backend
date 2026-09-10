import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";

import { adoptionTransferRecordKey, createAdoptionSnapshotSeal, createAdoptionTransferChunkFingerprint } from "../src/modules/users/adoptionTransfer.js";
import { adoptionTransferDecisionDocumentId } from "../src/infrastructure/firestore/paths.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { createAdoptionDecisionFingerprint } from "../src/modules/progress/store.js";
import { clearFirestore, createAuthUser, createEmulatorContext, firestore, type EmulatorContext } from "./support.js";

const deviceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const guestUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const trackId = "coding-interview-dsa-problem-solving";

function activeRecord(recordId: string, recordTrackId: string, value = recordId): Readonly<{ recordType: "active_track"; recordId: string; trackId: string; state: Readonly<Record<string, unknown>>; version: number; fingerprint: string }> {
  const state = { trackId: recordTrackId, value };
  return { recordType: "active_track", recordId, trackId: recordTrackId, state, version: 0, fingerprint: createMergeRecordFingerprint({ recordType: "active_track", recordId, trackId: recordTrackId, state }) };
}

let context: EmulatorContext;

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

test("adoption v3 persists child records, seals, confirms, applies a hidden generation, and retries safely", async () => {
  const auth = await createAuthUser();
  const headers = { authorization: `Bearer ${auth.idToken}` };
  const me = await context.app.inject({ method: "GET", url: "/v1/me", headers });
  assert.equal(me.statusCode, 200);
  const accountId = me.json().user.id as string;
  const state = { trackId };
  const record = { recordType: "active_track" as const, recordId: "current", trackId, state, version: 0, fingerprint: createMergeRecordFingerprint({ recordType: "active_track", recordId: "current", trackId, state }) };
  const chunkBase = { chunkId: "chunk-0", index: 0, recordKeys: [adoptionTransferRecordKey(record)], bytes: 256 };
  const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
  const start = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/start", headers, payload: { sessionId: "adoption-v3-test", idempotencyKey: "adoption-v3-test", guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } });
  assert.equal(start.statusCode, 200);
  assert.equal((await context.app.inject({ method: "GET", url: "/v3/account-data/adoption/adoption-v3-test/status", headers })).statusCode, 400);
  assert.equal((await context.app.inject({ method: "GET", url: "/v3/account-data/adoption/adoption-v3-test/status?deviceId=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", headers })).statusCode, 409);
  assert.equal((await context.app.inject({ method: "GET", url: `/v3/account-data/adoption/adoption-v3-test/status?deviceId=${deviceId}`, headers })).statusCode, 200);
  const upload = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/adoption-v3-test/upload", headers, payload: { deviceId, chunk, records: [record] } });
  assert.equal(upload.statusCode, 200);
  const duplicateUpload = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/adoption-v3-test/upload", headers, payload: { deviceId, chunk, records: [record] } });
  assert.equal(duplicateUpload.statusCode, 200);
  const mismatchedChunk = { ...chunkBase, bytes: 257, fingerprint: createAdoptionTransferChunkFingerprint({ ...chunkBase, bytes: 257 }) };
  const mismatchUpload = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/adoption-v3-test/upload", headers, payload: { deviceId, chunk: mismatchedChunk, records: [record] } });
  assert.equal(mismatchUpload.statusCode, 409);
  const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records: [record], chunks: [chunk] });
  const seal = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/adoption-v3-test/seal", headers, payload: { deviceId, snapshotFingerprint, recordCount: 1, chunkCount: 1 } });
  assert.equal(seal.statusCode, 200, JSON.stringify(seal.json()));
  const preview = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/adoption-v3-test/preview", headers, payload: { deviceId, protocolVersion: 1 } });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().preview.fingerprint.length, 64);
  const confirm = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/adoption-v3-test/confirm", headers, payload: { deviceId, operationId: preview.json().preview.operationId, previewFingerprint: preview.json().preview.fingerprint, protocolVersion: 1, resolutions: [] } });
  assert.equal(confirm.statusCode, 200);
  const confirmed = confirm.json().decisionFingerprint as string;
  const replayConfirm = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/adoption-v3-test/confirm", headers, payload: { deviceId, operationId: preview.json().preview.operationId, previewFingerprint: preview.json().preview.fingerprint, protocolVersion: 1, resolutions: [], decisionFingerprint: confirmed } });
  assert.equal(replayConfirm.statusCode, 200);
  const mismatchConfirm = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/adoption-v3-test/confirm", headers, payload: { deviceId, operationId: preview.json().preview.operationId, previewFingerprint: preview.json().preview.fingerprint, protocolVersion: 1, resolutions: [], decisionFingerprint: "f".repeat(64) } });
  assert.equal(mismatchConfirm.statusCode, 409);
  await firestore().collection("users").doc(accountId).collection("syncMetadata").doc("account").set({ adoptionPromotionSessionId: "orphan-session", adoptionPromotionTargetGeneration: 99, adoptionPromotionLeaseExpiresAt: Timestamp.fromMillis(Date.now() - 1) }, { merge: true });
  const apply = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/adoption-v3-test/apply", headers, payload: { deviceId, decisionFingerprint: confirmed } });
  assert.equal(apply.statusCode, 200);
  assert.equal(apply.json().state, "complete");
  const retryApply = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/adoption-v3-test/apply", headers, payload: { deviceId, decisionFingerprint: confirmed } });
  assert.equal(retryApply.statusCode, 200);
  const progress = await context.app.inject({ method: "GET", url: "/v1/progress?protocolVersion=2", headers });
  assert.equal(progress.statusCode, 200);
  assert.equal(progress.json().generation, 1);
  assert.equal(progress.json().records.length, 1);
  assert.equal(progress.json().records[0].trackId, trackId);
  const operation = (await firestore().collection("accounts").doc(accountId).collection("adoptionTransfers").doc("adoption-v3-test").get()).data();
  assert.ok(operation);
  assert.equal("records" in operation, false);
  assert.equal((await firestore().collection("accounts").doc(accountId).collection("adoptionTransfers").doc("adoption-v3-test").collection("records").get()).size, 1);
  assert.equal((await firestore().collection("users").doc(accountId).collection("progressGenerations").doc("1").collection("records").get()).size, 1);
});

test("adoption v3 binds every staged request to its device and scopes start idempotency to the account", async () => {
  const auth = await createAuthUser();
  const headers = { authorization: `Bearer ${auth.idToken}` };
  const me = await context.app.inject({ method: "GET", url: "/v1/me", headers });
  const accountId = me.json().user.id as string;
  const record = activeRecord("device-bound", trackId);
  const chunkBase = { chunkId: "device-chunk", index: 0, recordKeys: [adoptionTransferRecordKey(record)], bytes: 128 };
  const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
  const start = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/start", headers, payload: { sessionId: "device-session-a", idempotencyKey: "device-idempotency", guestUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", snapshotVersion: 1, expectedGeneration: 0, deviceId } });
  assert.equal(start.statusCode, 200);
  const conflictingSession = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/start", headers, payload: { sessionId: "device-session-b", idempotencyKey: "device-idempotency", guestUserId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", snapshotVersion: 1, expectedGeneration: 0, deviceId } });
  assert.equal(conflictingSession.statusCode, 409);
  const missingUploadDevice = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/device-session-a/upload", headers, payload: { chunk, records: [record] } });
  assert.equal(missingUploadDevice.statusCode, 400);
  const wrongUploadDevice = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/device-session-a/upload", headers, payload: { deviceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", chunk, records: [record] } });
  assert.equal(wrongUploadDevice.statusCode, 409);
  const upload = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/device-session-a/upload", headers, payload: { deviceId, chunk, records: [record] } });
  assert.equal(upload.statusCode, 200);
  const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", snapshotVersion: 1, records: [record], chunks: [chunk] });
  const missingSealDevice = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/device-session-a/seal", headers, payload: { snapshotFingerprint, recordCount: 1, chunkCount: 1 } });
  assert.equal(missingSealDevice.statusCode, 400);
  const seal = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/device-session-a/seal", headers, payload: { deviceId, snapshotFingerprint, recordCount: 1, chunkCount: 1 } });
  assert.equal(seal.statusCode, 200);
  const missingPreviewDevice = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/device-session-a/preview", headers, payload: { protocolVersion: 1 } });
  assert.equal(missingPreviewDevice.statusCode, 400);
  const preview = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/device-session-a/preview", headers, payload: { deviceId, protocolVersion: 1 } });
  assert.equal(preview.statusCode, 200);
  assert.equal((await firestore().collection("accounts").doc(accountId).collection("adoptionTransferIdempotency").get()).size, 1);
});

test("adoption v3 materializes forty records, including same record ids on different tracks", async () => {
  const auth = await createAuthUser();
  const headers = { authorization: `Bearer ${auth.idToken}` };
  const accountId = (await context.app.inject({ method: "GET", url: "/v1/me", headers })).json().user.id as string;
  const records = [activeRecord("shared-record", "track-a"), activeRecord("shared-record", "track-b"), ...Array.from({ length: 38 }, (_, index) => activeRecord(`record-${index}`, `track-${index + 2}`))];
  const recordKeys = records.map(adoptionTransferRecordKey);
  const chunkBase = { chunkId: "forty-chunk", index: 0, recordKeys, bytes: 20_000 };
  const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
  const guestUserId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const start = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/start", headers, payload: { sessionId: "forty-session", idempotencyKey: "forty-idempotency", guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } });
  assert.equal(start.statusCode, 200, JSON.stringify(start.json()));
  const upload = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/forty-session/upload", headers, payload: { deviceId, chunk, records } });
  assert.equal(upload.statusCode, 200, JSON.stringify(upload.json()));
  const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records, chunks: [chunk] });
  assert.equal((await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/forty-session/seal", headers, payload: { deviceId, snapshotFingerprint, recordCount: records.length, chunkCount: 1 } })).statusCode, 200);
  const preview = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/forty-session/preview", headers, payload: { deviceId, protocolVersion: 1 } });
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.json()));
  assert.equal(preview.json().plan.uploadRecordIds.length, records.length);
  assert.ok(preview.json().plan.uploadRecordIds.includes(adoptionTransferRecordKey(records[0]!)));
  assert.ok(preview.json().plan.uploadRecordIds.includes(adoptionTransferRecordKey(records[1]!)));
  const confirmation = { deviceId, operationId: preview.json().preview.operationId, previewFingerprint: preview.json().preview.fingerprint, protocolVersion: 1, resolutions: [] };
  const confirm = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/forty-session/confirm", headers, payload: confirmation });
  assert.equal(confirm.statusCode, 200, JSON.stringify(confirm.json()));
  const apply = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/forty-session/apply", headers, payload: { deviceId, decisionFingerprint: confirm.json().decisionFingerprint } });
  assert.equal(apply.statusCode, 200, JSON.stringify(apply.json()));
  const progress = await context.app.inject({ method: "GET", url: "/v1/progress?protocolVersion=2", headers });
  assert.equal(progress.statusCode, 200);
  assert.equal(progress.json().records.length, records.length);
  assert.equal((await firestore().collection("users").doc(accountId).collection("progressGenerations").doc("1").collection("records").get()).size, records.length);
});

test("adoption v3 reserves isolated hidden generations for competing sessions", async () => {
  const auth = await createAuthUser();
  const headers = { authorization: `Bearer ${auth.idToken}` };
  const accountId = (await context.app.inject({ method: "GET", url: "/v1/me", headers })).json().user.id as string;
  const sessions = [
    { id: "concurrent-a", key: "concurrent-key-a", guestUserId: "11111111-1111-4111-8111-111111111111", record: activeRecord("concurrent-a", "track-a") },
    { id: "concurrent-b", key: "concurrent-key-b", guestUserId: "22222222-2222-4222-8222-222222222222", record: activeRecord("concurrent-b", "track-b") },
  ];
  const statuses = [] as Array<Record<string, unknown>>;
  for (const session of sessions) {
    const start = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/start", headers, payload: { sessionId: session.id, idempotencyKey: session.key, guestUserId: session.guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } });
    assert.equal(start.statusCode, 200, JSON.stringify(start.json()));
    statuses.push(start.json());
    const chunkBase = { chunkId: `${session.id}-chunk`, index: 0, recordKeys: [adoptionTransferRecordKey(session.record)], bytes: 256 };
    const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
    assert.equal((await context.app.inject({ method: "POST", url: `/v3/account-data/adoption/${session.id}/upload`, headers, payload: { deviceId, chunk, records: [session.record] } })).statusCode, 200);
    const seal = createAdoptionSnapshotSeal({ guestUserId: session.guestUserId, snapshotVersion: 1, records: [session.record], chunks: [chunk] });
    assert.equal((await context.app.inject({ method: "POST", url: `/v3/account-data/adoption/${session.id}/seal`, headers, payload: { deviceId, snapshotFingerprint: seal, recordCount: 1, chunkCount: 1 } })).statusCode, 200);
    const preview = await context.app.inject({ method: "POST", url: `/v3/account-data/adoption/${session.id}/preview`, headers, payload: { deviceId, protocolVersion: 1 } });
    assert.equal(preview.statusCode, 200);
    const confirm = await context.app.inject({ method: "POST", url: `/v3/account-data/adoption/${session.id}/confirm`, headers, payload: { deviceId, operationId: preview.json().preview.operationId, previewFingerprint: preview.json().preview.fingerprint, protocolVersion: 1, resolutions: [] } });
    assert.equal(confirm.statusCode, 200);
  }
  assert.notEqual(statuses[0]?.targetGeneration, statuses[1]?.targetGeneration);
  const applyA = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/concurrent-a/apply", headers, payload: { deviceId } });
  assert.equal(applyA.statusCode, 200, JSON.stringify(applyA.json()));
  const applyB = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/concurrent-b/apply", headers, payload: { deviceId } });
  assert.equal(applyB.statusCode, 409, JSON.stringify(applyB.json()));
  const metadata = (await firestore().collection("users").doc(accountId).collection("syncMetadata").doc("account").get()).data();
  assert.equal(metadata?.generation, 1);
  const targetA = String(statuses[0]?.targetGeneration);
  const targetB = String(statuses[1]?.targetGeneration);
  assert.equal((await firestore().collection("users").doc(accountId).collection("progressGenerations").doc(targetA).collection("records").get()).size, 1);
  assert.equal((await firestore().collection("users").doc(accountId).collection("progressGenerations").doc(targetB).collection("records").get()).size, 0);
  const active = await context.app.inject({ method: "GET", url: "/v1/progress?protocolVersion=2", headers });
  assert.equal(active.json().records[0].trackId, "track-a");
});

test("adoption v3 resumes a partially persisted decision child set", async () => {
  const auth = await createAuthUser();
  const headers = { authorization: `Bearer ${auth.idToken}` };
  const accountId = (await context.app.inject({ method: "GET", url: "/v1/me", headers })).json().user.id as string;
  const existing = activeRecord("partial-conflict", "partial-track", "account");
  await context.stores.progress.applyBatch(accountId, null, 0, [{ mutationId: "partial-mutation-0001", kind: "node", recordType: "active_track", trackId: existing.trackId, targetId: existing.recordId, expectedVersion: null, fingerprint: existing.fingerprint, state: existing.state }]);
  const guest = activeRecord("partial-conflict", "partial-track", "guest");
  const guestUserId = "33333333-3333-4333-8333-333333333333";
  const chunkBase = { chunkId: "partial-chunk", index: 0, recordKeys: [adoptionTransferRecordKey(guest)], bytes: 256 };
  const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
  assert.equal((await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/start", headers, payload: { sessionId: "partial-session", idempotencyKey: "partial-key", guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } })).statusCode, 200);
  assert.equal((await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/partial-session/upload", headers, payload: { deviceId, chunk, records: [guest] } })).statusCode, 200);
  const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records: [guest], chunks: [chunk] });
  assert.equal((await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/partial-session/seal", headers, payload: { deviceId, snapshotFingerprint, recordCount: 1, chunkCount: 1 } })).statusCode, 200);
  const preview = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/partial-session/preview", headers, payload: { deviceId, protocolVersion: 1 } });
  assert.equal(preview.statusCode, 200);
  const conflictId = preview.json().preview.conflicts[0].conflictId as string;
  const confirmation = { canonicalVersion: "canonical-json-v1" as const, deviceId, operationId: preview.json().preview.operationId as string, previewFingerprint: preview.json().preview.fingerprint as string, protocolVersion: 1 as const, resolutions: [{ conflictId, resolution: "keep_guest" as const }] };
  const decisionFingerprint = createAdoptionDecisionFingerprint(confirmation);
  const operation = firestore().collection("accounts").doc(accountId).collection("adoptionTransfers").doc("partial-session");
  const operationData = (await operation.get()).data();
  const timestamp = Timestamp.now();
  await operation.collection("decisions").doc(adoptionTransferDecisionDocumentId(`resolution:${conflictId}`)).set({ kind: "resolution", conflictId, resolution: "keep_guest", deviceId, previewFingerprint: confirmation.previewFingerprint, decisionFingerprint, protocolVersion: 1, createdAt: timestamp, updatedAt: timestamp, expiresAt: operationData?.expiresAt });
  const confirm = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/partial-session/confirm", headers, payload: { ...confirmation, decisionFingerprint } });
  assert.equal(confirm.statusCode, 200, JSON.stringify(confirm.json()));
  assert.equal((await operation.collection("decisions").get()).size, 2);
  const apply = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/partial-session/apply", headers, payload: { deviceId, decisionFingerprint } });
  assert.equal(apply.statusCode, 200, JSON.stringify(apply.json()));
});
