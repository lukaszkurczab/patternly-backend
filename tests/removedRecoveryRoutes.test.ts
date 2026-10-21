import assert from "node:assert/strict";
import test from "node:test";
import { buildApplication } from "../src/api/app.js";
import { loadEnvironment } from "../src/config/environment.js";
import type { BackendStores } from "../src/infrastructure/firestore/stores.js";

const environment = loadEnvironment({
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "8080",
  LOG_LEVEL: "silent",
  REPORT_RATE_LIMIT_HASH_SECRET: "test-only-report-rate-limit-secret-0123456789",
  DELETION_PSEUDONYM_KEYS_JSON: JSON.stringify([{ version: "test-v1", status: "active", keyBase64: Buffer.alloc(32, 7).toString("base64") }]),
  PRIVACY_RESPONSE_KEY_BASE64: Buffer.alloc(32, 11).toString("base64"),
  PRIVACY_AUDIT_HMAC_SECRET: "test-only-privacy-audit-hmac-secret-0123456789",
});

const retiredRoutes = [
  { method: "POST" as const, url: "/v1/account/recovery-codes", payload: { operationId: "11111111-1111-4111-8111-111111111111" } },
  { method: "POST" as const, url: "/v1/public/recovery-codes/consume", payload: { operationId: "11111111-1111-4111-8111-111111111111", code: "ABCD-EFGH-JKLM-NPQR" } },
  { method: "POST" as const, url: "/v1/public/recovery-codes/consume/status", payload: { operationId: "11111111-1111-4111-8111-111111111111", code: "ABCD-EFGH-JKLM-NPQR" } },
  { method: "POST" as const, url: "/v1/account/recovery-codes/consume/ack", payload: { operationId: "11111111-1111-4111-8111-111111111111" } },
  { method: "GET" as const, url: "/v1/account/recovery-codes/issue/status?operationId=11111111-1111-4111-8111-111111111111" },
  { method: "POST" as const, url: "/v1/account/recovery-codes/issue/saved-ack", payload: { operationId: "11111111-1111-4111-8111-111111111111" } },
];

test("all retired Recovery Codes API paths are unregistered and cannot reach auth, App Check, or stores", async () => {
  let identityVerifications = 0;
  let appCheckVerifications = 0;
  let lifecycleCalls = 0;
  const accountLifecycle = new Proxy({}, {
    get: () => async () => { lifecycleCalls += 1; },
  });
  const app = buildApplication({
    environment,
    firestore: null,
    verifier: { verify: async () => { identityVerifications += 1; throw new Error("unexpected_identity_verification"); } },
    appCheckVerifier: { verify: async () => { appCheckVerifications += 1; throw new Error("unexpected_app_check_verification"); } },
    stores: { accountLifecycle } as unknown as BackendStores,
  });
  try {
    for (const credentials of [
      {},
      { authorization: "Bearer retired-api-probe", "x-firebase-appcheck": "retired-app-check-probe" },
    ]) {
      for (const route of retiredRoutes) {
        const response = await app.inject({
          method: route.method,
          url: route.url,
          headers: credentials,
          ...(route.payload ? { payload: route.payload } : {}),
        });
        assert.equal(response.statusCode, 404, `${route.method} ${route.url} must be a missing route`);
      }
    }
  } finally {
    await app.close();
  }
  assert.equal(identityVerifications, 0);
  assert.equal(appCheckVerifications, 0);
  assert.equal(lifecycleCalls, 0);
});
