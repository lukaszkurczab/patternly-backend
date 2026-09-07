import assert from "node:assert/strict";
import test from "node:test";
import { buildApplication } from "../src/api/app.js";
import { createLogger } from "../src/infrastructure/logging/logger.js";
import type { BackendStores } from "../src/infrastructure/firestore/stores.js";
import type { ProgressStore } from "../src/modules/progress/contracts.js";
import { loadEnvironment, type Environment } from "../src/config/environment.js";

const environment: Environment = loadEnvironment({
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "8080",
  LOG_LEVEL: "info",
  REPORT_RATE_LIMIT_HASH_SECRET: "test-only-report-rate-limit-secret-0123456789",
  DELETION_PSEUDONYM_KEYS_JSON: JSON.stringify([{ version: "test-v1", status: "active", keyBase64: Buffer.alloc(32, 7).toString("base64") }]),
  PRIVACY_RESPONSE_KEY_BASE64: Buffer.alloc(32, 11).toString("base64"),
  PRIVACY_AUDIT_HMAC_SECRET: "test-only-privacy-audit-hmac-secret-0123456789",
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

const clientCorrelationId = "11111111-1111-4111-8111-111111111111";
const headers = { authorization: "Bearer test-token", "x-correlation-id": clientCorrelationId };
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
  assert.deepEqual(events.map((entry) => ({ event: entry.event, stage: entry.stage, code: entry.code })), [
    { event: "account_sync_rejected", stage: "sync", code: "invalid_request" },
    { event: "account_sync_rejected", stage: "preview", code: "invalid_request" },
    { event: "account_sync_rejected", stage: "confirm", code: "invalid_request" },
    { event: "account_sync_rejected", stage: "sync", code: "progress_fingerprint_mismatch" },
    { event: "account_sync_rejected", stage: "confirm", code: "merge_preview_mismatch" },
  ]);
  for (const event of events) {
    assert.match(String(event.correlationId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    assert.notEqual(event.correlationId, clientCorrelationId);
  }
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /private@example\.com|secret-id-token|track-private|record-private/u);
  for (const event of events) {
    for (const forbidden of ["request", "error", "err", "payload", "uid", "email", "token", "fingerprint", "recordId"]) assert.equal(forbidden in event, false, `forbidden log field: ${forbidden}`);
  }
});

test("production Fastify logs only allowlisted request diagnostics and never canary data", async () => {
  const output: string[] = [];
  let failure: "handled" | "unhandled" | null = null;
  const app = application({
    applyBatch: async () => {
      if (failure === "handled") throw new Error("progress_fingerprint_mismatch");
      if (failure === "unhandled") throw new Error("unhandled-secret-message@example.invalid");
      return { accountRevision: 0, applied: [], duplicates: [], conflicts: [] };
    },
  }, output);
  const canaries = [
    "private-query@example.invalid",
    "private-header@example.invalid",
    "private-cookie-value",
    "private-body@example.invalid",
    "nested-operation-secret",
    "Bearer production-token-canary",
    "unhandled-secret-message@example.invalid",
  ];
  try {
    const safe = await app.inject({
      method: "POST",
      url: "/v1/progress/sync?email=private-query@example.invalid",
      headers: {
        authorization: "Bearer production-token-canary",
        cookie: "session=private-cookie-value",
        "x-private-email": "private-header@example.invalid",
        "x-correlation-id": "not-a-uuid-private-header@example.invalid",
      },
      payload: {
        ...validSyncPayload,
        mutations: [{ ...validSyncPayload.mutations[0], state: { email: "private-body@example.invalid", nested: { operationSecret: "nested-operation-secret" } } }],
      },
    });
    assert.equal(safe.statusCode, 200);
    assert.match(String(safe.headers["x-correlation-id"] ?? ""), /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);

    failure = "handled";
    const handled = await app.inject({ method: "POST", url: "/v1/progress/sync?token=private-query@example.invalid", headers, payload: validSyncPayload });
    assert.equal(handled.statusCode, 400);

    failure = "unhandled";
    const unhandled = await app.inject({ method: "POST", url: "/v1/progress/sync?password=private-query@example.invalid", headers, payload: validSyncPayload });
    assert.equal(unhandled.statusCode, 500);
    assert.equal(unhandled.json().error.code, "internal_error");

    const supplied = await app.inject({ method: "GET", url: "/health?contact=private-query@example.invalid", headers: { "x-correlation-id": clientCorrelationId } });
    assert.match(String(supplied.headers["x-correlation-id"] ?? ""), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    assert.notEqual(supplied.headers["x-correlation-id"], clientCorrelationId);
  } finally {
    await app.close();
  }
  const logs = output.map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, new RegExp(clientCorrelationId, "u"));
  for (const canary of canaries) assert.doesNotMatch(serialized, new RegExp(canary.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(serialized, /"url"|"headers"|"cookie"|"body"|"query"|"remoteAddress"|"remotePort"|"stack"|"message"/u);
  const failed = logs.find((entry) => entry.event === "request_failed");
  assert.deepEqual(failed, { level: 50, time: failed?.time, reqId: failed?.correlationId, event: "request_failed", code: "internal_error", correlationId: failed?.correlationId, msg: "request_failed" });
  assert.equal(logs.some((entry) => entry.res && typeof entry.res === "object" && (entry.res as { statusCode?: unknown }).statusCode === 500), true);
});

test("canonical logger emits only allowlisted diagnostics and static messages", () => {
  const output: string[] = [];
  const logger = createLogger(environment, { write: (message) => { output.push(message); } });
  logger.info({
    event: "account_sync_rejected",
    stage: "sync",
    code: "version_conflict",
    correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    userId: "deep-user-id",
    deviceId: "deep-device-id",
    ip: "203.0.113.77",
    nested: { email: "deep-email@example.invalid", aliases: [{ accountUidHash: "deep-uid" }, { operationSecret: "deep-secret" }, { contact: "deep-contact" }] },
  }, "dynamic sensitive message: deep-user-id");
  const serialized = output.join("");
  for (const canary of ["deep-user-id", "deep-device-id", "203.0.113.77", "deep-email@example.invalid", "deep-uid", "deep-secret", "deep-contact", "dynamic sensitive message"]) assert.doesNotMatch(serialized, new RegExp(canary, "u"));
  const entry = JSON.parse(output[0] ?? "{}") as Readonly<Record<string, unknown>>;
  assert.deepEqual(entry, { level: 30, time: entry.time, event: "account_sync_rejected", stage: "sync", code: "version_conflict", correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", msg: "suppressed_log_message" });
});

test("canonical logger child bindings retain only server request IDs and cannot override safety hooks", () => {
  const output: string[] = [];
  const reqId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const logger = createLogger(environment, { write: (message) => { output.push(message); } });
  const child = logger.child({ reqId, userId: "child-user-id", deviceId: "child-device-id", ip: "203.0.113.99" }, {
    serializers: { userId: () => "leaked" },
    redact: [],
  });
  child.info({ event: "account_sync_rejected", stage: "sync", code: "version_conflict" }, "account_sync_rejected");
  const serialized = output.join("");
  for (const canary of ["child-user-id", "child-device-id", "203.0.113.99", "leaked"]) assert.doesNotMatch(serialized, new RegExp(canary, "u"));
  const entry = JSON.parse(output[0] ?? "{}") as Readonly<Record<string, unknown>>;
  assert.equal(entry.reqId, reqId);
  assert.equal(entry.event, "account_sync_rejected");
  assert.equal(entry.code, "version_conflict");
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
