import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ProgressMutation } from "../src/modules/progress/contracts.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { attemptState, reviewState } from "./progressFixtures.js";
import { createEmulatorContext, createVerifiedRegisteredAuthUser, TEST_APP_CHECK_TOKEN } from "./support.js";

const context = createEmulatorContext();
const accounts: string[] = [];
const trackId = "coding-interview-dsa-problem-solving";
const deviceId = "00000000-0000-4000-8000-000000000000";
const ackKeys = ["accountRevision", "applied", "conflicts", "duplicates"];

test.after(async () => {
  for (const id of accounts) await context.db.recursiveDelete(context.db.collection("users").doc(id));
  await context.close();
});

function mutation(targetId: string, recordType: "training_attempt" | "review_queue_entry" = "training_attempt"): ProgressMutation {
  const state = recordType === "review_queue_entry" ? reviewState(targetId, trackId) : attemptState(targetId, trackId);
  return { mutationId: `mutation-${randomUUID()}`, kind: "item", recordType, trackId, targetId, expectedVersion: null, state, fingerprint: createMergeRecordFingerprint({ recordId: targetId, recordType, trackId, state }) } as ProgressMutation;
}

async function account() {
  const registered = await createVerifiedRegisteredAuthUser(context);
  accounts.push(registered.userId);
  return { userId: registered.userId, headers: { authorization: `Bearer ${registered.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } };
}

function payload(expectedAccountRevision: number, mutations: readonly ProgressMutation[], batchId = randomUUID()) {
  return { canonicalVersion: "canonical-json-v1", expectedAccountRevision, deviceId, sessionId: "sync-state-session", batchId, highWatermark: 1, mutations };
}

test("sync response is unchanged without the progress state header", async () => {
  const { headers } = await account();
  const response = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: payload(0, [mutation("plain-a")]) });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(Object.keys(response.json()).sort(), ackKeys);
});

test("x-patternly-progress-state:1 returns the post-commit first page identical to conditional GET", async () => {
  const { headers } = await account();
  const mutations = [...Array.from({ length: 10 }, (_, index) => mutation(`state-a-${index}`)), ...Array.from({ length: 10 }, (_, index) => mutation(`state-r-${index}`, "review_queue_entry"))];
  const body = payload(0, mutations);
  const response = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers: { ...headers, "x-patternly-progress-state": "1" }, payload: body });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.deepEqual(Object.keys(result).sort(), [...ackKeys, "progressState"].sort());
  assert.equal(result.accountRevision, 20);
  assert.equal(result.progressState.accountRevision, 20);
  assert.equal(result.progressState.records.length, 20);
  assert.equal(result.progressState.nextPageToken, null);

  const read = await context.app.inject({ method: "GET", url: "/v1/progress?pageSize=100&conditional=1", headers });
  assert.equal(read.statusCode, 200, read.body);
  assert.deepEqual(result.progressState, read.json());

  // The returned validator is usable for the next conditional GET.
  const revalidated = await context.app.inject({ method: "GET", url: `/v1/progress?pageSize=100&conditional=1&knownSnapshot=${result.progressState.snapshotToken}`, headers });
  assert.equal(revalidated.statusCode, 200, revalidated.body);
  assert.equal(revalidated.json().unchanged, true);

  // Exact batch replay is still acknowledged from the stored receipt and may carry state.
  const replay = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers: { ...headers, "x-patternly-progress-state": "1" }, payload: body });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().accountRevision, 20);
  assert.deepEqual(replay.json().progressState, read.json());
});

test("progress state pages beyond 100 records like GET", async () => {
  const { headers } = await account();
  let revision = 0;
  for (let batch = 0; batch < 3; batch += 1) {
    const response = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: payload(revision, Array.from({ length: 40 }, (_, index) => mutation(`page-${batch}-${index}`))) });
    assert.equal(response.statusCode, 200, response.body);
    revision = response.json().accountRevision;
  }
  const response = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers: { ...headers, "x-patternly-progress-state": "1" }, payload: payload(revision, [mutation("page-last")]) });
  assert.equal(response.statusCode, 200, response.body);
  const state = response.json().progressState;
  assert.equal(state.records.length, 100);
  assert.equal(typeof state.nextPageToken, "string");
  const next = await context.app.inject({ method: "GET", url: `/v1/progress?pageSize=100&pageToken=${encodeURIComponent(state.nextPageToken)}`, headers });
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().records.length, 21);
});

test("invalid progress state header is rejected before any write", async () => {
  const { userId, headers } = await account();
  const response = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers: { ...headers, "x-patternly-progress-state": "true" }, payload: payload(0, [mutation("invalid-header")]) });
  assert.equal(response.statusCode, 400, response.body);
  assert.deepEqual(response.json(), { error: { code: "invalid_request" } });
  assert.equal((await context.stores.progress.readSnapshot(userId)).records.length, 0);
});

test("a failed post-commit state read omits progressState and keeps the durable ACK", async () => {
  const { userId, headers } = await account();
  const progress = context.stores.progress as { readPage: (...args: never[]) => Promise<unknown> };
  const original = progress.readPage;
  progress.readPage = async () => { throw new Error("progress_generation_conflict"); };
  try {
    const response = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers: { ...headers, "x-patternly-progress-state": "1" }, payload: payload(0, [mutation("state-read-fails")]) });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(Object.keys(response.json()).sort(), ackKeys);
    assert.equal(response.json().accountRevision, 1);
  } finally {
    progress.readPage = original;
  }
  assert.equal((await context.stores.progress.readSnapshot(userId)).records.length, 1);
});
