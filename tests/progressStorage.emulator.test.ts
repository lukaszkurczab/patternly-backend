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

function goalState(track: string, targetDate: string, revision = 1) {
  return { schemaVersion: 1, revision, record: { goalType: "prepare_for_a_certification", preferredDays: ["mon"], status: "active", targetDate, trackId: track, weeklySessionTarget: 1 } };
}

function planState(track: string, targetDate: string, goalRevision = 1, planRevision = 1) {
  return { schemaVersion: 1, revision: planRevision, plan: { schemaVersion: 2, planId: `plan-${track}`, trackId: track, goalRevision, status: "accepted", timezone: "Europe/Warsaw", contentVersion: "content-v1", artifactSha256: "a".repeat(64), acceptedTarget: { meaning: "event", targetDate }, createdAt: "2026-09-09T08:00:00.000Z", updatedAt: "2026-09-09T08:00:00.000Z", planRevision, commandId: `command-${planRevision}`, slots: [{ slotId: `slot-${planRevision}`, day: "mon", localTime: "18:00", sessionLength: 25 }], minutesPerStudyDay: 25, executionPolicy: { policyVersion: "patternly-learning-execution-v1", initialDiagnosis: null, practice: { modeId: "coding-interview-guided-practice", requestedLength: 10 } }, planningPolicyIdentity: { contentVersion: "content-v1", artifactSha256: "a".repeat(64), policyVersion: "policy-v1" } } };
}

function goalPlanMutation(recordType: "goal" | "learning_plan", track: string, state: Readonly<Record<string, unknown>>, expectedVersion: number | null = null) {
  const base = { recordId: track, recordType, trackId: track, state };
  return { mutationId: `mutation-${randomUUID()}`, kind: "node" as const, recordType, trackId: track, targetId: track, expectedVersion, state, fingerprint: createMergeRecordFingerprint(base) };
}

function goalPlanPair(track: string, targetDate: string, goalRevision = 1, planRevision = 1) {
  const goal = goalPlanMutation("goal", track, goalState(track, targetDate, goalRevision), goalRevision === 1 ? null : goalRevision - 1);
  const plan = goalPlanMutation("learning_plan", track, planState(track, targetDate, goalRevision, planRevision), planRevision === 1 ? null : planRevision - 1);
  return [goal, plan] as const;
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
  const first = await store.applyBatch(userId, 1, deviceId, 0, [firstMutation], metadata());
  assert.equal(first.applied.length, 1);
  assert.equal(first.accountRevision, 1);
  const snapshot = await store.readSnapshot(userId);
  assert.deepEqual(snapshot.records[0]?.state, state);
  assert.equal(snapshot.records[0]?.fingerprint, firstMutation.fingerprint);
  const replay = await store.applyBatch(userId, 1, deviceId, 0, [firstMutation], metadata());
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
  const result = await store.applyBatch(userId, 1, deviceId, 0, [longMutation], metadata(10));
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
  const first = await store.confirmAdoption(userId, 1, deviceId, snapshot, confirmation);
  assert.equal(first.records.length, 1);
  const replay = await store.confirmAdoption(userId, 1, deviceId, snapshot, confirmation);
  assert.deepEqual(replay, first);
});

test("legacy identity leaves are rejected before a write", async () => {
  const userId = await account();
  const state = { identity: { trackId, questionId: "question-1", contentVersion: "2026.09.1", artifactSha256: "a".repeat(64), packagePin: "retired" } };
  const invalid = mutation("training_attempt", "attempt-legacy", state);
  await assert.rejects(() => store.applyBatch(userId, 1, deviceId, 0, [invalid], metadata()), /content_identity_schema_conflict/u);
  assert.equal((await store.readSnapshot(userId)).records.length, 0);
});

test("goal and accepted plan sync as one effective bundle while unrelated tracks stay valid", async () => {
  const userId = await account();
  const sibling = goalPlanPair("coding-interview-dsa-problem-solving", "2027-09-09");
  const siblingResult = await store.applyBatch(userId, 1, deviceId, 0, sibling, metadata(20));
  assert.equal(siblingResult.applied.length, 2);

  const target = goalPlanPair("aws-certified-solutions-architect-associate", "2027-10-10");
  const result = await store.applyBatch(userId, 1, deviceId, 2, target, metadata(21));
  assert.equal(result.applied.length, 2);
  const records = await store.readSnapshot(userId);
  assert.equal(records.records.length, 4);
  assert.deepEqual(records.records.filter((record) => record.trackId === "aws-certified-solutions-architect-associate").map((record) => record.recordType).sort(), ["goal", "learning_plan"]);
  assert.deepEqual(records.records.filter((record) => record.trackId === "coding-interview-dsa-problem-solving").map((record) => record.recordType).sort(), ["goal", "learning_plan"]);
});

test("a changed goal cannot leave its v2 accepted plan pointing at the old target", async () => {
  const userId = await account();
  const track = "aws-certified-solutions-architect-associate";
  await store.applyBatch(userId, 1, deviceId, 0, goalPlanPair(track, "2027-09-09"), metadata(30));
  const changedGoal = goalPlanMutation("goal", track, goalState(track, "2027-10-10", 2), 1);
  await assert.rejects(() => store.applyBatch(userId, 1, deviceId, 2, [changedGoal], metadata(31)), { message: "goal_plan_bundle_invalid" });
  const snapshot = await store.readSnapshot(userId);
  assert.equal(snapshot.accountRevision, 2);
  assert.equal(snapshot.records.find((record) => record.recordType === "goal")?.fingerprint, goalPlanPair(track, "2027-09-09")[0]!.fingerprint);
  assert.equal((await db.collection("users").doc(userId).collection("syncBatches").where("batchId", "==", "batch-31").get()).empty, true);
});

