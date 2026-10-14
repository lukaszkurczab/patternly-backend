import { attemptState } from "./progressFixtures.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  assertContentIdentityState,
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

function mutation(answer = "correct", index = 0, overrides: Readonly<{ trackId?: string; targetId?: string }> = {}) {
  const recordId = overrides.targetId ?? `attempt-${index}`;
  const mutationTrackId = overrides.trackId ?? trackId;
  const state = attemptState(recordId, mutationTrackId, answer);
  const base = { recordId, recordType: "training_attempt" as const, state, trackId: mutationTrackId };
  return { mutationId: `mutation-${String(index).padStart(16, "0")}`, kind: "item" as const,
    trackId: mutationTrackId, targetId: recordId, recordType: base.recordType, expectedVersion: null, fingerprint: createMergeRecordFingerprint(base), state };
}

function request(mutations = [mutation("correct")]) {
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

test("sync batches require unique mutation ids and record targets", () => {
  const first = mutation("correct", 0, { targetId: "target-1" });
  const sameId = { ...mutation("incorrect", 1, { targetId: "target-2" }), mutationId: first.mutationId };
  const sameTarget = mutation("incorrect", 2, { targetId: "target-1" });

  assert.equal(syncRequestSchema.safeParse(request([first, sameId])).success, false);
  assert.equal(syncRequestSchema.safeParse(request([first, sameTarget])).success, false);
  assert.equal(syncRequestSchema.safeParse(request([first, mutation("incorrect", 3, { trackId: "another-track", targetId: "target-1" })])).success, true);
  assert.equal(syncRequestSchema.safeParse(request([first, mutation("incorrect", 4, { targetId: "target-2" })])).success, true);
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
  assert.doesNotThrow(() => assertContentIdentityState(tombstone));
  assert.equal(progressMutationSchema.safeParse({ ...mutation(), state: { deleted: true } }).success, true);
  assert.doesNotThrow(() => assertContentIdentityState({ kind: "tombstone", tombstone }));
  assert.equal(progressMutationSchema.safeParse({ ...mutation(), state: { identity: { ...tombstone, migrationVersion: 1, legacyIdentityDigest: "a".repeat(64) } } }).success, false);
  for (const key of ["protocolVersion", "contentIdentitySchema", "migrationVersion", "legacyIdentityDigest"]) {
    assert.equal(progressMutationSchema.safeParse({ ...mutation(), state: { nested: { identity: { [key]: 1 } } } }).success, false, key);
  }
});

test("resolved material identity is exact and remains part of the mutation fingerprint", () => {
  const valid = mutation();
  assert.equal(progressMutationSchema.safeParse(valid).success, true);
  assert.equal(progressMutationSchema.safeParse({ ...valid, fingerprint: "b".repeat(64) }).success, true);
  for (const item of [{ ...valid.state.item, artifactSha256: "bad" }, { ...valid.state.item, contentPackagePin: "retired" }, { ...valid.state.item, itemId: "retired" }]) {
    assert.equal(progressMutationSchema.safeParse({ ...valid, state: { ...valid.state, item } }).success, false);
  }
});

test("resolved material identity uses the canonical safe identity rules", () => {
  const valid = { trackId, questionId: "q-1", contentVersion: "2026.09.1", artifactSha256: "a".repeat(64) };
  assert.equal(resolvedContentRefSchema.safeParse({ ...valid, questionId: "question with internal space" }).success, true);
  assert.equal(resolvedContentRefSchema.safeParse({ ...valid, questionId: "q".repeat(257) }).success, true);
  assert.doesNotThrow(() => assertContentIdentityState({ ...valid, questionId: "q".repeat(257) }));
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
  const longMutation = mutation("correct", 0, { trackId: "track".repeat(50), targetId: "target".repeat(50) });
  assert.ok(longMutation.trackId.length > 128);
  assert.ok(longMutation.targetId.length > 256);
  assert.equal(progressMutationSchema.safeParse(longMutation).success, true);
  assert.equal(syncRequestSchema.safeParse(request([longMutation])).success, true);
  assert.equal(isSyncRequestWithinBudget(request([longMutation])), true);
});

test("sync and state limits are enforced without a compatibility branch", () => {
  const empty = mutation();
  empty.state.response.optionId = "";
  const overhead = JSON.stringify(empty.state).length;
  const atLimit = { ...empty, state: { ...empty.state, response: { type: "choice_single", optionId: "x".repeat(MAX_SERIALIZED_JSON_UTF16_CODE_UNITS - overhead) } } };
  assert.equal(progressMutationSchema.safeParse(atLimit).success, true);
  assert.equal(progressMutationSchema.safeParse({ ...atLimit, state: { ...atLimit.state, response: { ...atLimit.state.response, optionId: `${atLimit.state.response.optionId}x` } } }).success, false);
  const records = Array.from({ length: 100 }, (_, index) => mutation("correct", index));
  assert.equal(isSyncRequestWithinBudget(request(records)), true);
  assert.equal(syncRequestSchema.safeParse(request([...records, mutation("correct", 100)])).success, false);
});

test("pagination tokens contain only generation, revision and cursor identity", () => {
  const token = createProgressPageToken({ version: 2, userId, generation: 2, accountRevision: 3, cursor: "a".repeat(64) });
  assert.deepEqual(parseProgressPageToken(token), { version: 2, userId, generation: 2, accountRevision: 3, cursor: "a".repeat(64) });
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


test("pagination rejects old, ambiguous and open-shaped tokens", () => {
  const valid = { version: 2 as const, userId, generation: 0, accountRevision: 0, cursor: "a".repeat(64) };
  const token = createProgressPageToken(valid);
  assert.throws(() => parseProgressPageToken(`${token}.ignored`), /progress_pagination_token_invalid/u);
  for (const candidate of [{ ...valid, version: 1 }, { ...valid, generation: -1 }, { ...valid, accountRevision: -1 }, { ...valid, cursor: "logical-id" }, { ...valid, unexpected: true }]) {
    const encoded = Buffer.from(JSON.stringify(candidate), "utf8").toString("base64url");
    const checksum = createHash("sha256").update(`${candidate.userId}:${canonicalJsonBytes(candidate)}:${encoded}`, "utf8").digest("hex").slice(0, 32);
    assert.throws(() => parseProgressPageToken(`${encoded}.${checksum}`), /progress_pagination_token_invalid/u);
  }
});
