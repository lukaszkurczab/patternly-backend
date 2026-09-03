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
const recordType = "review_queue_entry" as const;
const recordId = "review-1";

function account() {
  const id = randomUUID();
  accounts.push(id);
  return id;
}

function record(state: Record<string, unknown>) {
  const value = { recordId, recordType, trackId, state };
  return { ...value, version: 0, fingerprint: createMergeRecordFingerprint(value) };
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
  const userId = account();
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
  const userId = account();
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