test("duplicate goal identities in one batch are rejected before either bundle write", async () => {
  const userId = await account();
  const track = "aws-certified-solutions-architect-associate";
  const [goal, plan] = goalPlanPair(track, "2027-09-09");
  const duplicateGoal = goalPlanMutation("goal", track, goal.state);
  await assert.rejects(() => store.applyBatch(userId, 1, deviceId, 0, [goal, duplicateGoal, plan], metadata(32)), { message: "goal_plan_bundle_invalid" });
  assert.equal((await store.readSnapshot(userId)).records.length, 0);
  assert.equal((await store.readSnapshot(userId)).accountRevision, 0);
});

test("goal deletion alone is rejected, while deleting both bundle records is accepted", async () => {
  const userId = await account();
  const track = "aws-certified-solutions-architect-associate";
  await store.applyBatch(userId, 1, deviceId, 0, goalPlanPair(track, "2027-09-09"), metadata(40));
  const deleted = { deleted: true };
  const goalDelete = goalPlanMutation("goal", track, deleted, 1);
  await assert.rejects(() => store.applyBatch(userId, 1, deviceId, 2, [goalDelete], metadata(41)), { message: "goal_plan_bundle_invalid" });
  assert.equal((await store.readSnapshot(userId)).accountRevision, 2);

  const bothDeletes = [goalDelete, goalPlanMutation("learning_plan", track, deleted, 1)];
  const result = await store.applyBatch(userId, 1, deviceId, 2, bothDeletes, metadata(42));
  assert.equal(result.applied.length, 2);
  assert.equal(result.accountRevision, 4);
  const records = await store.readSnapshot(userId);
  assert.equal(records.records.length, 2);
  assert.ok(records.records.every((record) => record.state.deleted === true));
});

test("concurrent accepted-pair updates serialize and retain an exact final bundle", async () => {
  const userId = await account();
  const track = "aws-certified-solutions-architect-associate";
  await store.applyBatch(userId, 1, deviceId, 0, goalPlanPair(track, "2027-09-09"), metadata(50));
  const left = goalPlanPair(track, "2027-10-10", 2, 2);
  const right = goalPlanPair(track, "2027-11-11", 2, 2);
  const [leftResult, rightResult] = await Promise.all([
    store.applyBatch(userId, 1, deviceId, 2, left, metadata(51)),
    store.applyBatch(userId, 1, deviceId, 2, right, metadata(52)),
  ]);
  const successful = [leftResult, rightResult].filter((result) => result.applied.length === 2);
  const conflicted = [leftResult, rightResult].filter((result) => result.accountRevisionConflict?.code === "account_revision_conflict");
  assert.equal(successful.length, 1);
  assert.equal(conflicted.length, 1);
  const snapshot = await store.readSnapshot(userId);
  const goal = snapshot.records.find((record) => record.recordType === "goal")!;
  const plan = snapshot.records.find((record) => record.recordType === "learning_plan")!;
  const targetDate = (goal.state.record as { targetDate?: string }).targetDate;
  assert.equal((plan.state.plan as { acceptedTarget: { targetDate: string } }).acceptedTarget.targetDate, targetDate);
  assert.equal((plan.state.plan as { goalRevision: number }).goalRevision, (goal.state as { revision: number }).revision);
});

test("a plan-only update validates against the current goal counterpart", async () => {
  const userId = await account();
  const track = "aws-certified-solutions-architect-associate";
  await store.applyBatch(userId, 1, deviceId, 0, goalPlanPair(track, "2027-09-09"), metadata(55));
  await store.applyBatch(userId, 1, deviceId, 2, goalPlanPair(track, "2027-10-10", 2, 2), metadata(56));
  const stalePlanUpdate = goalPlanMutation("learning_plan", track, planState(track, "2027-09-09", 2, 3), 2);
  await assert.rejects(() => store.applyBatch(userId, 1, deviceId, 4, [stalePlanUpdate], metadata(57)), { message: "goal_plan_bundle_invalid" });
  const snapshot = await store.readSnapshot(userId);
  assert.equal(snapshot.accountRevision, 4);
  const goal = snapshot.records.find((record) => record.recordType === "goal")!;
  const plan = snapshot.records.find((record) => record.recordType === "learning_plan")!;
  assert.equal((goal.state.record as { targetDate: string }).targetDate, "2027-10-10");
  assert.equal((plan.state.plan as { acceptedTarget: { targetDate: string } }).acceptedTarget.targetDate, "2027-10-10");
});

test("identical batch replay remains stable after a later accepted-pair revision", async () => {
  const userId = await account();
  const track = "aws-certified-solutions-architect-associate";
  const originalMutations = goalPlanPair(track, "2027-09-09");
  const original = await store.applyBatch(userId, 1, deviceId, 0, originalMutations, metadata(60));
  await store.applyBatch(userId, 1, deviceId, 2, goalPlanPair(track, "2027-10-10", 2, 2), metadata(61));
  const replay = await store.applyBatch(userId, 1, deviceId, 0, originalMutations, metadata(60));
  assert.deepEqual(replay, original);
  assert.equal((await store.readSnapshot(userId)).accountRevision, 4);
});
