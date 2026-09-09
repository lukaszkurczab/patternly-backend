import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGuestMergePreview,
  createMergeRecordFingerprint,
  guestMergeConfirmationSchema,
  guestMergeSnapshotSchema,
  validateGuestMergeConfirmation,
  type GuestMergeRecord,
} from "../src/modules/users/merge.js";

const accountUserId = "11111111-1111-4111-8111-111111111111";
const guestUserId = "22222222-2222-4222-8222-222222222222";

function record(input: Readonly<{ recordId: string; state: Readonly<Record<string, unknown>>; version?: number }>): GuestMergeRecord {
  const base = { recordId: input.recordId, recordType: "training_attempt" as const, state: input.state, trackId: "coding-interview-dsa-problem-solving" };
  return { ...base, fingerprint: createMergeRecordFingerprint(base), version: input.version ?? 0 };
}

function snapshot(records: readonly GuestMergeRecord[], flags: Readonly<{ activeSession?: boolean; pendingJournal?: boolean }> = {}) {
  return guestMergeSnapshotSchema.parse({ guestSnapshotVersion: 7, guestUserId, records, activeSession: flags.activeSession ?? false, pendingJournal: flags.pendingJournal ?? false });
}

function previewFor(local: readonly GuestMergeRecord[], remote: readonly GuestMergeRecord[], flags: Readonly<{ activeSession?: boolean; pendingJournal?: boolean }> = {}) {
  return buildGuestMergePreview({ accountUserId, accountSnapshotVersion: 4, guestSnapshot: snapshot(local, flags), remoteRecords: remote });
}

const track = "coding-interview-dsa-problem-solving";
function goalRecord(goalType = "prepare_for_an_interview", envelopeRevision = 3, version = 0): GuestMergeRecord {
  const state = { schemaVersion: 1, revision: envelopeRevision, record: { goalType, preferredDays: ["mon", "wed", "sat"], status: "active", targetDate: "2027-09-09", trackId: track, weeklySessionTarget: 3 } };
  const base = { recordId: track, recordType: "goal" as const, state, trackId: track };
  return { ...base, fingerprint: createMergeRecordFingerprint(base), version };
}
function planRecord(time = "18:00", goalRevision = 3, version = 0): GuestMergeRecord {
  const state = { schemaVersion: 1, revision: 2, plan: { schemaVersion: 1, planId: "plan-1", trackId: track, goalRevision, status: "accepted", timezone: "Europe/Warsaw", contentVersion: "content-v1", contentPackagePin: { packageIdentity: "pkg", packageVersion: "1", contentReleaseId: "release" }, acceptedTarget: { meaning: "event", targetDate: "2027-09-09" }, createdAt: "2026-09-09T08:00:00.000Z", updatedAt: "2026-09-09T08:00:00.000Z", planRevision: 2, commandId: "command-1", slots: [{ slotId: "slot-1", day: "mon", localTime: time, sessionLength: 10 }] } };
  const base = { recordId: track, recordType: "learning_plan" as const, state, trackId: track };
  return { ...base, fingerprint: createMergeRecordFingerprint(base), version };
}
function tombstone(recordType: "goal" | "learning_plan", version = 0): GuestMergeRecord {
  const state = { deleted: true };
  const base = { recordId: track, recordType, state, trackId: track };
  return { ...base, fingerprint: createMergeRecordFingerprint(base), version };
}
function previewV2(local: readonly GuestMergeRecord[], remote: readonly GuestMergeRecord[]) {
  return buildGuestMergePreview({ accountUserId, accountSnapshotVersion: 8, guestSnapshot: { protocolVersion: 2, guestSnapshotVersion: 9, guestUserId, records: [...local], activeSession: false, pendingJournal: false }, remoteRecords: remote });
}

