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
