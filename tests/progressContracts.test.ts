import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  guestMergeRecordSchema,
  guestMergeSnapshotSchema,
} from "../src/modules/users/merge.js";
import {
  isSyncRequestWithinBudget,
  progressMutationSchema,
  syncRequestSchema,
} from "../src/modules/progress/contracts.js";
import { canonicalJson, canonicalJsonBytes } from "../src/infrastructure/identity/canonicalJson.js";
import { MAX_SERIALIZED_JSON_UTF16_CODE_UNITS } from "../src/modules/progress/serializedJsonLimits.js";

const guestUserId = "22222222-2222-4222-8222-222222222222";

function stateWithSerializedLength(length: number): Record<string, string> {
  const emptyStateLength = JSON.stringify({ value: "" }).length;
  return { value: "x".repeat(length - emptyStateLength) };
}

function mutation(state: Readonly<Record<string, unknown>>, index = 0) {
  return {
    mutationId: `mutation-${String(index).padStart(16, "0")}`,
    kind: "item" as const,
    recordType: "training_attempt" as const,
    trackId: "coding-interview-dsa-problem-solving",
    targetId: `attempt-${index}`,
    expectedVersion: null,
    fingerprint: "a".repeat(64),
    state,
  };
}

function mergeRecord(state: Readonly<Record<string, unknown>>, index = 0) {
  return {
    fingerprint: "a".repeat(64),
    recordId: `attempt-${index}`,
    recordType: "training_attempt" as const,
    state,
    trackId: "coding-interview-dsa-problem-solving",
    version: 0,
  };
}

test("progress and guest merge states accept the shared UTF-16 limit and reject one unit over", () => {
  const atLimit = stateWithSerializedLength(MAX_SERIALIZED_JSON_UTF16_CODE_UNITS);
  const overLimit = stateWithSerializedLength(MAX_SERIALIZED_JSON_UTF16_CODE_UNITS + 1);
  const unicodeAtLimit = { value: "🙂".repeat(atLimit.value!.length / 2) };
  assert.equal(JSON.stringify(unicodeAtLimit).length, MAX_SERIALIZED_JSON_UTF16_CODE_UNITS);
  assert.ok(Buffer.byteLength(JSON.stringify(unicodeAtLimit), "utf8") > MAX_SERIALIZED_JSON_UTF16_CODE_UNITS);
  assert.equal(progressMutationSchema.safeParse(mutation(unicodeAtLimit)).success, true);
  assert.equal(guestMergeRecordSchema.safeParse(mergeRecord(unicodeAtLimit)).success, true);

  assert.equal(JSON.stringify(atLimit).length, MAX_SERIALIZED_JSON_UTF16_CODE_UNITS);
  assert.equal(JSON.stringify(overLimit).length, MAX_SERIALIZED_JSON_UTF16_CODE_UNITS + 1);
  assert.equal(progressMutationSchema.safeParse(mutation(atLimit)).success, true);
  assert.equal(progressMutationSchema.safeParse(mutation(overLimit)).success, false);
  assert.equal(guestMergeRecordSchema.safeParse(mergeRecord(atLimit)).success, true);
  assert.equal(guestMergeRecordSchema.safeParse(mergeRecord(overLimit)).success, false);
});

test("sync and guest merge collection caps remain 100 and 1000", () => {
  const mutations = Array.from({ length: 100 }, (_, index) => mutation({}, index));
  assert.equal(syncRequestSchema.safeParse({ expectedAccountRevision: 0, deviceId: null, mutations }).success, true);
  assert.equal(syncRequestSchema.safeParse({ expectedAccountRevision: 0, deviceId: null, mutations: [...mutations, mutation({}, 100)] }).success, false);

  const records = Array.from({ length: 1_000 }, (_, index) => mergeRecord({}, index));
  const snapshot = { guestSnapshotVersion: 1, guestUserId, records, activeSession: false, pendingJournal: false };
  assert.equal(guestMergeSnapshotSchema.safeParse(snapshot).success, true);
  assert.equal(guestMergeSnapshotSchema.safeParse({ ...snapshot, records: [...records, mergeRecord({}, 1_000)] }).success, false);
});


test("a complete immutable Custom40 plan fits sync and adoption without losing its slots", () => {
  const state = JSON.parse(readFileSync(new URL("./fixtures/coding-custom-40-session.json", import.meta.url), "utf8"));
  const length = JSON.stringify(state).length;
  assert.ok(length > 64 * 1024, "this real plan reproduces the former rejection");
  assert.ok(length <= MAX_SERIALIZED_JSON_UTF16_CODE_UNITS);
  assert.equal(state.actualLength, 40);
  assert.equal(state.conditionalReinsertSlots.length, 36);
  assert.equal(state.packagePin.packageVersion, "coding-interview-dsa-problem-solving-free-node-0005");
  const summary = { ...mutation(state), kind: "node" as const, recordType: "training_session_summary" as const, targetId: state.id };
  const parsedSync = syncRequestSchema.parse({ expectedAccountRevision: 0, mutations: [summary] });
  const parsedMerge = guestMergeSnapshotSchema.parse({ guestSnapshotVersion: 1, guestUserId, activeSession: false, pendingJournal: false, records: [{ ...mergeRecord(state), recordType: "training_session_summary", recordId: state.id }] });
  assert.deepEqual(parsedSync.mutations[0]!.state, state);
  assert.deepEqual(parsedMerge.records[0]!.state, state);
});

test("canonical-json-v1 normalizes NFC, rejects duplicate normalized keys, and uses UTF-8 bytes", () => {
  assert.equal(canonicalJson({ "e\u0301": "🙂" }), canonicalJson({ "é": "🙂" }));
  assert.throws(() => canonicalJson({ "e\u0301": 1, "é": 2 }), /canonical_json_duplicate_key/u);
  assert.throws(() => canonicalJson({ value: Number.NaN }), /canonical_json_non_finite_number/u);
  assert.ok(canonicalJsonBytes({ value: "🙂" }) > JSON.stringify({ value: "🙂" }).length);
});

test("protocol-v3 sync carries durable batch metadata and enforces the complete UTF-8 envelope budget", () => {
  const request = {
    protocolVersion: 3 as const,
    canonicalVersion: "canonical-json-v1" as const,
    expectedAccountRevision: 0,
    deviceId: "00000000-0000-4000-8000-000000000000",
    sessionId: "plan_1",
    batchId: "plan_1:batch:0",
    planVersion: 3 as const,
    highWatermark: 1,
    mutations: [mutation({ value: "🙂" })],
  };
  assert.equal(syncRequestSchema.safeParse(request).success, true);
  assert.equal(syncRequestSchema.safeParse({ ...request, deviceId: null }).success, false);
  assert.equal(syncRequestSchema.safeParse({ ...request, deviceId: undefined }).success, false);
  assert.equal(isSyncRequestWithinBudget(request), true);
  const oversized = { ...request, mutations: [mutation({ value: "x".repeat(520_000) })] };
  assert.equal(syncRequestSchema.safeParse(oversized).success, false);
  assert.equal(isSyncRequestWithinBudget(oversized), false);
});