test("adoption preview covers empty, upload, restore, identical and divergent datasets", () => {
  const local = record({ recordId: "attempt-1", state: { result: "correct" } });
  const remote = record({ recordId: "attempt-2", state: { result: "incorrect" }, version: 2 });
  assert.equal(previewFor([], []).plan.caseId, "emptyLocalEmptyRemote");
  assert.deepEqual(previewFor([local], []).plan, { caseId: "populatedLocalEmptyRemote", localRecordCount: 1, remoteRecordCount: 0, uploadRecordIds: ["training_attempt:attempt-1"], restoreRecordIds: [], deduplicatedRecordIds: [], conflictRecordIds: [], blockingReason: null });
  assert.deepEqual(previewFor([], [remote]).plan.restoreRecordIds, ["training_attempt:attempt-2"]);
  assert.equal(previewFor([local], [local]).plan.deduplicatedRecordIds[0], "training_attempt:attempt-1");
  const divergent = previewFor([local], [record({ recordId: local.recordId, state: { result: "incorrect" }, version: 3 })]);
  assert.equal(divergent.plan.caseId, "divergentRecord");
  assert.deepEqual(divergent.plan.conflictRecordIds, ["training_attempt:attempt-1"]);
  assert.equal(divergent.preview.conflicts[0]?.accountVersion, 3);
});

test("active sessions and recovery journals block adoption before account binding", () => {
  assert.equal(previewFor([], [], { activeSession: true }).plan.blockingReason, "active_session");
  assert.equal(previewFor([], [], { pendingJournal: true }).plan.blockingReason, "journal_recovery");
  assert.equal(previewFor([], [], { activeSession: true }).plan.caseId, "blocked");
});

test("guest merge requires an explicit resolution for every preview conflict", () => {
  const adoption = previewFor([record({ recordId: "attempt-1", state: { result: "correct" }, version: 3 })], [record({ recordId: "attempt-1", state: { result: "incorrect" }, version: 2 })]);
  const conflictId = adoption.preview.conflicts[0]!.conflictId;
  const confirmation = guestMergeConfirmationSchema.parse({ operationId: adoption.preview.operationId, previewFingerprint: adoption.preview.fingerprint, protocolVersion: 1, resolutions: [{ conflictId, resolution: "keep_guest" }] });
  assert.deepEqual(validateGuestMergeConfirmation(adoption.preview, confirmation), { confirmation, preview: adoption.preview, status: "ready_to_execute" });
});

test("guest merge rejects stale previews and unresolved conflicts", () => {
  const adoption = previewFor([record({ recordId: "attempt-1", state: { result: "correct" } })], [record({ recordId: "attempt-1", state: { result: "incorrect" } })]);
  const conflictId = adoption.preview.conflicts[0]!.conflictId;
  const stale = guestMergeConfirmationSchema.parse({ operationId: adoption.preview.operationId, previewFingerprint: "b".repeat(64), protocolVersion: 1, resolutions: [{ conflictId, resolution: "keep_account" }] });
  assert.throws(() => validateGuestMergeConfirmation(adoption.preview, stale), { message: "merge_preview_mismatch" });
  const unresolved = guestMergeConfirmationSchema.parse({ operationId: adoption.preview.operationId, previewFingerprint: adoption.preview.fingerprint, protocolVersion: 1, resolutions: [{ conflictId, resolution: "manual_required" }] });
  assert.throws(() => validateGuestMergeConfirmation(adoption.preview, unresolved), { message: "merge_conflict_requires_manual_resolution" });
});

test("v2 groups a divergent goal and plan once per track and requires exactly one group choice", () => {
  const adoption = previewV2([goalRecord(), planRecord("18:00")], [goalRecord("build_foundations", 4, 2), planRecord("20:00", 4, 2)]);
  assert.equal(adoption.preview.protocolVersion, 2);
  if (adoption.preview.protocolVersion !== 2) assert.fail("expected v2");
  assert.deepEqual(adoption.preview.goalPlanConflictGroups, [{ groupId: `track:${track}`, trackId: track, localRecordIds: [`goal:${track}`, `learning_plan:${track}`], accountRecordIds: [`goal:${track}`, `learning_plan:${track}`] }]);
  assert.deepEqual(adoption.plan.conflictRecordIds, []);
  assert.throws(() => validateGuestMergeConfirmation(adoption.preview, guestMergeConfirmationSchema.parse({ protocolVersion: 2, operationId: adoption.preview.operationId, previewFingerprint: adoption.preview.fingerprint, resolutions: [], groupChoices: [] })), { message: "merge_group_choice_incomplete" });
  const confirmation = guestMergeConfirmationSchema.parse({ protocolVersion: 2, operationId: adoption.preview.operationId, previewFingerprint: adoption.preview.fingerprint, resolutions: [], groupChoices: [{ groupId: `track:${track}`, resolution: "keep_guest" }] });
  assert.equal(validateGuestMergeConfirmation(adoption.preview, confirmation).status, "ready_to_execute");
});

