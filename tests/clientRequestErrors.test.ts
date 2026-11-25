import assert from "node:assert/strict";
import test from "node:test";
import { buildApplication } from "../src/api/app.js";
import { OPENAPI_DOCUMENT } from "../src/api/openapi.js";
import type { BackendStores } from "../src/infrastructure/firestore/stores.js";
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
  REVENUECAT_WEBHOOK_SECRET: "client-error-webhook-secret",
  REVENUECAT_PROJECT_ID: "projtest",
  REVENUECAT_APP_ID: "client-error-app",
  REVENUECAT_ENTITLEMENT_ID: "client-error-entitlement",
  REVENUECAT_PRODUCT_ID: "client-error-product",
  REVENUECAT_WEBHOOK_ENVIRONMENT: "SANDBOX",
});

const APP_CHECK_TOKEN = "client-error-test-app-check";
const identity = Object.freeze({
  provider: "firebase" as const,
  subject: "firebase-subject",
  email: "private@example.com",
  emailVerified: true,
  authTime: Math.floor(Date.now() / 1000),
  authorizationGeneration: 1,
});

/** Every store or verifier call is recorded so a test can prove no guard or handler ran past the parser. */
function application(calls: string[], logs: string[]) {
  const record = (name: string) => async () => { calls.push(name); throw new Error(`unexpected_${name}`); };
  const stores = {
    users: { resolveExistingUser: async () => { calls.push("users.resolveExistingUser"); return { userId: "server-user", authorizationGeneration: 1 }; } },
    progress: { applyBatch: record("progress.applyBatch"), read: record("progress.read"), readSnapshot: record("progress.readSnapshot") },
    revenueCatWebhook: { process: record("revenueCatWebhook.process") },
    legalRequests: { submit: record("legalRequests.submit") },
  } as unknown as BackendStores;
  return buildApplication({
    environment,
    firestore: null,
    verifier: { verify: async () => { calls.push("verifier.verify"); return identity; } },
    appCheckVerifier: { verify: async (token) => { calls.push("appCheck.verify"); if (token !== APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores,
    logStream: { write: (message) => { logs.push(message); } },
  });
}

const routes = [
  { name: "public webhook", url: "/v1/webhooks/revenuecat", headers: { authorization: "client-error-webhook-secret" } },
  { name: "public optional-bearer", url: "/v1/public/legal-requests", headers: { "x-firebase-appcheck": APP_CHECK_TOKEN } },
  { name: "protected app_check_bearer", url: "/v1/progress/sync", headers: { "x-firebase-appcheck": APP_CHECK_TOKEN, authorization: "Bearer test-token" } },
] as const;

const malformedBodies = [
  { name: "empty body", payload: "" },
  { name: "invalid JSON", payload: "{\"records\": [" },
  { name: "prototype poisoning", payload: "{\"__proto__\": {\"polluted\": true}}" },
] as const;

const PARSER_DETAIL = /content-type|not valid JSON|cannot be empty|FST_ERR|SyntaxError|__proto__|Unexpected/iu;

test("malformed or empty JSON bodies are a bounded 400 invalid_request on public and protected routes", async () => {
  for (const route of routes) {
    for (const body of malformedBodies) {
      for (const credentials of ["with", "without"] as const) {
        const calls: string[] = [];
        const logs: string[] = [];
        const app = application(calls, logs);
        let response: Awaited<ReturnType<typeof app.inject>>;
        try {
          response = await app.inject({
            method: "POST",
            url: route.url,
            headers: { "content-type": "application/json", ...(credentials === "with" ? route.headers : {}) },
            payload: body.payload,
          });
        } finally {
          await app.close();
        }
        const label = `${route.name} / ${body.name} / ${credentials} credentials`;
        assert.equal(response.statusCode, 400, label);
        assert.match(String(response.headers["content-type"]), /^application\/json/u, label);
        assert.deepEqual(response.json(), { error: { code: "invalid_request" } }, label);
        assert.doesNotMatch(response.body, PARSER_DETAIL, label);
        assert.equal(typeof response.headers["x-correlation-id"], "string", label);
        // The parser runs before any guard: no credential check, store access or handler may run.
        assert.deepEqual(calls, [], label);
        const serializedLogs = logs.join("");
        assert.doesNotMatch(serializedLogs, PARSER_DETAIL, label);
        assert.doesNotMatch(serializedLogs, /"level":50/u, label);
        const rejected = logs.map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>).filter((entry) => entry.event === "request_rejected");
        assert.equal(rejected.length, 1, label);
        assert.equal(rejected[0]?.code, "invalid_request", label);
      }
    }
  }
});

const OVERSIZED_JSON = JSON.stringify({ padding: "x".repeat(1024 * 1024 + 16) });
const PARSER_CLIENT_ERROR_DETAIL = /too large|Unsupported Media|Content-Length|did not match|FST_ERR|RangeError/iu;

const parserClientErrors = [
  { name: "body over the 1 MiB limit", headers: { "content-type": "application/json" }, payload: OVERSIZED_JSON, status: 413, code: "request_too_large" },
  { name: "text/xml body", headers: { "content-type": "text/xml" }, payload: "<sync/>", status: 415, code: "unsupported_media_type" },
  { name: "octet-stream body", headers: { "content-type": "application/octet-stream" }, payload: "{}", status: 415, code: "unsupported_media_type" },
  { name: "form-urlencoded body", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "records=1", status: 415, code: "unsupported_media_type" },
  { name: "content-length larger than the body", headers: { "content-type": "application/json", "content-length": "64" }, payload: "{}", status: 400, code: "invalid_request" },
  { name: "content-length smaller than the body", headers: { "content-type": "application/json", "content-length": "2" }, payload: "{\"mutations\":[]}", status: 400, code: "invalid_request" },
] as const;

test("oversized, unsupported or length-mismatched bodies are bounded client errors before every guard", async () => {
  for (const route of routes) {
    for (const body of parserClientErrors) {
      for (const credentials of ["with", "without"] as const) {
        const calls: string[] = [];
        const logs: string[] = [];
        const app = application(calls, logs);
        let response: Awaited<ReturnType<typeof app.inject>>;
        try {
          response = await app.inject({
            method: "POST",
            url: route.url,
            headers: { ...(credentials === "with" ? route.headers : {}), ...body.headers },
            payload: body.payload,
          });
        } finally {
          await app.close();
        }
        const label = `${route.name} / ${body.name} / ${credentials} credentials`;
        assert.equal(response.statusCode, body.status, label);
        assert.match(String(response.headers["content-type"]), /^application\/json/u, label);
        assert.deepEqual(response.json(), { error: { code: body.code } }, label);
        assert.doesNotMatch(response.body, PARSER_CLIENT_ERROR_DETAIL, label);
        assert.equal(typeof response.headers["x-correlation-id"], "string", label);
        assert.deepEqual(calls, [], label);
        const serializedLogs = logs.join("");
        assert.doesNotMatch(serializedLogs, PARSER_CLIENT_ERROR_DETAIL, label);
        assert.doesNotMatch(serializedLogs, /"level":50/u, label);
        const rejected = logs.map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>).filter((entry) => entry.event === "request_rejected");
        assert.equal(rejected.length, 1, label);
        assert.equal(rejected[0]?.code, body.code, label);
      }
    }
  }
});

test("a well-formed body still cannot reach a protected handler without App Check", async () => {
  for (const headers of [{}, { authorization: "Bearer test-token" }, { "x-firebase-appcheck": "invalid", authorization: "Bearer test-token" }]) {
    const calls: string[] = [];
    const app = application(calls, []);
    let response: Awaited<ReturnType<typeof app.inject>>;
    try {
      response = await app.inject({ method: "POST", url: "/v1/progress/sync", headers: { "content-type": "application/json", ...headers }, payload: { mutations: [] } });
    } finally {
      await app.close();
    }
    assert.equal(response.statusCode, 401);
    assert.match(response.json().error.code, /^app_check_(required|invalid)$/u);
    assert.ok(calls.every((call) => call === "appCheck.verify"), calls.join(","));
  }
});

test("unexpected handler failures remain an opaque 500 internal_error", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const app = application(calls, logs);
  app.get("/test-only/failure", async () => { throw new Error("private failure detail"); });
  let response: Awaited<ReturnType<typeof app.inject>>;
  try {
    response = await app.inject({ method: "GET", url: "/test-only/failure" });
  } finally {
    await app.close();
  }
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.code, "internal_error");
  assert.doesNotMatch(response.body, /private failure detail/u);
});

