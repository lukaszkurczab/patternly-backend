import assert from "node:assert/strict";
import test from "node:test";
import { OPENAPI_DOCUMENT } from "../src/api/openapi.js";
import { assertSecurityProbes, buildSecurityProbeApplication } from "../src/api/security-probes.js";
import { BOOTSTRAP_COMPONENTS, bootstrapServerTiming, composeBootstrap, parseBootstrapQuery } from "../src/modules/bootstrap/contracts.js";
import { loadEnvironment } from "../src/config/environment.js";

const sha = "a".repeat(64);

function testEnvironment() {
  return loadEnvironment({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:19099",
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:18080",
    ADMIN_WEB_ORIGIN: "http://127.0.0.1:29199",
    LOG_LEVEL: "silent",
    REPORT_RATE_LIMIT_HASH_SECRET: "openapi-check-report-rate-limit-secret-0123456789",
    DELETION_PSEUDONYM_KEYS_JSON: "[]",
    PRIVACY_RESPONSE_KEY_BASE64: "openapi-check-privacy-key",
    PRIVACY_AUDIT_HMAC_SECRET: "openapi-check-privacy-audit-secret-0123456789",
    ADMINISTRATOR_EMAIL: "security-probe-admin@example.com",
    REVENUECAT_WEBHOOK_SECRET: "security-probe-webhook-secret",
    REVENUECAT_PROJECT_ID: "projtest",
    REVENUECAT_APP_ID: "security-probe-app",
    REVENUECAT_ENTITLEMENT_ID: "security-probe-entitlement",
    REVENUECAT_PRODUCT_ID: "security-probe-product",
    REVENUECAT_WEBHOOK_ENVIRONMENT: "SANDBOX",
  });
}

test("bootstrap query defaults to every component without a progress condition", () => {
  assert.deepEqual(parseBootstrapQuery({}), { include: BOOTSTRAP_COMPONENTS, progressCondition: {} });
  assert.deepEqual(parseBootstrapQuery(undefined), { include: BOOTSTRAP_COMPONENTS, progressCondition: {} });
});

test("bootstrap include keeps canonical order and accepts progress conditions", () => {
  assert.deepEqual(parseBootstrapQuery({ include: "tracks,me" }).include, ["me", "tracks"]);
  assert.deepEqual(parseBootstrapQuery({ include: "progress", progressKnownSnapshot: sha }).progressCondition, { knownSnapshot: sha });
  assert.deepEqual(parseBootstrapQuery({ progressKnownScope: sha, progressKnownRevision: "12" }).progressCondition, { knownScope: sha, knownRevision: 12 });
});

test("bootstrap query rejects unknown, repeated or malformed parameters", () => {
  for (const query of [
    { unknown: "1" },
    { include: "" },
    { include: "me,me" },
    { include: "me,content" },
    { include: ["me", "tracks"] },
    { include: "me", progressKnownSnapshot: sha },
    { progressKnownSnapshot: "A".repeat(64) },
    { progressKnownSnapshot: sha, progressKnownScope: sha, progressKnownRevision: "1" },
    { progressKnownScope: sha },
    { progressKnownRevision: "1" },
    { progressKnownScope: sha, progressKnownRevision: "01" },
    { progressKnownScope: sha, progressKnownRevision: "-1" },
    { progressKnownScope: sha, progressKnownRevision: "99999999999999999999" },
  ]) assert.throws(() => parseBootstrapQuery(query), /invalid_request/u, JSON.stringify(query));
});

test("composeBootstrap reads components concurrently and isolates a thrown reader", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const reader = (status: number, body: unknown) => async () => {
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    return { status, body };
  };
  const failures: string[] = [];
  const { response, timings } = await composeBootstrap(BOOTSTRAP_COMPONENTS, {
    me: reader(200, { user: { id: "u" } }),
    entitlements: reader(503, { error: { code: "revenuecat_read_unavailable" } }),
    progress: reader(200, { unchanged: true }),
    tracks: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); throw new Error("track_access_record_invalid"); },
  }, (name) => { failures.push(name); return { status: 500, body: { error: { code: "internal_error", correlationId: "c" } } }; }, () => new Date("2026-11-13T00:00:00.000Z"));
  assert.equal(maxInFlight, 3);
  assert.deepEqual(failures, ["tracks"]);
  assert.deepEqual(response, {
    bootstrapVersion: 1,
    serverObservedAt: "2026-11-13T00:00:00.000Z",
    components: {
      me: { status: 200, body: { user: { id: "u" } } },
      entitlements: { status: 503, body: { error: { code: "revenuecat_read_unavailable" } } },
      progress: { status: 200, body: { unchanged: true } },
      tracks: { status: 500, body: { error: { code: "internal_error", correlationId: "c" } } },
    },
  });
  assert.deepEqual(timings.map(({ name }) => name), [...BOOTSTRAP_COMPONENTS]);
  assert.match(bootstrapServerTiming(timings, 21.04), /^me;dur=\d+\.\d, entitlements;dur=\d+\.\d, progress;dur=\d+\.\d, tracks;dur=\d+\.\d, total;dur=21\.0$/u);
});

test("composeBootstrap does not read components that were not included", async () => {
  const called: string[] = [];
  const reader = (name: string) => async () => { called.push(name); return { status: 200, body: {} }; };
  const { response } = await composeBootstrap(["progress"], { me: reader("me"), entitlements: reader("entitlements"), progress: reader("progress"), tracks: reader("tracks") }, () => { throw new Error("unexpected"); });
  assert.deepEqual(called, ["progress"]);
  assert.deepEqual(Object.keys(response.components), ["progress"]);
});

test("security probes require GET /v1/bootstrap to stay app_check_bearer", async () => {
  const app = buildSecurityProbeApplication(testEnvironment());
  try {
    await assertSecurityProbes(app, OPENAPI_DOCUMENT);
    const downgraded = structuredClone(OPENAPI_DOCUMENT) as unknown as { paths: Record<string, Record<string, Record<string, unknown>>> };
    downgraded.paths["/v1/bootstrap"]!.get!["x-patternly-security-profile"] = "bearer";
    await assert.rejects(assertSecurityProbes(app, downgraded), /GET \/v1\/bootstrap:app_check_bearer:required_protected_operation_missing_or_downgraded/u);
    const removed = structuredClone(OPENAPI_DOCUMENT) as unknown as { paths: Record<string, unknown> };
    delete removed.paths["/v1/bootstrap"];
    await assert.rejects(assertSecurityProbes(app, removed), /required_protected_operation_missing_or_downgraded/u);
  } finally {
    await app.close();
  }
});

test("bootstrap without App Check or bearer never returns component data", async () => {
  const app = buildSecurityProbeApplication(testEnvironment());
  try {
    const missing = await app.inject({ method: "GET", url: "/v1/bootstrap" });
    assert.equal(missing.statusCode, 401);
    assert.deepEqual(missing.json(), { error: { code: "app_check_required" } });
    const invalidQuery = await app.inject({ method: "GET", url: "/v1/bootstrap?include=content" });
    assert.equal(invalidQuery.statusCode, 401, "guard runs before query validation");
  } finally {
    await app.close();
  }
});
