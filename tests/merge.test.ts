import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGuestMergePreview,
  createMergeRecordFingerprint,
  goalPlanConflictGroupSchema,
  goalPlanGroupChoiceSchema,
  guestMergeConfirmationSchema,
  guestMergeConflictSchema,
  guestMergeRecordSchema,
  guestMergeSnapshotSchema,
  mergeRecordKey,
  validateGuestMergeConfirmation,
  type GuestMergeRecord,
} from "../src/modules/users/merge.js";

const accountUserId = "11111111-1111-4111-8111-111111111111";
const guestUserId = "22222222-2222-4222-8222-222222222222";
const track = "coding-interview-dsa-problem-solving";

function record(input: Readonly<{ recordId: string; state: Readonly<Record<string, unknown>>; trackId?: string; version?: number; recordType?: GuestMergeRecord["recordType"] }>): GuestMergeRecord {
  const base = { recordId: input.recordId, recordType: input.recordType ?? "training_attempt", state: input.state, trackId: input.trackId ?? track };
  return { ...base, fingerprint: createMergeRecordFingerprint(base), version: input.version ?? 0 };
}

function snapshot(records: readonly GuestMergeRecord[], flags: Readonly<{ activeSession?: boolean; pendingJournal?: boolean }> = {}) {
  return guestMergeSnapshotSchema.parse({ guestSnapshotVersion: 7, guestUserId, records: [...records], activeSession: flags.activeSession ?? false, pendingJournal: flags.pendingJournal ?? false });
}

function previewFor(local: readonly GuestMergeRecord[], remote: readonly GuestMergeRecord[], flags: Readonly<{ activeSession?: boolean; pendingJournal?: boolean }> = {}) {
  return buildGuestMergePreview({ accountUserId, accountSnapshotVersion: 4, guestSnapshot: snapshot(local, flags), remoteRecords: remote });
}

function goalRecord(goalType = "prepare_for_an_interview", revision = 3, version = 0): GuestMergeRecord {
  const state = { schemaVersion: 1, revision, record: { goalType, preferredDays: ["mon", "wed", "sat"], status: "active", targetDate: "2027-09-09", trackId: track, weeklySessionTarget: 3 } };
  const base = { recordId: track, recordType: "goal" as const, state, trackId: track };
  return { ...base, fingerprint: createMergeRecordFingerprint(base), version };
}

function planRecord(time = "18:00", goalRevision = 3, version = 0): GuestMergeRecord {
  const state = { schemaVersion: 1, revision: 2, plan: { schemaVersion: 1, planId: "plan-1", trackId: track, goalRevision, status: "accepted", timezone: "Europe/Warsaw", contentVersion: "content-v1", artifactSha256: "a".repeat(64), acceptedTarget: { meaning: "event", targetDate: "2027-09-09" }, createdAt: "2026-09-09T08:00:00.000Z", updatedAt: "2026-09-09T08:00:00.000Z", planRevision: 2, commandId: "command-1", slots: [{ slotId: "slot-1", day: "mon", localTime: time, sessionLength: 10 }] } };
  const base = { recordId: track, recordType: "learning_plan" as const, state, trackId: track };
  return { ...base, fingerprint: createMergeRecordFingerprint(base), version };
}

test("preview identifies upload, restore, deduplication and divergent records", () => {
  const local = record({ recordId: "attempt-1", state: { result: "correct" } });
  const remote = record({ recordId: "attempt-2", state: { result: "incorrect" }, version: 2 });
  assert.equal(previewFor([], []).plan.caseId, "emptyLocalEmptyRemote");
  assert.deepEqual(previewFor([local], []).plan.uploadRecordIds, [mergeRecordKey(local)]);
  assert.deepEqual(previewFor([], [remote]).plan.restoreRecordIds, [mergeRecordKey(remote)]);
  assert.deepEqual(previewFor([local], [local]).plan.deduplicatedRecordIds, [mergeRecordKey(local)]);
  const divergent = previewFor([local], [record({ recordId: local.recordId, state: { result: "incorrect" }, version: 3 })]);
  assert.equal(divergent.plan.caseId, "divergentRecord");
  assert.deepEqual(divergent.plan.conflictRecordIds, [mergeRecordKey(local)]);
});

