import assert from "node:assert/strict";
import test from "node:test";
import { buildApplication } from "../src/api/app.js";
import type { BackendStores } from "../src/infrastructure/firestore/stores.js";
import type { ProgressStore } from "../src/modules/progress/contracts.js";
import { loadEnvironment, type Environment } from "../src/config/environment.js";

const environment: Environment = loadEnvironment({
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "8080",
  LOG_LEVEL: "warn",
  REPORT_RATE_LIMIT_HASH_SECRET: "test-only-report-rate-limit-secret-0123456789",
});

const identity = Object.freeze({
  provider: "firebase" as const,
  subject: "firebase-subject",
  email: "private@example.com",
  emailVerified: true,
  authTime: Math.floor(Date.now() / 1000),
});

function application(progressOverrides: Partial<ProgressStore>, logs: string[]) {
  const progress = {
    read: async () => [],
    readSnapshot: async () => ({ accountRevision: 0, records: [] }),
    previewAdoption: async () => { throw new Error("unexpected_preview_call"); },
    confirmAdoption: async () => { throw new Error("unexpected_confirm_call"); },
    applyBatch: async () => ({ accountRevision: 0, applied: [], duplicates: [], conflicts: [] }),
    ...progressOverrides,
  } as unknown as ProgressStore;
  const stores = {
    users: { ensureUser: async () => ({ userId: "server-user" }) },
    progress,
  } as unknown as BackendStores;
  return buildApplication({
    environment,
    firestore: null,
    verifier: { verify: async () => identity },
    appCheckVerifier: null,
    stores,
    logStream: { write: (message) => { logs.push(message); } },
  });
}

const headers = { authorization: "Bearer test-token", "x-correlation-id": "sync-trace-123" };
const validSyncPayload = {
  expectedAccountRevision: 0,
  mutations: [{
    mutationId: "mutation-1234567",
    kind: "node",
    recordType: "active_track",
    trackId: "track-private",
    targetId: "record-private",
    expectedVersion: null,
    fingerprint: "a".repeat(64),
    state: { email: "private@example.com", idToken: "secret-id-token" },
  }],
};
const validConfirmPayload = {
  deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  snapshot: {
    guestSnapshotVersion: 1,
    guestUserId: "11111111-1111-4111-8111-111111111111",
    records: [],
    activeSession: false,
    pendingJournal: false,
  },
  confirmation: {
    operationId: "22222222-2222-4222-8222-222222222222",
    previewFingerprint: "b".repeat(64),
    protocolVersion: 1,
    resolutions: [],
  },
};

function accountSyncEvents(logs: readonly Readonly<Record<string, unknown>>[]) {
  return logs.filter((entry) => entry.event === "account_sync_rejected");
}

test("handled sync and adoption rejections emit a redacted structured event and preserve responses", async () => {
  const output: string[] = [];
  const app = application({
    applyBatch: async () => { throw new Error("progress_fingerprint_mismatch"); },
    confirmAdoption: async () => { throw new Error("merge_preview_mismatch"); },
  }, output);
  let responses: Awaited<ReturnType<typeof app.inject>>[] = [];
  try {
    responses = await Promise.all([
      app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: {} }),
      app.inject({ method: "POST", url: "/v1/account-data/adoption/preview", headers, payload: {} }),
      app.inject({ method: "POST", url: "/v1/account-data/adoption/confirm", headers, payload: {} }),
      app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: validSyncPayload }),
      app.inject({ method: "POST", url: "/v1/account-data/adoption/confirm", headers, payload: validConfirmPayload }),
    ]);
  } finally {
    await app.close();
  }
  const logs = output.map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);

  assert.deepEqual(responses.map((response) => response.statusCode), [400, 400, 400, 400, 409]);
  assert.equal(responses[0]?.json().error.code, "invalid_request");
  assert.equal(responses[3]?.json().error.code, "progress_fingerprint_mismatch");
  assert.equal(responses[4]?.json().error.code, "merge_preview_mismatch");

  const events = accountSyncEvents(logs);
  assert.deepEqual(events.map((entry) => ({ event: entry.event, stage: entry.stage, code: entry.code, correlationId: entry.correlationId })), [
    { event: "account_sync_rejected", stage: "sync", code: "invalid_request", correlationId: "sync-trace-123" },
    { event: "account_sync_rejected", stage: "preview", code: "invalid_request", correlationId: "sync-trace-123" },
    { event: "account_sync_rejected", stage: "confirm", code: "invalid_request", correlationId: "sync-trace-123" },
    { event: "account_sync_rejected", stage: "sync", code: "progress_fingerprint_mismatch", correlationId: "sync-trace-123" },
    { event: "account_sync_rejected", stage: "confirm", code: "merge_preview_mismatch", correlationId: "sync-trace-123" },
  ]);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /private@example\.com|secret-id-token|track-private|record-private/u);
  for (const event of events) {
    for (const forbidden of ["request", "error", "err", "payload", "uid", "email", "token", "fingerprint", "recordId"]) assert.equal(forbidden in event, false, `forbidden log field: ${forbidden}`);
  }
});

test("conflict event codes are allowlisted, unknown values are literal unknown, and success is silent", async () => {
  const output: string[] = [];
  let mode: "conflict" | "unknown" | "success" = "conflict";
  const app = application({
    applyBatch: async () => mode === "success"
      ? { accountRevision: 0, applied: [], duplicates: [], conflicts: [] }
      : {
        accountRevision: 0,
        applied: [],
        duplicates: [],
        conflicts: [{ mutationId: "private-mutation", code: mode === "conflict" ? "version_conflict" : "private-backend-code", current: null }],
      } as never,
  }, output);
  try {
    const conflict = await app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: validSyncPayload });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().conflicts[0].code, "version_conflict");
    mode = "unknown";
    const unknown = await app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: validSyncPayload });
    assert.equal(unknown.statusCode, 409);
    assert.equal(unknown.json().conflicts[0].code, "private-backend-code");
    mode = "success";
    const success = await app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: validSyncPayload });
    assert.equal(success.statusCode, 200);
  } finally {
    await app.close();
  }
  const logs = output.map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
  const events = accountSyncEvents(logs);
  assert.deepEqual(events.map((entry) => entry.code), ["version_conflict", "unknown"]);
  assert.doesNotMatch(JSON.stringify(events), /private-backend-code|private-mutation/u);
});