test("v2 uploads, restores and deduplicates complete goal-plan bundles without a choice", () => {
  assert.deepEqual(previewV2([goalRecord(), planRecord()], []).plan.uploadRecordIds, [`goal:${track}`, `learning_plan:${track}`]);
  assert.deepEqual(previewV2([], [goalRecord(), planRecord()]).plan.restoreRecordIds, [`goal:${track}`, `learning_plan:${track}`]);
  assert.deepEqual(previewV2([goalRecord(), planRecord()], [goalRecord(), planRecord()]).plan.deduplicatedRecordIds, [`goal:${track}`, `learning_plan:${track}`]);
});

test("v2 treats a tombstone and a live goal-plan state as one explicit track conflict", () => {
  const accountDeleted = [tombstone("goal", 2), tombstone("learning_plan", 2)];
  const adoption = previewV2([goalRecord(), planRecord()], accountDeleted);
  assert.equal(adoption.preview.protocolVersion, 2);
  if (adoption.preview.protocolVersion !== 2) assert.fail("expected v2");
  assert.deepEqual(adoption.preview.goalPlanConflictGroups, [{ groupId: `track:${track}`, trackId: track, localRecordIds: [`goal:${track}`, `learning_plan:${track}`], accountRecordIds: [`goal:${track}`, `learning_plan:${track}`] }]);
  assert.deepEqual(adoption.plan.uploadRecordIds, []);
  assert.deepEqual(adoption.plan.conflictRecordIds, []);
});

test("v2 deduplicates identical tombstones and restores a one-sided account tombstone", () => {
  const deleted = [tombstone("goal", 2), tombstone("learning_plan", 2)];
  assert.deepEqual(previewV2(deleted, deleted).plan.deduplicatedRecordIds, [`goal:${track}`, `learning_plan:${track}`]);
  assert.deepEqual(previewV2([], deleted).plan.restoreRecordIds, [`goal:${track}`, `learning_plan:${track}`]);
});

test("v2 rejects malformed or mixed goal-plan identity before preview", () => {
  assert.throws(() => previewV2([planRecord()], []), { message: "goal_plan_bundle_invalid" });
  assert.throws(() => previewV2([goalRecord(), planRecord("18:00", 4)], []), { message: "goal_plan_bundle_invalid" });
  const damaged = planRecord();
  const badState = { ...(damaged.state as Record<string, unknown>), plan: { ...((damaged.state as { plan: Record<string, unknown> }).plan), contentPackagePin: { packageIdentity: "pkg", packageVersion: "1" } } };
  const base = { ...damaged, state: badState };
  assert.throws(() => previewV2([{ ...base, fingerprint: createMergeRecordFingerprint(base) }], []), { message: "goal_plan_bundle_invalid" });
});

test("v1 rejects v2 records and keeps its original preview shape", () => {
  assert.equal(guestMergeSnapshotSchema.safeParse({ protocolVersion: 1, guestSnapshotVersion: 1, guestUserId, records: [goalRecord()], activeSession: false, pendingJournal: false }).success, false);
  const adoption = previewFor([], [goalRecord()]);
  assert.equal(adoption.preview.protocolVersion, 1);
  assert.equal("goalPlanConflictGroups" in adoption.preview, false);
  assert.equal(adoption.plan.remoteRecordCount, 0);
});
