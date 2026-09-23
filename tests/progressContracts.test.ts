import assert from "node:assert/strict";
import test from "node:test";

import {
  createProgressPageToken,
  isSyncRequestWithinBudget,
  parseProgressPageToken,
  progressMutationSchema,
  resolvedContentRefSchema,
  syncRequestSchema,
} from "../src/modules/progress/contracts.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { canonicalJson, canonicalJsonBytes } from "../src/infrastructure/identity/canonicalJson.js";
import { MAX_SERIALIZED_JSON_UTF16_CODE_UNITS } from "../src/modules/progress/serializedJsonLimits.js";

const userId = "22222222-2222-4222-8222-222222222222";
const deviceId = "00000000-0000-4000-8000-000000000000";
const trackId = "coding-interview-dsa-problem-solving";

function mutation(state: Readonly<Record<string, unknown>>, index = 0, overrides: Readonly<{ trackId?: string; targetId?: string }> = {}) {
  const recordId = overrides.targetId ?? `attempt-${index}`;
  const mutationTrackId = overrides.trackId ?? trackId;
  const base = { recordId, recordType: "training_attempt" as const, state, trackId: mutationTrackId };
  return {
    mutationId: `mutation-${String(index).padStart(16, "0")}`,
    kind: "item" as const,
    trackId: mutationTrackId,
    targetId: recordId,
    recordType: base.recordType,
    expectedVersion: null,
    fingerprint: createMergeRecordFingerprint(base),
    state,
  };
}

function request(mutations = [mutation({ result: "correct" })]) {
  return {
    canonicalVersion: "canonical-json-v1" as const,
    expectedAccountRevision: 0,
    deviceId,
    sessionId: "session-1",
    batchId: "session-1:0",
    highWatermark: 1,
    mutations,
  };
}

test("the canonical sync envelope is required and has one mutation shape", () => {
  assert.equal(syncRequestSchema.safeParse(request()).success, true);
  assert.equal(syncRequestSchema.safeParse({ ...request(), planVersion: 4 }).success, false);
  assert.equal(syncRequestSchema.safeParse({ ...request(), deviceId: null }).success, false);
  assert.equal(syncRequestSchema.safeParse({ ...request(), protocolVersion: 4 }).success, false);
  assert.equal(syncRequestSchema.safeParse({ ...request(), contentIdentitySchema: "retired" }).success, false);
  assert.equal(syncRequestSchema.safeParse({ expectedAccountRevision: 0, deviceId, mutations: request().mutations }).success, false);
});

test("canonical tombstones are accepted directly and retired identity markers are rejected recursively", () => {
  const tombstone = {
    kind: "unavailable_active" as const,
    trackId,
    questionId: "q-1",
    contentVersion: "2026.09.1",
    reason: "stale_content_version" as const,
    sessionId: "session-1",
  };
  assert.equal(progressMutationSchema.safeParse(mutation({ identity: tombstone })).success, true);
  assert.equal(progressMutationSchema.safeParse(mutation({ identity: { kind: "tombstone", tombstone } })).success, true);
  assert.equal(progressMutationSchema.safeParse(mutation({ identity: { ...tombstone, migrationVersion: 1, legacyIdentityDigest: "a".repeat(64) } })).success, false);
  for (const key of ["protocolVersion", "contentIdentitySchema", "migrationVersion", "legacyIdentityDigest"]) {
    assert.equal(progressMutationSchema.safeParse(mutation({ nested: { identity: { [key]: 1 } } })).success, false, key);
  }
});

test("resolved material identity is exact and remains part of the mutation fingerprint", () => {
  const state = {
    answer: {
      trackId,
      questionId: "q-1",
      contentVersion: "2026.09.1",
      artifactSha256: "a".repeat(64),
    },
  };
  const valid = mutation(state);
  assert.equal(progressMutationSchema.safeParse(valid).success, true);
  assert.equal(progressMutationSchema.safeParse({ ...valid, fingerprint: "b".repeat(64) }).success, true);
  assert.equal(progressMutationSchema.safeParse({ ...valid, state: { answer: { ...state.answer, artifactSha256: "bad" } } }).success, false);
  assert.equal(progressMutationSchema.safeParse({ ...valid, state: { answer: { ...state.answer, contentPackagePin: "retired" } } }).success, false);
  assert.equal(progressMutationSchema.safeParse({ ...valid, state: { answer: { ...state.answer, itemId: "retired" } } }).success, false);
});

