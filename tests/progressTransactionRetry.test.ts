import assert from "node:assert/strict";
import test from "node:test";
import type { Firestore } from "firebase-admin/firestore";
import { FirestoreProgressStore } from "../src/modules/progress/store.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { attemptState } from "./progressFixtures.js";

const trackId = "coding-interview-dsa-problem-solving";
function mutation(goal = false) {
  const recordType = goal ? "goal" as const : "training_attempt" as const;
  const targetId = goal ? trackId : "closed-read-attempt";
  const state = goal
    ? { schemaVersion: 1, revision: 1, record: { goalType: "prepare_for_a_certification", preferredDays: ["mon"], status: "active", targetDate: "2027-09-09", trackId, weeklySessionTarget: 1 } }
    : attemptState(targetId, trackId);
  return { mutationId: "closed-read-mutation", kind: goal ? "node" as const : "item" as const, recordType, targetId, trackId, expectedVersion: null, state, fingerprint: createMergeRecordFingerprint({ recordId: targetId, recordType, state, trackId }) };
}
function harness(options: { readError?: unknown; failRead?: number; writeError?: unknown; commitError?: unknown; user?: object } = {}) {
  let reads = 0;
  let callbacks = 0;
  let writes = 0;
  const missing = { exists: false, data: () => undefined };
  const ref = { collection: () => ({ doc: () => ref }) };
  const maybeFail = () => { reads++; if (reads === (options.failRead ?? 1)) throw options.readError; };
  const write = () => { writes++; if (options.writeError !== undefined) throw options.writeError; };
  const transaction = {
    get: async () => { maybeFail(); return reads === 1 ? { exists: true, data: () => options.user ?? {} } : missing; },
    getAll: async (...refs: unknown[]) => { maybeFail(); return refs.map(() => missing); },
    set: write, create: write,
  };
  const db = {
    collection: () => ({ doc: () => ref }),
    runTransaction: async (callback: (value: typeof transaction) => Promise<unknown>) => {
      callbacks++;
      const result = await callback(transaction);
      if (options.commitError !== undefined) throw options.commitError;
      return result;
    },
  } as unknown as Firestore;
  const apply = (goal = false) => new FirestoreProgressStore(db).applyBatch("user", 1, "device", 0, [mutation(goal)], { sessionId: "session", batchId: "batch", highWatermark: 1 });
  return { apply, counters: () => ({ reads, callbacks, writes }) };
}

for (let read = 1; read <= 5; read++) {
  test(`closed transaction read ${read} delegates a bounded retry signal to the SDK`, async () => {
    const original = Object.assign(new Error("3 INVALID_ARGUMENT: Transaction is invalid or closed."), { code: 3, details: "Transaction is invalid or closed." });
    const fixture = harness({ readError: original, failRead: read });
    await assert.rejects(fixture.apply(read === 5), error => {
      assert.equal((error as { code?: unknown }).code, 10);
      assert.equal((error as Error).message, "progress_transaction_closed");
      assert.equal((error as Error).cause, original);
      return true;
    });
    assert.deepEqual(fixture.counters(), { reads: read, callbacks: 1, writes: 0 });
  });
}

for (const message of ["Transaction is invalid or closed.", "3 INVALID_ARGUMENT: Transaction is invalid or closed."]) {
  test(`exact closed message without details is recognized: ${message}`, async () => {
    const original = Object.assign(new Error(message), { code: 3 });
    await assert.rejects(harness({ readError: original }).apply(), error => (error as Error).cause === original && (error as { code?: unknown }).code === 10);
  });
}

const unrelated = [
  { code: 3, details: "invalid argument", message: "invalid argument" },
  { code: 3, details: "different", message: "3 INVALID_ARGUMENT: Transaction is invalid or closed." },
  { code: 3, message: "prefix Transaction is invalid or closed." },
  { code: 3, message: "Transaction is invalid or closed. suffix" },
  { code: "3", details: "Transaction is invalid or closed." },
  { code: 10, details: "Transaction is invalid or closed." },
  new Error("mutation_id_reuse"),
];
for (const [index, original] of unrelated.entries()) {
  test(`unrelated read error ${index + 1} retains its identity`, async () => {
    const fixture = harness({ readError: original });
    await assert.rejects(fixture.apply(), error => error === original);
    assert.deepEqual(fixture.counters(), { reads: 1, callbacks: 1, writes: 0 });
  });
}

for (const phase of ["writeError", "commitError"] as const) {
  test(`${phase} is never normalized or retried by the read adapter`, async () => {
    const original = Object.assign(new Error("3 INVALID_ARGUMENT: Transaction is invalid or closed."), { code: 3, details: "Transaction is invalid or closed." });
    const fixture = harness({ [phase]: original, failRead: -1 });
    await assert.rejects(fixture.apply(), error => error === original);
    assert.equal(fixture.counters().callbacks, 1);
    assert.equal(fixture.counters().reads, 4);
  });
}

test("authorization domain errors remain fail closed before other reads or writes", async () => {
  const fixture = harness({ user: { authorizationGeneration: 2 }, failRead: -1 });
  await assert.rejects(fixture.apply(), { message: "authorization_generation_conflict" });
  assert.deepEqual(fixture.counters(), { reads: 1, callbacks: 1, writes: 0 });
});