test("active sessions and recovery journals block adoption", () => {
  assert.equal(previewFor([], [], { activeSession: true }).plan.blockingReason, "active_session");
  assert.equal(previewFor([], [], { pendingJournal: true }).plan.blockingReason, "journal_recovery");
});

test("confirmation requires every conflict and every goal plan group", () => {
  const adoption = previewFor([record({ recordId: "attempt-1", state: { result: "correct" } })], [record({ recordId: "attempt-1", state: { result: "incorrect" }, version: 2 })]);
  const conflictId = adoption.preview.conflicts[0]!.conflictId;
  const confirmation = guestMergeConfirmationSchema.parse({ operationId: adoption.preview.operationId, previewFingerprint: adoption.preview.fingerprint, resolutions: [{ conflictId, resolution: "keep_guest" }], groupChoices: [] });
  assert.equal(validateGuestMergeConfirmation(adoption.preview, confirmation).status, "ready_to_execute");

  const grouped = previewFor([goalRecord(), planRecord()], [goalRecord("build_foundations", 4, 2), planRecord("20:00", 4, 2)]);
  assert.deepEqual(grouped.preview.goalPlanConflictGroups.map((group) => group.groupId), [`track:${track}`]);
  assert.throws(() => validateGuestMergeConfirmation(grouped.preview, guestMergeConfirmationSchema.parse({ operationId: grouped.preview.operationId, previewFingerprint: grouped.preview.fingerprint, resolutions: [], groupChoices: [] })), { message: "merge_group_choice_incomplete" });
  const accepted = guestMergeConfirmationSchema.parse({ operationId: grouped.preview.operationId, previewFingerprint: grouped.preview.fingerprint, resolutions: [], groupChoices: [{ groupId: `track:${track}`, resolution: "keep_guest" }] });
  assert.equal(validateGuestMergeConfirmation(grouped.preview, accepted).status, "ready_to_execute");
});

test("full identity keys remain collision safe across tracks", () => {
  const first = record({ recordId: "a:b", state: { track: "c:d" } });
  const second = record({ recordId: "a", state: { track: "b:c:d" } });
  assert.notEqual(mergeRecordKey(first), mergeRecordKey(second));
  assert.equal(previewFor([first, second], []).plan.uploadRecordIds.length, 2);
});

test("merge identity fields accept long IDs through preview and confirmation", () => {
  const longRecordId = "record-" + "r".repeat(500);
  const longTrackId = "track-" + "t".repeat(300);
  const local = record({ recordId: longRecordId, state: { result: "correct" }, trackId: longTrackId });
  const remote = record({ recordId: longRecordId, state: { result: "incorrect" }, trackId: longTrackId, version: 2 });

  assert.equal(guestMergeRecordSchema.safeParse(local).success, true);
  const preview = previewFor([local], [remote]);
  const conflict = preview.preview.conflicts[0]!;
  assert.equal(conflict.conflictId.length > 768, true);
  assert.equal(guestMergeConflictSchema.safeParse(conflict).success, true);
  assert.equal(guestMergeConfirmationSchema.safeParse({
    operationId: preview.preview.operationId,
    previewFingerprint: preview.preview.fingerprint,
    resolutions: [{ conflictId: conflict.conflictId, resolution: "keep_guest" }],
    groupChoices: [],
  }).success, true);

  const group = { groupId: `track:${longTrackId}`, trackId: longTrackId, localRecordIds: [longRecordId], accountRecordIds: [longRecordId] };
  assert.equal(goalPlanConflictGroupSchema.safeParse(group).success, true);
  assert.equal(goalPlanGroupChoiceSchema.safeParse({ groupId: group.groupId, resolution: "keep_guest" }).success, true);
});

test("legacy content identity fields are rejected recursively", () => {
  const base = planRecord();
  const state = { ...(base.state as Record<string, unknown>), nested: { packagePin: "retired" } };
  const damaged = { ...base, state, fingerprint: createMergeRecordFingerprint({ recordId: base.recordId, recordType: base.recordType, state, trackId: base.trackId }) };
  assert.equal(guestMergeSnapshotSchema.safeParse({ guestSnapshotVersion: 1, guestUserId, records: [damaged], activeSession: false, pendingJournal: false }).success, false);
});
