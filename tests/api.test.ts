import assert from "node:assert/strict";
import test from "node:test";
import { buildApplication } from "../src/api/app.js";
import type { IdentityTokenVerifier } from "../src/infrastructure/firebase/verifier.js";
import { createMemoryStores, testEnvironment } from "./support.js";

const verifier: IdentityTokenVerifier = {
  async verify(token) {
    if (token === "test-token") return { provider: "firebase", subject: "firebase-subject", email: "learner@example.com", emailVerified: true };
    if (token === "admin-token") return { provider: "firebase", subject: "firebase-subject", email: "lukasz.kurczab@gmail.com", emailVerified: true };
    throw new Error("firebase_token_invalid");
  },
};

function createTestApp() {
  return buildApplication({ environment: testEnvironment, database: { db: undefined as never, ping: async () => true, close: async () => undefined }, verifier, stores: createMemoryStores() });
}

test("health is public and readiness exposes missing database wiring", async () => {
  const app = buildApplication({ environment: testEnvironment, database: null, verifier: null, stores: null });
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: "ok", service: "patternly-backend" });
  const ready = await app.inject({ method: "GET", url: "/ready" });
  assert.equal(ready.statusCode, 503);
  assert.deepEqual(ready.json().checks, { database: false, authentication: false });
  await app.close();
});

test("authenticated routes bind Firebase identity to canonical user id", async () => {
  const app = createTestApp();
  const unauthenticated = await app.inject({ method: "GET", url: "/v1/me" });
  assert.equal(unauthenticated.statusCode, 401);
  const response = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: "Bearer test-token" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().user.id, "3f7b5b37-9e9a-4f4f-9db1-2bcbbaea3e29");
  assert.equal(typeof response.headers["x-correlation-id"], "string");
  await app.close();
});

test("OpenAPI is served from the deterministic document", async () => {
  const app = createTestApp();
  const response = await app.inject({ method: "GET", url: "/openapi.json" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().openapi, "3.1.0");
  assert.ok(response.json().paths["/v1/progress/sync"]);
  assert.ok(response.json().paths["/v1/content/reports"]);
  await app.close();
});

test("content reports are deduplicated per account and visible only to the configured administrator", async () => {
  const app = createTestApp();
  const body = {
    clientSubmissionId: "7f61e3f3-f23e-467c-b92a-9b8fd0514f25",
    trackId: "coding-interview-dsa-problem-solving",
    contentVersion: "2026.08.25",
    itemId: "two-sum-001",
    reason: "unclear_explanation",
    description: "The explanation does not identify why the invariant is safe.",
  };
  const created = await app.inject({ method: "POST", url: "/v1/content/reports", headers: { authorization: "Bearer test-token" }, payload: body });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().duplicate, false);
  const duplicate = await app.inject({ method: "POST", url: "/v1/content/reports", headers: { authorization: "Bearer test-token" }, payload: body });
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.json().duplicate, true);
  const denied = await app.inject({ method: "GET", url: "/v1/admin/content-reports", headers: { authorization: "Bearer test-token" } });
  assert.equal(denied.statusCode, 403);
  const reports = await app.inject({ method: "GET", url: "/v1/admin/content-reports", headers: { authorization: "Bearer admin-token" } });
  assert.equal(reports.statusCode, 200);
  assert.equal(reports.json().reports.length, 1);
  await app.close();
});
