import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { FirestoreProgressStore } from "../src/modules/progress/store.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("firebase_emulator_suite_required");
const app = initializeApp({ projectId: "demo-patternly-progress-integrity" }, `progress-integrity-${randomUUID()}`);
const db = getFirestore(app);
const store = new FirestoreProgressStore(db);
const accounts: string[] = [];
const trackId = "coding-interview-dsa-problem-solving";
const deviceId = "00000000-0000-4000-8000-000000000000";

async function account(): Promise<string> {
  const id = randomUUID();
  accounts.push(id);
  await db.collection("users").doc(id).create({ id });
  return id;
}

function mutation(recordType: "review_queue_entry" | "training_attempt", recordId: string, state: Readonly<Record<string, unknown>>, expectedVersion: number | null = null) {
  const base = { recordId, recordType, trackId, state };
  return { mutationId: `mutation-${randomUUID()}`, kind: "item" as const, recordType, trackId, targetId: recordId, expectedVersion, state, fingerprint: createMergeRecordFingerprint(base) };
}

function metadata(index = 0) {
  return { sessionId: "session-1", batchId: `batch-${index}`, highWatermark: index + 1 };
}

test.after(async () => {
  for (const id of accounts) await db.recursiveDelete(db.collection("users").doc(id));
  await db.terminate();
  await deleteApp(app);
});

test("canonical sync persists exact identity records and replays by batch metadata", async () => {
  const userId = await account();
  const state = { identity: { kind: "resolved", ref: { trackId, questionId: "question-1", contentVersion: "2026.09.1", artifactSha256: "a".repeat(64) } }, result: "correct" };
  const firstMutation = mutation("training_attempt", "attempt-1", state);
  const first = await store.applyBatch(userId, deviceId, 0, [firstMutation], metadata());
  assert.equal(first.applied.length, 1);
  assert.equal(first.accountRevision, 1);
  const snapshot = await store.readSnapshot(userId);
  assert.deepEqual(snapshot.records[0]?.state, state);
  assert.equal(snapshot.records[0]?.fingerprint, firstMutation.fingerprint);
  const replay = await store.applyBatch(userId, deviceId, 0, [firstMutation], metadata());
  assert.equal(replay.applied.length, 1);
  assert.deepEqual(replay.duplicates, []);
  const persisted = (await db.collection("users").doc(userId).collection("progress").get()).docs[0]!.data();
  assert.equal(Object.hasOwn(persisted, "protocolVersion"), false);
  assert.equal(Object.hasOwn(persisted, "contentIdentitySchema"), false);
});

test("long sync identities persist through hashed Firestore document keys", async () => {
  const userId = await account();
  const longTrackId = "track".repeat(60);
  const longTargetId = "target".repeat(100);
  const state = { result: "correct" };
  const base = { recordId: longTargetId, recordType: "training_attempt" as const, trackId: longTrackId, state };
  const longMutation = {
    mutationId: `mutation-${randomUUID()}`,
    kind: "item" as const,
    recordType: base.recordType,
    trackId: longTrackId,
    targetId: longTargetId,
    expectedVersion: null,
    state,
    fingerprint: createMergeRecordFingerprint(base),
  };
  const result = await store.applyBatch(userId, deviceId, 0, [longMutation], metadata(10));
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0]?.trackId, longTrackId);
  assert.equal(result.applied[0]?.targetId, longTargetId);
  const documents = await db.collection("users").doc(userId).collection("progress").get();
  assert.equal(documents.size, 1);
  assert.match(documents.docs[0]!.id, /^[a-f0-9]{64}$/u);
});

test("read fails closed for malformed persisted progress identity records", async () => {
  const malformedRows = [
    { label: "empty trackId", trackId: "", targetId: "attempt-empty-track", kind: "item" as const },
    { label: "empty targetId", trackId, targetId: "", kind: "item" as const },
    { label: "kind and recordType mismatch", trackId, targetId: "attempt-kind-mismatch", kind: "node" as const },
  ];
  for (const [index, row] of malformedRows.entries()) {
    const userId = await account();
    const state = { result: "correct" };
    const fingerprint = createMergeRecordFingerprint({ recordId: row.targetId, recordType: "training_attempt", trackId: row.trackId, state });
    await db.collection("users").doc(userId).collection("progress").doc(`malformed-${index}`).set({ kind: row.kind, recordType: "training_attempt", trackId: row.trackId, targetId: row.targetId, version: 1, fingerprint, state, lastMutationId: `mutation-malformed-${index}`, updatedAt: new Date() });
    await assert.rejects(() => store.readSnapshot(userId), /progress_record_invalid/u, row.label);
  }
});

test("one-shot adoption uses the same exact identity and explicit group choice shape", async () => {
  const userId = await account();
  const state = { result: "mastered" };
  const guestUserId = randomUUID();
  const snapshot = { guestSnapshotVersion: 1, guestUserId, records: [{ recordId: "attempt-1", recordType: "training_attempt" as const, trackId, state, version: 0, fingerprint: createMergeRecordFingerprint({ recordId: "attempt-1", recordType: "training_attempt", trackId, state }) }], activeSession: false, pendingJournal: false };
  const preview = await store.previewAdoption(userId, snapshot);
  const confirmation = { operationId: preview.preview.operationId, previewFingerprint: preview.preview.fingerprint, resolutions: [], groupChoices: [] };
  const first = await store.confirmAdoption(userId, deviceId, snapshot, confirmation);
  assert.equal(first.records.length, 1);
  const replay = await store.confirmAdoption(userId, deviceId, snapshot, confirmation);
  assert.deepEqual(replay, first);
});

test("legacy identity leaves are rejected before a write", async () => {
  const userId = await account();
  const state = { identity: { trackId, questionId: "question-1", contentVersion: "2026.09.1", artifactSha256: "a".repeat(64), packagePin: "retired" } };
  const invalid = mutation("training_attempt", "attempt-legacy", state);
  await assert.rejects(() => store.applyBatch(userId, deviceId, 0, [invalid], metadata()), /content_identity_schema_conflict/u);
  assert.equal((await store.readSnapshot(userId)).records.length, 0);
});
