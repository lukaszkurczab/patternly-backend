import assert from "node:assert/strict";
import test from "node:test";

import { adoptionTransferRecordKey, createAdoptionSnapshotSeal, createAdoptionTransferChunkFingerprint } from "../src/modules/users/adoptionTransfer.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { TEST_APP_CHECK_TOKEN, clearFirestore, createEmulatorContext, createRegisteredAuthUser, firestore, type EmulatorContext } from "./support.js";

const deviceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const guestUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const trackId = "coding-interview-dsa-problem-solving";
const canonicalVersion = "canonical-json-v1" as const;
let context: EmulatorContext;

function activeRecord(recordId: string, recordTrackId: string, value = recordId): Readonly<{ recordType: "active_track"; recordId: string; trackId: string; state: Readonly<Record<string, unknown>>; version: number; fingerprint: string }> {
  const state = { trackId: recordTrackId, value };
  return { recordType: "active_track", recordId, trackId: recordTrackId, state, version: 0, fingerprint: createMergeRecordFingerprint({ recordType: "active_track", recordId, trackId: recordTrackId, state }) };
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
  const records = [activeRecord("record-" + "r".repeat(500), "track-" + "t".repeat(300)), activeRecord("shared-record", "track-b")];
  const sessionId = "canonical-transfer-test";
  const recordKeys = records.map(adoptionTransferRecordKey);
  const chunkBase = { chunkId: "chunk-0", index: 0, recordKeys, bytes: 512 };
  const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
  const start = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { canonicalVersion, sessionId, idempotencyKey: sessionId, guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } });
  assert.equal(start.statusCode, 200, JSON.stringify(start.json()));
  const invalidRecordType = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/upload`, headers, payload: { canonicalVersion, deviceId, chunk, records: [{ ...records[0], recordType: "unsupported_record" }] } });
  assert.equal(invalidRecordType.statusCode, 400, JSON.stringify(invalidRecordType.json()));
  const upload = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/upload`, headers, payload: { canonicalVersion, deviceId, chunk, records } });
  assert.equal(upload.statusCode, 200, JSON.stringify(upload.json()));
  const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records, chunks: [chunk] });
  const seal = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/seal`, headers, payload: { canonicalVersion, deviceId, snapshotFingerprint, recordCount: records.length, chunkCount: 1 } });
  assert.equal(seal.statusCode, 200, JSON.stringify(seal.json()));
  const preview = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/preview`, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.json()));
  assert.equal(preview.json().plan.uploadRecordIds.length, records.length);
  const confirmation = { canonicalVersion, deviceId, operationId: preview.json().preview.operationId as string, previewFingerprint: preview.json().preview.fingerprint as string, resolutions: [], groupChoices: [] };
  const confirm = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/confirm`, headers, payload: confirmation });
  assert.equal(confirm.statusCode, 200, JSON.stringify(confirm.json()));
  const apply = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: confirm.json().decisionFingerprint } });
  assert.equal(apply.statusCode, 200, JSON.stringify(apply.json()));
  const retry = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: confirm.json().decisionFingerprint } });
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.json()));
  const status = await context.app.inject({ method: "GET", url: `/v1/account-data/adoption/transfer/${sessionId}/status?deviceId=${deviceId}`, headers });
  assert.equal(status.statusCode, 200, JSON.stringify(status.json()));
  assert.equal(status.json().state, "complete");
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