test("resolved material identity uses the canonical safe identity rules", () => {
  const valid = { trackId, questionId: "q-1", contentVersion: "2026.09.1", artifactSha256: "a".repeat(64) };
  assert.equal(resolvedContentRefSchema.safeParse({ ...valid, questionId: "question with internal space" }).success, true);
  assert.equal(resolvedContentRefSchema.safeParse({ ...valid, questionId: "q".repeat(257) }).success, true);
  assert.equal(progressMutationSchema.safeParse(mutation({ identity: { ...valid, questionId: "q".repeat(257) } })).success, true);
  for (const [field, invalid] of [
    ["trackId", "/track"],
    ["questionId", "question/1"],
    ["contentVersion", "content\\version"],
    ["trackId", "\u0000track"],
    ["questionId", "."],
    ["contentVersion", ".."],
    ["trackId", " track"],
    ["questionId", "question "],
    ["contentVersion", "\u00A0content"],
  ] as const) {
    assert.equal(resolvedContentRefSchema.safeParse({ ...valid, [field]: invalid }).success, false, `${field}:${JSON.stringify(invalid)}`);
  }
});

test("sync identities are bounded by the canonical envelope rather than arbitrary field caps", () => {
  const longMutation = mutation({ result: "correct" }, 0, { trackId: "track".repeat(50), targetId: "target".repeat(50) });
  assert.ok(longMutation.trackId.length > 128);
  assert.ok(longMutation.targetId.length > 256);
  assert.equal(progressMutationSchema.safeParse(longMutation).success, true);
  assert.equal(syncRequestSchema.safeParse(request([longMutation])).success, true);
  assert.equal(isSyncRequestWithinBudget(request([longMutation])), true);
});

test("sync and state limits are enforced without a compatibility branch", () => {
  const emptyStateLength = JSON.stringify({ value: "" }).length;
  const atLimit = { value: "x".repeat(MAX_SERIALIZED_JSON_UTF16_CODE_UNITS - emptyStateLength) };
  const overLimit = { value: `${atLimit.value}x` };
  assert.equal(progressMutationSchema.safeParse(mutation(atLimit)).success, true);
  assert.equal(progressMutationSchema.safeParse(mutation(overLimit)).success, false);

  const records = Array.from({ length: 100 }, (_, index) => mutation({}, index));
  assert.equal(isSyncRequestWithinBudget(request(records)), true);
  assert.equal(syncRequestSchema.safeParse(request([...records, mutation({}, 100)])).success, false);
});

test("pagination tokens contain only generation, revision and cursor identity", () => {
  const token = createProgressPageToken({ version: 1, userId, generation: 2, accountRevision: 3, cursor: "cursor" });
  assert.deepEqual(parseProgressPageToken(token), { version: 1, userId, generation: 2, accountRevision: 3, cursor: "cursor" });
  const [encoded, checksum] = token.split(".");
  const payload = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")) as Record<string, unknown>;
  payload.protocolVersion = 4;
  const tampered = `${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${checksum}`;
  assert.throws(() => parseProgressPageToken(tampered), /progress_pagination_token_invalid/u);
});

test("canonical JSON uses NFC normalization and UTF-8 byte accounting", () => {
  assert.equal(canonicalJson({ "e\u0301": "🙂" }), canonicalJson({ "é": "🙂" }));
  assert.throws(() => canonicalJson({ "e\u0301": 1, "é": 2 }), /canonical_json_duplicate_key/u);
  assert.throws(() => canonicalJson({ value: Number.NaN }), /canonical_json_non_finite_number/u);
  assert.ok(canonicalJsonBytes({ value: "🙂" }) > JSON.stringify({ value: "🙂" }).length);
});
