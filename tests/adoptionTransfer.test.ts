import assert from "node:assert/strict";
import test from "node:test";

import {
  adoptionTransferApplySchema,
  adoptionTransferConfirmSchema,
  adoptionTransferRecordSchema,
  adoptionTransferStartSchema,
  adoptionTransferUploadSchema,
  addAdoptionDecision,
  appendAdoptionResultChunk,
  appendAdoptionTransferChunk,
  appendAdoptionTransferRecord,
  beginAdoptionApply,
  beginAdoptionResultBuild,
  buildAdoptionResultChunks,
  completeAdoptionTransfer,
  createAdoptionSnapshotSeal,
  createAdoptionTransfer,
  createAdoptionTransferChunkFingerprint,
  adoptionTransferIdentitySchema,
  adoptionTransferRecordKey,
  markAdoptionPreviewReady,
  sealAdoptionTransfer,
} from "../src/modules/users/adoptionTransfer.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const guestUserId = "22222222-2222-4222-8222-222222222222";
const deviceId = "00000000-0000-4000-8000-000000000000";
const trackId = "coding-interview-dsa-problem-solving";

function record(recordType: "goal" | "learning_plan" | "training_attempt", recordId: string, state: Readonly<Record<string, unknown>> = { trackId }, recordTrackId = trackId): Readonly<{ recordType: "goal" | "learning_plan" | "training_attempt"; recordId: string; trackId: string; fingerprint: string; state: Readonly<Record<string, unknown>>; version: number }> {
  const base = { recordType, recordId, trackId: recordTrackId, state };
  return { ...base, fingerprint: createMergeRecordFingerprint(base), version: 0 };
}

test("canonical transfer requests reject retired marker fields", () => {
  const start = { canonicalVersion: "canonical-json-v1" as const, idempotencyKey: "session-1", guestUserId, snapshotVersion: 3, expectedGeneration: 4, deviceId, activeSession: false, pendingJournal: false };
  assert.equal(adoptionTransferStartSchema.safeParse(start).success, true);
  assert.equal(adoptionTransferStartSchema.safeParse({ ...start, protocolVersion: 4 }).success, false);

  const item = record("training_attempt", "attempt-1", { result: "correct" });
  const chunkBase = { chunkId: "chunk-0", index: 0, recordKeys: [adoptionTransferRecordKey(item)], bytes: 128 } as const;
  const upload = { canonicalVersion: "canonical-json-v1" as const, deviceId, chunk: { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) }, records: [item] };
  assert.equal(adoptionTransferRecordSchema.safeParse(item).success, true);
  assert.equal(adoptionTransferRecordSchema.safeParse({ ...item, recordType: "unsupported_record" }).success, false);
  assert.equal(adoptionTransferUploadSchema.safeParse(upload).success, true);
  assert.equal(adoptionTransferUploadSchema.safeParse({ ...upload, contentIdentitySchema: "retired" }).success, false);
  assert.equal(adoptionTransferApplySchema.safeParse({ canonicalVersion: "canonical-json-v1", deviceId }).success, true);
  assert.equal(adoptionTransferConfirmSchema.safeParse({ canonicalVersion: "canonical-json-v1", deviceId, previewFingerprint: "a".repeat(64), resolutions: [], groupChoices: [] }).success, true);
});

test("transfer identity fields accept long IDs while chunk and envelope budgets remain bounded", () => {
  const longRecordId = "record-" + "r".repeat(500);
  const longTrackId = "track-" + "t".repeat(300);
  const item = record("training_attempt", longRecordId, { result: "correct" }, longTrackId);
  const identity = { recordType: item.recordType, recordId: item.recordId, trackId: item.trackId };
  assert.equal(adoptionTransferIdentitySchema.safeParse(identity).success, true);
  assert.equal(adoptionTransferRecordSchema.safeParse(item).success, true);

  const chunkBase = { chunkId: "chunk-long-identity", index: 0, recordKeys: [adoptionTransferRecordKey(item)], bytes: 128 } as const;
  const upload = { canonicalVersion: "canonical-json-v1" as const, deviceId, chunk: { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) }, records: [item] };
  assert.equal(adoptionTransferUploadSchema.safeParse(upload).success, true);
  assert.equal(adoptionTransferConfirmSchema.safeParse({
    canonicalVersion: "canonical-json-v1",
    deviceId,
    previewFingerprint: "a".repeat(64),
    resolutions: [{ conflictId: adoptionTransferRecordKey(item), resolution: "keep_guest" }],
    groupChoices: [{ groupId: `track:${longTrackId}`, resolution: "keep_guest" }],
  }).success, true);
});

