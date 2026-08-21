import assert from "node:assert/strict";
import test from "node:test";
import { buildApplication } from "../src/api/app.js";
import type { IdentityTokenVerifier } from "../src/infrastructure/firebase/verifier.js";
import { createMemoryStores, testEnvironment } from "./support.js";

const verifier: IdentityTokenVerifier = { async verify() { return { provider: "firebase", subject: "firebase-subject", emailVerified: true }; } };
const mutation = { mutationId: "mutation-0000000001", kind: "item" as const, trackId: "coding-interview-dsa-problem-solving", targetId: "item-1", expectedVersion: null, state: { mastery: "learning" } };

test("sync applies a mutation once and deduplicates retries", async () => {
  const app = buildApplication({ environment: testEnvironment, database: { db: undefined as never, ping: async () => true, close: async () => undefined }, verifier, stores: createMemoryStores() });
  const first = await app.inject({ method: "POST", url: "/v1/progress/sync", headers: { authorization: "Bearer test-token" }, payload: { deviceId: null, mutations: [mutation] } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().applied[0].version, 1);
  const retry = await app.inject({ method: "POST", url: "/v1/progress/sync", headers: { authorization: "Bearer test-token" }, payload: { mutations: [mutation] } });
  assert.equal(retry.statusCode, 200);
  assert.deepEqual(retry.json().duplicates, [mutation.mutationId]);
  assert.deepEqual(retry.json().applied, []);
  await app.close();
});

test("sync reports a version conflict instead of overwriting canonical state", async () => {
  const app = buildApplication({ environment: testEnvironment, database: { db: undefined as never, ping: async () => true, close: async () => undefined }, verifier, stores: createMemoryStores() });
  await app.inject({ method: "POST", url: "/v1/progress/sync", headers: { authorization: "Bearer test-token" }, payload: { mutations: [mutation] } });
  const conflicting = await app.inject({ method: "POST", url: "/v1/progress/sync", headers: { authorization: "Bearer test-token" }, payload: { mutations: [{ ...mutation, mutationId: "mutation-0000000002", expectedVersion: null, state: { mastery: "mastered" } }] } });
  assert.equal(conflicting.statusCode, 409);
  assert.equal(conflicting.json().conflicts[0].code, "version_conflict");
  assert.equal(conflicting.json().conflicts[0].current.state.mastery, "learning");
  await app.close();
});
