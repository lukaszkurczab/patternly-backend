import assert from "node:assert/strict";
import test from "node:test";
import { buildApplication } from "../src/api/app.js";
import { loadEnvironment } from "../src/config/environment.js";
import type { BackendStores } from "../src/infrastructure/firestore/stores.js";
import type { AuthenticatedIdentity } from "../src/modules/auth/contracts.js";

const operationId = "11111111-1111-4111-8111-111111111111";
const owner = "recovery-owner";
const generation = 2;
const environment = loadEnvironment({
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  REPORT_RATE_LIMIT_HASH_SECRET: "recovery-route-test-rate-limit-secret-0123456789",
  DELETION_PSEUDONYM_KEYS_JSON: "[]",
  PRIVACY_RESPONSE_KEY_BASE64: Buffer.alloc(32, 11).toString("base64"),
  PRIVACY_AUDIT_HMAC_SECRET: "recovery-route-test-privacy-secret-0123456789",
  RECOVERY_OPERATION_KEYS_JSON: JSON.stringify({ version: 1, keys: [{ version: "v1", status: "active", keyBase64: Buffer.alloc(32, 17).toString("base64") }] }),
});
const validHeaders = { "x-firebase-appcheck": "valid-app-check", authorization: "Bearer valid-auth" };
const routes = [
  { method: "GET", path: "/v1/account/recovery-codes/issue/status", handler: "readRecoveryCodeIssueStatus" },
  { method: "POST", path: "/v1/account/recovery-codes/issue/saved-ack", handler: "acknowledgeRecoveryCodeIssue" },
  { method: "POST", path: "/v1/account/recovery-codes/consume/ack", handler: "acknowledgeRecovery" },
] as const;
type RecoveryRoute = typeof routes[number];
type AppCheckMode = "configured" | "unconfigured" | "throwing";

// These doubles model the existing store boundary, not Firestore transactions or provider attestation.
function fixture(mode: AppCheckMode = "configured") {
  const calls = { appCheck: 0, auth: 0, accountReads: 0, rateLimit: 0, operations: [] as { handler: string; args: unknown[] }[], effects: 0 };
  const lifecycle = (handler: string) => async (...args: unknown[]) => {
    calls.operations.push({ handler, args });
    const [id, userId, expectedGeneration] = args;
    assert.equal(id, operationId);
    if (userId !== owner) {
      if (handler === "readRecoveryCodeIssueStatus") return null;
      throw new Error("recovery_operation_conflict");
    }
    if (expectedGeneration !== generation) throw new Error(handler === "readRecoveryCodeIssueStatus" ? "authorization_generation_conflict" : "recovery_operation_conflict");
    if (handler === "readRecoveryCodeIssueStatus") return { operationId, status: "delivery_unconfirmed", authorizationGeneration: generation };
    calls.effects += 1;
    return { operationId, status: "acknowledged", authorizationGeneration: generation };
  };
  const stores = {
    users: {
      async resolveExistingUser(identity: AuthenticatedIdentity) {
        calls.accountReads += 1;
        // Match the production resolver's generation policy; missing/stale claims never reach lifecycle.
        if (identity.authorizationGeneration === undefined) throw new Error("authorization_generation_required");
        if (identity.authorizationGeneration === 1) throw new Error("authorization_generation_stale");
        return { userId: identity.subject === "other-owner" ? "other-owner" : owner, authorizationGeneration: identity.authorizationGeneration };
      },
    },
    accountLifecycle: {
      claimRecoveryRequestRateLimit: async () => { calls.rateLimit += 1; },
      readRecoveryCodeIssueStatus: lifecycle("readRecoveryCodeIssueStatus"),
      acknowledgeRecoveryCodeIssue: lifecycle("acknowledgeRecoveryCodeIssue"),
      acknowledgeRecovery: lifecycle("acknowledgeRecovery"),
      readRecoveryOperationStatus: async (id: string, code: string) => {
        calls.operations.push({ handler: "readRecoveryOperationStatus", args: [id, code] });
        return { operationId: id, status: "expired_or_invalid" };
      },
      issueRecoveryCodes: async () => { throw new Error("unexpected_issue_effect"); },
    },
  } as unknown as BackendStores;
  const app = buildApplication({
    environment,
    firestore: null,
    stores,
    appCheckVerifier: mode === "unconfigured" ? null : {
      async verify(token) {
        calls.appCheck += 1;
        if (mode === "throwing") throw new Error("provider_temporarily_unavailable");
        if (token !== "valid-app-check") throw new Error("app_check_invalid");
      },
    },
    verifier: {
      async verify(token) {
        calls.auth += 1;
        if (token === "invalid-auth") throw new Error("firebase_token_invalid");
        return {
          provider: "firebase" as const,
          subject: token === "other-owner" ? "other-owner" : owner,
          emailVerified: true,
          authTime: Math.floor(Date.now() / 1000) - (token === "old-reauth" ? 600 : 0),
          ...(token === "missing-generation" ? {} : { authorizationGeneration: token === "stale-generation" ? 1 : token === "new-generation" ? 3 : generation }),
        };
      },
    },
  });
  return { app, calls };
}

function request(route: RecoveryRoute, headers: Record<string, string>) {
  return {
    method: route.method,
    url: `${route.path}${route.method === "GET" ? `?operationId=${operationId}` : ""}`,
    headers,
    ...(route.method === "POST" ? { payload: { operationId } } : {}),
  };
}