test("transfer is resumable, sealed by canonical digest, and decisions remain immutable", () => {
  let transfer = createAdoptionTransfer({ accountId, sessionId: "session-1", guestUserId, snapshotVersion: 3, expectedGeneration: 4 });
  const goal = record("goal", trackId);
  const plan = record("learning_plan", trackId, { schemaVersion: 1, revision: 2, plan: { schemaVersion: 1, planId: "plan-1", trackId, goalRevision: 1, status: "accepted", timezone: "Europe/Warsaw", contentVersion: "content-v1", artifactSha256: "a".repeat(64), acceptedTarget: { meaning: "event", targetDate: "2027-09-09" }, createdAt: "2026-09-09T08:00:00.000Z", updatedAt: "2026-09-09T08:00:00.000Z", planRevision: 2, commandId: "command-1", slots: [{ slotId: "slot-1", day: "mon", localTime: "18:00", sessionLength: 10 }] } });
  transfer = appendAdoptionTransferRecord(transfer, goal);
  transfer = appendAdoptionTransferRecord(transfer, plan);
  const chunkBase = { chunkId: "chunk-0", index: 0, recordKeys: [adoptionTransferRecordKey(goal), adoptionTransferRecordKey(plan)], bytes: 256 } as const;
  transfer = appendAdoptionTransferChunk(transfer, { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) });
  const seal = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 3, records: [goal, plan], chunks: transfer.chunks });
  transfer = sealAdoptionTransfer(transfer, { snapshotFingerprint: seal, recordCount: 2, chunkCount: 1 });
  transfer = beginAdoptionResultBuild(transfer);
  transfer = appendAdoptionResultChunk(transfer, { chunkId: "result-0", index: 0, recordKeys: chunkBase.recordKeys, fingerprint: "a".repeat(64) });
  transfer = markAdoptionPreviewReady(transfer);
  transfer = addAdoptionDecision(transfer, { decisionId: "decision-0", identity: { recordType: "goal", recordId: trackId, trackId }, resolution: "keep_guest", previewFingerprint: seal });
  transfer = beginAdoptionApply(transfer, 4);
  transfer = completeAdoptionTransfer(transfer, 4, 5);
  assert.equal(transfer.state, "complete");
  assert.equal(transfer.generation, 5);
  assert.deepEqual(appendAdoptionTransferRecord(transfer, goal, "session-1"), transfer);
});

test("result chunks keep goal and plan records together and keys include the full identity", () => {
  const goal = record("goal", trackId);
  const plan = record("learning_plan", trackId);
  assert.equal(buildAdoptionResultChunks([goal, plan]).length, 1);
  assert.throws(() => buildAdoptionResultChunks([goal]), /adoption_transfer_track_group_incomplete/u);

  const first = record("training_attempt", "a:b", { trackId: "c:d" });
  const second = record("training_attempt", "a", { trackId: "b:c:d" });
  assert.notEqual(adoptionTransferRecordKey(first), adoptionTransferRecordKey(second));
});

test("stale seals and generation flips are rejected", () => {
  const transfer = createAdoptionTransfer({ accountId, sessionId: "session-2", guestUserId, snapshotVersion: 1, expectedGeneration: 2 });
  assert.throws(() => sealAdoptionTransfer(transfer, { snapshotFingerprint: "a".repeat(64), recordCount: 0, chunkCount: 0 }), /adoption_transfer_snapshot_seal_mismatch/u);
  assert.throws(() => beginAdoptionApply(transfer, 1), /adoption_transfer_generation_conflict/u);
});
