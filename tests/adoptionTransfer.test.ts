import assert from "node:assert/strict";
import test from "node:test";

import {
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
  adoptionTransferRecordKey,
  markAdoptionPreviewReady,
  sealAdoptionTransfer,
} from "../src/modules/users/adoptionTransfer.js";
import { buildGuestMergePreview, createMergeRecordFingerprint } from "../src/modules/users/merge.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const guestUserId = "22222222-2222-4222-8222-222222222222";
const trackId = "coding-interview-dsa-problem-solving";

function record(recordType: string, recordId: string): Readonly<{ recordType: string; recordId: string; trackId: string; fingerprint: string; state: Readonly<Record<string, unknown>>; version: number }> {
  return { recordType, recordId, trackId, fingerprint: `${recordId}${recordType}`.padEnd(64, "0").slice(0, 64), state: { trackId }, version: 0 };
}

test("adoption transfer is resumable, sealed by canonical digest, and decisions are immutable", () => {
  let transfer = createAdoptionTransfer({ accountId, sessionId: "session-1", guestUserId, snapshotVersion: 3, expectedGeneration: 4 });
  const goal = record("goal", trackId);
  const plan = record("learning_plan", trackId);
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

test("adoption result chunks never split a track goal-plan group", () => {
  const goal = record("goal", trackId);
  const plan = record("learning_plan", trackId);
  const chunks = buildAdoptionResultChunks([goal, plan]);
  assert.equal(chunks.length, 1);
  assert.throws(() => buildAdoptionResultChunks([goal]), /adoption_transfer_track_group_incomplete/u);
});

test("adoption transfer rejects a stale seal and generation flip", () => {
  const transfer = createAdoptionTransfer({ accountId, sessionId: "session-2", guestUserId, snapshotVersion: 1, expectedGeneration: 2 });
  assert.throws(() => sealAdoptionTransfer(transfer, { snapshotFingerprint: "a".repeat(64), recordCount: 0, chunkCount: 0 }), /adoption_transfer_snapshot_seal_mismatch/u);
  assert.throws(() => beginAdoptionApply(transfer, 1), /adoption_transfer_generation_conflict/u);
});

test("protocol-v3 seal canonicalizes record-key order and keeps full track identity", () => {
  const firstBase = { recordType: "active_track" as const, recordId: "shared-record", trackId, state: { trackId }, version: 0 };
  const first = { ...firstBase, fingerprint: createMergeRecordFingerprint(firstBase) };
  const second = { ...first, trackId: "another-track", fingerprint: createMergeRecordFingerprint({ recordType: "active_track", recordId: "shared-record", trackId: "another-track", state: first.state }) };
  const chunk = { chunkId: "chunk-order", index: 0, recordKeys: [adoptionTransferRecordKey(first), adoptionTransferRecordKey(second)], bytes: 512 } as const;
  const reordered = { ...chunk, recordKeys: [...chunk.recordKeys].reverse() };
  const firstSeal = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records: [first, second], chunks: [{ ...chunk, fingerprint: createAdoptionTransferChunkFingerprint(chunk) }] });
  const secondSeal = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records: [second, first], chunks: [{ ...reordered, fingerprint: createAdoptionTransferChunkFingerprint(reordered) }] });
  assert.equal(firstSeal, secondSeal);

  const preview = buildGuestMergePreview({
    accountUserId: accountId,
    accountSnapshotVersion: 0,
    guestSnapshot: { protocolVersion: 1, guestSnapshotVersion: 1, guestUserId, activeSession: false, pendingJournal: false, records: [first, second] },
    remoteRecords: [],
    identityMode: "full",
  });
  assert.deepEqual([...preview.plan.uploadRecordIds].sort((left, right) => left.localeCompare(right)), [
    adoptionTransferRecordKey(second),
    adoptionTransferRecordKey(first),
  ].sort((left, right) => left.localeCompare(right)));
  assert.equal(preview.preview.conflicts.length, 0);
});

test("protocol-v3 full identity remains collision-safe for separator-bearing ids", () => {
  const firstState = { trackId: "c:d" };
  const secondState = { trackId: "b:c:d" };
  const first = { recordType: "active_track" as const, recordId: "a:b", trackId: "c:d", state: firstState, version: 0, fingerprint: createMergeRecordFingerprint({ recordType: "active_track", recordId: "a:b", trackId: "c:d", state: firstState }) };
  const second = { recordType: "active_track" as const, recordId: "a", trackId: "b:c:d", state: secondState, version: 0, fingerprint: createMergeRecordFingerprint({ recordType: "active_track", recordId: "a", trackId: "b:c:d", state: secondState }) };
  assert.notEqual(adoptionTransferRecordKey(first), adoptionTransferRecordKey(second));
  const preview = buildGuestMergePreview({
    accountUserId: accountId,
    accountSnapshotVersion: 0,
    guestSnapshot: { protocolVersion: 1, guestSnapshotVersion: 1, guestUserId, activeSession: false, pendingJournal: false, records: [first, second] },
    remoteRecords: [],
    identityMode: "full",
  });
  assert.equal(preview.plan.uploadRecordIds.length, 2);
  assert.deepEqual(new Set(preview.plan.uploadRecordIds), new Set([adoptionTransferRecordKey(first), adoptionTransferRecordKey(second)]));
});