for (const route of routes) {
  test(`${route.path}: App Check rejects before auth, account reads, limiter and lifecycle`, async () => {
    for (const scenario of [
      { mode: "configured", token: undefined, code: "app_check_required", status: 401 },
      { mode: "configured", token: "invalid-app-check", code: "app_check_invalid", status: 401 },
      { mode: "unconfigured", token: "valid-app-check", code: "app_check_not_configured", status: 503 },
      { mode: "throwing", token: "valid-app-check", code: "app_check_invalid", status: 401 },
    ] as const) {
      for (const bearer of [undefined, "valid-auth", "invalid-auth"]) {
        const { app, calls } = fixture(scenario.mode);
        try {
          const response = await app.inject(request(route, {
            ...(scenario.token === undefined ? {} : { "x-firebase-appcheck": scenario.token }),
            ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
          }));
          assert.equal(response.statusCode, scenario.status);
          assert.deepEqual(response.json(), { error: { code: scenario.code } });
          assert.equal(response.headers["cache-control"], "private, no-store");
          assert.equal(calls.auth, 0);
          assert.equal(calls.accountReads, 0);
          assert.equal(calls.rateLimit, 0);
          assert.deepEqual(calls.operations, []);
          assert.equal(calls.effects, 0);
        } finally { await app.close(); }
      }
    }
  });

  test(`${route.path}: valid App Check still requires bearer and current account generation`, async () => {
    for (const [token, code] of [
      [undefined, "authentication_required"],
      ["invalid-auth", "authentication_required"],
      ["missing-generation", "authorization_generation_required"],
      ["stale-generation", "authorization_generation_stale"],
    ] as const) {
      const { app, calls } = fixture();
      try {
        const response = await app.inject(request(route, { "x-firebase-appcheck": "valid-app-check", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) }));
        assert.equal(response.statusCode, 401);
        assert.deepEqual(response.json(), { error: { code } });
        assert.equal(response.headers["cache-control"], "private, no-store");
        assert.equal(calls.appCheck, 1);
        assert.equal(calls.rateLimit, 0);
        assert.deepEqual(calls.operations, []);
        assert.equal(calls.effects, 0);
      } finally { await app.close(); }
    }
  });

  test(`${route.path}: valid pair reaches only the bound handler with exact ownership and generation`, async () => {
    const { app, calls } = fixture();
    try {
      const response = await app.inject(request(route, validHeaders));
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { operationId, status: route.method === "GET" ? "delivery_unconfirmed" : "acknowledged", authorizationGeneration: generation });
      assert.equal(response.headers["cache-control"], "private, no-store");
      assert.equal(calls.appCheck, 1);
      assert.equal(calls.auth, 1);
      assert.equal(calls.accountReads, 1);
      assert.equal(calls.rateLimit, 1);
      assert.deepEqual(calls.operations, [{ handler: route.handler, args: [operationId, owner, generation] }]);
      assert.equal(calls.effects, route.method === "GET" ? 0 : 1);
    } finally { await app.close(); }
  });

  test(`${route.path}: lifecycle ownership and operation generation rejections remain visible`, async () => {
    for (const token of ["other-owner", "new-generation"]) {
      const { app, calls } = fixture();
      try {
        const response = await app.inject(request(route, { ...validHeaders, authorization: `Bearer ${token}` }));
        const isRead = route.method === "GET";
        const code = isRead ? token === "other-owner" ? "recovery_operation_unavailable" : "authorization_generation_conflict" : "recovery_operation_conflict";
        assert.equal(response.statusCode, isRead && token === "other-owner" ? 404 : 409);
        assert.deepEqual(response.json(), { error: { code } });
        assert.equal(response.headers["cache-control"], "private, no-store");
        assert.deepEqual(calls.operations, [{ handler: route.handler, args: [operationId, token === "other-owner" ? "other-owner" : owner, token === "new-generation" ? 3 : generation] }]);
        assert.equal(calls.effects, 0);
      } finally { await app.close(); }
    }
  });
}

test("original issue still requires recent reauthentication before limiter or issue effect", async () => {
  const { app, calls } = fixture();
  try {
    const response = await app.inject({ method: "POST", url: "/v1/account/recovery-codes", headers: { ...validHeaders, authorization: "Bearer old-reauth" }, payload: { operationId } });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: { code: "recent_reauthentication_required" } });
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(calls.rateLimit, 0);
    assert.deepEqual(calls.operations, []);
    assert.equal(calls.effects, 0);
  } finally { await app.close(); }
});

test("public consume/status remains App Check-only and forwards code proof without bearer", async () => {
  const { app, calls } = fixture();
  try {
    const code = "ABCD-EFGH-JKLM-NPQR";
    const response = await app.inject({ method: "POST", url: "/v1/public/recovery-codes/consume/status", headers: { "x-firebase-appcheck": "valid-app-check" }, payload: { operationId, code } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { operationId, status: "expired_or_invalid" });
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(calls.auth, 0);
    assert.equal(calls.accountReads, 0);
    assert.equal(calls.rateLimit, 1);
    assert.deepEqual(calls.operations, [{ handler: "readRecoveryOperationStatus", args: [operationId, code] }]);
    assert.equal(calls.effects, 0);
  } finally { await app.close(); }
});
