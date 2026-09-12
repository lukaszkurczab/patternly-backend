import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { FirestoreProgressStore } from "../src/modules/progress/store.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { adoptionTransferRecordKey, createAdoptionSnapshotSeal, createAdoptionTransferChunkFingerprint } from "../src/modules/users/adoptionTransfer.js";
import { progressDocumentId } from "../src/infrastructure/firestore/paths.js";
import { CONTENT_IDENTITY_SCHEMA } from "../src/modules/progress/contracts.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("firebase_emulator_suite_required");
const app = initializeApp({ projectId: "demo-patternly-progress-integrity" }, `progress-integrity-${randomUUID()}`);
const db = getFirestore(app);
const store = new FirestoreProgressStore(db);
const accounts: string[] = [];
const trackId = "coding-interview-dsa-problem-solving";
const recordType = "review_queue_entry" as const;
const recordId = "review-1";

async function account() {
  const id = randomUUID();
  accounts.push(id);
  await db.collection("users").doc(id).create({ id });
  return id;
}

function record(state: Record<string, unknown>) {
  const value = { recordId, recordType, trackId, state };
  return { ...value, version: 0, fingerprint: createMergeRecordFingerprint(value) };
}

function goalPlanRecords(label: string) {
  const goalState = { schemaVersion: 1, revision: 1, record: { goalType: "prepare_for_an_interview", preferredDays: ["mon"], status: "active", trackId, weeklySessionTarget: 1 } };
  const planState = { schemaVersion: 1, revision: 1, plan: { schemaVersion: 1, planId: `plan:${label}`, trackId, goalRevision: 1, status: "accepted", timezone: "Europe/Warsaw", contentVersion: "test", contentPackagePin: { packageIdentity: "package", packageVersion: "1", contentReleaseId: "release" }, acceptedTarget: { meaning: "none", targetDate: null }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", planRevision: 1, commandId: `command:${label}`, slots: [{ slotId: "slot:mon", day: "mon", localTime: label === "guest" ? "19:00" : "18:00", sessionLength: 10 }] } };
  return ([
    { recordId: trackId, recordType: "goal" as const, trackId, state: goalState },
    { recordId: trackId, recordType: "learning_plan" as const, trackId, state: planState },
  ]).map((value) => ({ ...value, version: 0, fingerprint: createMergeRecordFingerprint(value) }));
}

function goalPlanTombstones() {
  return (["goal", "learning_plan"] as const).map((recordType) => {
    const value = { recordId: trackId, recordType, trackId, state: { deleted: true } };
    return { ...value, version: 0, fingerprint: createMergeRecordFingerprint(value) };
  });
}

function v4State(questionId = "question-1") {
  return { identity: { kind: "resolved", ref: { trackId, questionId, contentVersion: "2026.09.1", artifactSha256: "a".repeat(64) } }, result: "correct" };
}

function v4Mutation(state: Record<string, unknown> = v4State()) {
  const value = { recordId, recordType, trackId, state, contentIdentitySchema: CONTENT_IDENTITY_SCHEMA };
  return {
    mutationId: `mutation-${randomUUID()}`,
    kind: "item" as const,
    recordType,
    trackId,
    targetId: recordId,
    expectedVersion: null,
    state,
    fingerprint: createMergeRecordFingerprint(value),
    contentIdentitySchema: CONTENT_IDENTITY_SCHEMA,
  };
}

async function sync(userId: string, revision: number, state: Record<string, unknown>) {
  const value = record(state);
  return store.applyBatch(userId, null, revision, [{
    mutationId: `mutation-${randomUUID()}`, kind: "item", recordType, trackId, targetId: recordId,
    expectedVersion: revision || null, state, fingerprint: value.fingerprint,
  }]);
}

test.after(async () => {
  for (const id of accounts) await db.recursiveDelete(db.collection("users").doc(id));
  await db.terminate();
  await deleteApp(app);
});

test("sync replaces removed fields and tombstones without corrupting persisted fingerprints", async () => {
  const userId = await account();
  const states = [
    { status: "learning", previousAnswer: "A", scheduling: { due: 1, overdue: true } },
    { status: "mastered", scheduling: { due: 2 } },
    { deleted: true },
  ];
  for (const [revision, state] of states.entries()) {
    const response = await sync(userId, revision, state);
    assert.equal(response.applied.length, 1);
    const persisted = await store.readSnapshot(userId);
    assert.equal(persisted.accountRevision, revision + 1);
    assert.equal(persisted.records.length, 1);
    assert.deepEqual(persisted.records[0]?.state, state);
    assert.equal(persisted.records[0]?.fingerprint, record(state).fingerprint);
    assert.equal(persisted.records[0]?.version, revision + 1);
  }
});

test("adoption replaces the selected account record and remains readable on replay", async () => {
  const userId = await account();
  await sync(userId, 0, { status: "learning", previousAnswer: "A", scheduling: { due: 1, overdue: true } });
  const state = { status: "mastered", scheduling: { due: 2 } };
  const snapshot = {
    guestSnapshotVersion: 1, guestUserId: randomUUID(), records: [record(state)],
    activeSession: false, pendingJournal: false,
  };
  const { preview } = await store.previewAdoption(userId, snapshot);
  const confirmation = {
    operationId: preview.operationId, previewFingerprint: preview.fingerprint, protocolVersion: 1 as const,
    resolutions: preview.conflicts.map(({ conflictId }) => ({ conflictId, resolution: "keep_guest" as const })),
  };
  const deviceId = randomUUID();
  const first = await store.confirmAdoption(userId, deviceId, snapshot, confirmation);
  const persisted = await store.readSnapshot(userId);
  assert.equal(persisted.accountRevision, 2);
  assert.deepEqual(persisted.records[0]?.state, state);
  assert.equal(persisted.records[0]?.fingerprint, record(state).fingerprint);
  const replay = await store.confirmAdoption(userId, deviceId, snapshot, confirmation);
  assert.deepEqual(replay, first);
});

test("v2 adoption executes one exact group choice and rejects missing or mismatched choices", async () => {
  const userId = await account();
  const remote = goalPlanRecords("account");
  await store.applyBatch(userId, null, 0, remote.map((item) => ({ mutationId: `mutation-${randomUUID()}`, kind: "node" as const, recordType: item.recordType, trackId, targetId: trackId, expectedVersion: null, state: item.state, fingerprint: item.fingerprint })));
  const guest = goalPlanRecords("guest");
  const snapshot = { protocolVersion: 2 as const, guestSnapshotVersion: 1, guestUserId: randomUUID(), records: guest, activeSession: false, pendingJournal: false };
  const { preview } = await store.previewAdoption(userId, snapshot);
  assert.equal(preview.protocolVersion, 2);
  if (preview.protocolVersion !== 2) throw new Error("v2_preview_required");
  assert.equal(preview.goalPlanConflictGroups.length, 1);
  const base = { operationId: preview.operationId, previewFingerprint: preview.fingerprint, resolutions: [] };
  await assert.rejects(() => store.confirmAdoption(userId, randomUUID(), snapshot, { ...base, protocolVersion: 2, groupChoices: [] }), /merge_group_choice_incomplete/);
  await assert.rejects(() => store.confirmAdoption(userId, randomUUID(), snapshot, { ...base, protocolVersion: 1 }), /merge_preview_mismatch/);
  const result = await store.confirmAdoption(userId, randomUUID(), snapshot, { ...base, protocolVersion: 2, groupChoices: [{ groupId: preview.goalPlanConflictGroups[0]!.groupId, resolution: "keep_guest" }] });
  assert.equal(result.accountRevision, 3);
  const persisted = await store.readSnapshot(userId, 2);
  assert.equal(persisted.records.find((item) => item.recordType === "learning_plan")?.fingerprint, guest[1]!.fingerprint);
});

test("v2 adoption requires a choice before replacing account tombstones with a live local goal-plan pair", async () => {
  const userId = await account();
  const deleted = goalPlanTombstones();
  await store.applyBatch(userId, null, 0, deleted.map((item) => ({ mutationId: `mutation-${randomUUID()}`, kind: "node" as const, recordType: item.recordType, trackId, targetId: trackId, expectedVersion: null, state: item.state, fingerprint: item.fingerprint })));
  const guest = goalPlanRecords("guest");
  const snapshot = { protocolVersion: 2 as const, guestSnapshotVersion: 1, guestUserId: randomUUID(), records: guest, activeSession: false, pendingJournal: false };
  const { preview } = await store.previewAdoption(userId, snapshot);
  if (preview.protocolVersion !== 2) throw new Error("v2_preview_required");
  assert.equal(preview.goalPlanConflictGroups.length, 1);
  const base = { operationId: preview.operationId, previewFingerprint: preview.fingerprint, protocolVersion: 2 as const, resolutions: [] };
  await assert.rejects(() => store.confirmAdoption(userId, randomUUID(), snapshot, { ...base, groupChoices: [] }), /merge_group_choice_incomplete/);
  const keptAccount = await store.confirmAdoption(userId, randomUUID(), snapshot, { ...base, groupChoices: [{ groupId: preview.goalPlanConflictGroups[0]!.groupId, resolution: "keep_account" as const }] });
  assert.ok(keptAccount.records.filter((item) => item.state.deleted === true).length === 2);
});

test("a stale live preview cannot replace account tombstones created before confirmation", async () => {
  const userId = await account();
  const remote = goalPlanRecords("account");
  await store.applyBatch(userId, null, 0, remote.map((item) => ({ mutationId: `mutation-${randomUUID()}`, kind: "node" as const, recordType: item.recordType, trackId, targetId: trackId, expectedVersion: null, state: item.state, fingerprint: item.fingerprint })));
  const guest = goalPlanRecords("guest");
  const snapshot = { protocolVersion: 2 as const, guestSnapshotVersion: 1, guestUserId: randomUUID(), records: guest, activeSession: false, pendingJournal: false };
  const { preview } = await store.previewAdoption(userId, snapshot);
  if (preview.protocolVersion !== 2) throw new Error("v2_preview_required");
  const deleted = goalPlanTombstones();
  await store.applyBatch(userId, null, 2, deleted.map((item) => ({ mutationId: `mutation-${randomUUID()}`, kind: "node" as const, recordType: item.recordType, trackId, targetId: trackId, expectedVersion: 1, state: item.state, fingerprint: item.fingerprint })));
  await assert.rejects(() => store.confirmAdoption(userId, randomUUID(), snapshot, {
    operationId: preview.operationId,
    previewFingerprint: preview.fingerprint,
    protocolVersion: 2,
    resolutions: [],
    groupChoices: [{ groupId: preview.goalPlanConflictGroups[0]!.groupId, resolution: "keep_guest" }],
  }), /merge_preview_mismatch/);
  const persisted = await store.readSnapshot(userId, 2);
  assert.equal(persisted.records.filter((item) => item.state.deleted === true).length, 2);
});

test("applyBatch checks both progress document ids before allowing a downgrade", async () => {
  const v4UserId = await account();
  const metadata = { sessionId: randomUUID(), batchId: randomUUID(), planVersion: 4 as const, highWatermark: 0, contentIdentitySchema: CONTENT_IDENTITY_SCHEMA };
  await store.applyBatch(v4UserId, null, 0, [v4Mutation()], metadata);
  const collection = db.collection("users").doc(v4UserId).collection("progress");
  const currentId = progressDocumentId({ kind: "item", recordType, trackId, targetId: recordId });
  const legacyId = createHash("sha256").update(`item:${recordType}:${recordId}`, "utf8").digest("hex");
  assert.equal((await collection.doc(currentId).get()).data()?.contentIdentitySchema, CONTENT_IDENTITY_SCHEMA);
  assert.equal((await collection.doc(legacyId).get()).exists, false);
  const legacyState = { status: "legacy" };
  const legacyValue = { recordId, recordType, trackId, state: legacyState };
  const downgrade = await store.applyBatch(v4UserId, null, 1, [{ mutationId: `mutation-${randomUUID()}`, kind: "item", recordType, trackId, targetId: recordId, expectedVersion: 1, state: legacyState, fingerprint: createMergeRecordFingerprint(legacyValue) }]);
  assert.equal(downgrade.conflicts[0]?.code, "content_identity_schema_conflict");
  assert.equal((await collection.doc(legacyId).get()).exists, false);

  const legacyUserId = await account();
  await sync(legacyUserId, 0, { status: "legacy" });
  const upgradedLegacyState = { status: "legacy-updated" };
  const upgradedLegacyValue = { recordId, recordType, trackId, state: upgradedLegacyState };
  const legacyRetry = await store.applyBatch(legacyUserId, null, 1, [{ mutationId: `mutation-${randomUUID()}`, kind: "item", recordType, trackId, targetId: recordId, expectedVersion: 1, state: upgradedLegacyState, fingerprint: createMergeRecordFingerprint(upgradedLegacyValue) }]);
  assert.equal(legacyRetry.applied.length, 1);
  const legacyCollection = db.collection("users").doc(legacyUserId).collection("progress");
  assert.deepEqual((await legacyCollection.doc(legacyId).get()).data()?.state, upgradedLegacyState);
  assert.equal((await legacyCollection.doc(currentId).get()).exists, false);
});

test("v4 read returns only persisted schema-bound records", async () => {
  const userId = await account();
  await store.applyBatch(userId, null, 0, [v4Mutation()], { sessionId: randomUUID(), batchId: randomUUID(), planVersion: 4, highWatermark: 0, contentIdentitySchema: CONTENT_IDENTITY_SCHEMA });
  const v4 = await store.readSnapshot(userId, 4);
  assert.equal(v4.records.length, 1);
  assert.equal(v4.records[0]?.contentIdentitySchema, CONTENT_IDENTITY_SCHEMA);
  assert.equal((await store.readSnapshot(userId, 2)).records.length, 0);
});

test("one-shot v4 adoption replay rejects corrupted persisted identity records", async () => {
  const userId = await account();
  const snapshot = { protocolVersion: 4 as const, contentIdentitySchema: CONTENT_IDENTITY_SCHEMA, guestSnapshotVersion: 1, guestUserId: randomUUID(), records: [{ recordId: recordId, recordType, trackId, state: v4State(), version: 0, contentIdentitySchema: CONTENT_IDENTITY_SCHEMA, fingerprint: createMergeRecordFingerprint({ recordId, recordType, trackId, state: v4State(), contentIdentitySchema: CONTENT_IDENTITY_SCHEMA }) }], activeSession: false, pendingJournal: false };
  const preview = await store.previewAdoption(userId, snapshot);
  const confirmation = { operationId: preview.preview.operationId, previewFingerprint: preview.preview.fingerprint, protocolVersion: 4 as const, contentIdentitySchema: CONTENT_IDENTITY_SCHEMA, resolutions: [], groupChoices: [] };
  const first = await store.confirmAdoption(userId, randomUUID(), snapshot, confirmation);
  const operation = db.collection("users").doc(userId).collection("syncOperations").doc(confirmation.operationId);
  const corrupted = { ...(first.records[0] as Record<string, unknown>) };
  delete corrupted.contentIdentitySchema;
  await operation.update({ records: [corrupted] });
  await assert.rejects(() => store.confirmAdoption(userId, randomUUID(), snapshot, confirmation), /content_identity_schema_conflict/);
});

test("resumable v4 seal replay rejects a corrupted persisted operation schema", async () => {
  const userId = await account();
  const guestUserId = randomUUID();
  const sessionId = `seal-${randomUUID()}`;
  const deviceId = randomUUID();
  await store.startAdoptionTransfer(userId, { protocolVersion: 4, canonicalVersion: "canonical-json-v1", contentIdentitySchema: CONTENT_IDENTITY_SCHEMA, sessionId, idempotencyKey: sessionId, guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId, activeSession: false, pendingJournal: false });
  const state = v4State("seal-question");
  const base = { recordType: "active_track" as const, recordId: "seal-record", trackId, state, version: 0, contentIdentitySchema: CONTENT_IDENTITY_SCHEMA };
  const staged = { ...base, fingerprint: createMergeRecordFingerprint(base) };
  const chunkBase = { chunkId: "seal-chunk", index: 0, recordKeys: [adoptionTransferRecordKey(staged)], bytes: 256 };
  const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
  await store.uploadAdoptionTransfer(userId, sessionId, { canonicalVersion: "canonical-json-v1", contentIdentitySchema: CONTENT_IDENTITY_SCHEMA, deviceId, chunk, records: [staged] });
  const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records: [staged], chunks: [chunk], contentIdentitySchema: CONTENT_IDENTITY_SCHEMA });
  await store.sealAdoptionTransfer(userId, sessionId, { canonicalVersion: "canonical-json-v1", contentIdentitySchema: CONTENT_IDENTITY_SCHEMA, deviceId, snapshotFingerprint, recordCount: 1, chunkCount: 1 });
  await db.collection("accounts").doc(userId).collection("adoptionTransfers").doc(sessionId).update({ contentIdentitySchema: "patternly:content-identity:corrupted" });
  await assert.rejects(() => store.sealAdoptionTransfer(userId, sessionId, { canonicalVersion: "canonical-json-v1", contentIdentitySchema: CONTENT_IDENTITY_SCHEMA, deviceId, snapshotFingerprint, recordCount: 1, chunkCount: 1 }), /content_identity_schema_conflict/);
});