test("OpenAPI documents the parser 413 and 415 on every operation with a JSON request body", () => {
  const missing: string[] = [];
  for (const [path, pathItem] of Object.entries(OPENAPI_DOCUMENT.paths as unknown as Record<string, Record<string, unknown>>)) {
    for (const [method, operationValue] of Object.entries(pathItem)) {
      const operation = operationValue as { requestBody?: unknown; responses?: Record<string, { description?: string; content?: Record<string, { schema?: { $ref?: string } }> }> };
      if (typeof operation !== "object" || operation === null || operation.requestBody === undefined) continue;
      for (const [status, code] of [["413", "request_too_large"], ["415", "unsupported_media_type"]] as const) {
        const response = operation.responses?.[status];
        if (!response?.description?.includes(code) || response.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/ErrorEnvelope") missing.push(`${method.toUpperCase()} ${path} ${status}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("OpenAPI documents the malformed-body 400 on every operation with a JSON request body", () => {
  const missing: string[] = [];
  for (const [path, pathItem] of Object.entries(OPENAPI_DOCUMENT.paths as unknown as Record<string, Record<string, unknown>>)) {
    for (const [method, operationValue] of Object.entries(pathItem)) {
      const operation = operationValue as { requestBody?: unknown; responses?: Record<string, { description?: string; content?: Record<string, { schema?: { $ref?: string } }> }> };
      if (typeof operation !== "object" || operation === null || operation.requestBody === undefined) continue;
      const badRequest = operation.responses?.["400"];
      if (!badRequest?.description?.includes("invalid_request") || badRequest.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/ErrorEnvelope") missing.push(`${method.toUpperCase()} ${path}`);
    }
  }
  assert.deepEqual(missing, []);
});
