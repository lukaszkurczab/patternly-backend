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
  REVENUECAT_WEBHOOK_SECRET: "rate-limit-address-webhook-secret",
  REVENUECAT_PROJECT_ID: "projtest",
  REVENUECAT_APP_ID: "client-error-app",
  REVENUECAT_ENTITLEMENT_ID: "client-error-entitlement",
  REVENUECAT_PRODUCT_ID: "client-error-product",
  REVENUECAT_WEBHOOK_ENVIRONMENT: "SANDBOX",
});


const APP_CHECK_TOKEN = "rate-limit-address-app-check";
const CODE = `pr_${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.${"A".repeat(43)}`;
const CLOUD_RUN_PROXY = "169.254.169.126";

/**
 * SEC-BE-01: on Cloud Run (`*.run.app`, no load balancer) the socket peer is the Google front end
 * (link-local `169.254.169.x`) and the front end appends the real client address as the last
 * `X-Forwarded-For` element, keeping any client-supplied elements before it (probe on sandbox
 * revision `sec-be-01-probe`, 25.11.2026). Rate-limit keys must therefore come from exactly that one
 * trusted hop: the last element, never a client-supplied one and never the shared proxy address.
 * A peer outside the front-end range is not trusted at all.
 */
function application(keys: string[]) {
  const stores = {
    privacyRequests: {
      exchangeGuestCode: async (_code: string, rateLimitKey: string) => { keys.push(rateLimitKey); throw new Error("privacy_request_rate_limited"); },
    },
  } as unknown as BackendStores;
  return buildApplication({
    environment,
    firestore: null,
    verifier: { verify: async () => { throw new Error("unexpected_verifier"); } },
    appCheckVerifier: { verify: async (token) => { if (token !== APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores,
    logStream: { write: () => undefined },
  });
}

async function rateLimitKey(forwardedFor: string | undefined, remoteAddress = CLOUD_RUN_PROXY): Promise<string> {
  const keys: string[] = [];
  const app = application(keys);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/guest/privacy-requests/verify",
      remoteAddress,
      headers: { "content-type": "application/json", "x-firebase-appcheck": APP_CHECK_TOKEN, ...(forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor }) },
      payload: JSON.stringify({ code: CODE }),
    });
    assert.equal(response.statusCode, 429);
  } finally {
    await app.close();
  }
  assert.equal(keys.length, 1);
  return keys[0]!;
}

test("rate-limit key is the client address appended by the single trusted Cloud Run hop", async () => {
  assert.equal(await rateLimitKey("198.51.100.20"), "198.51.100.20");
  assert.equal(await rateLimitKey("198.51.100.21"), "198.51.100.21");
});

test("a spoofed X-Forwarded-For element does not change the rate-limit key", async () => {
  assert.equal(await rateLimitKey("203.0.113.7, 198.51.100.20"), "198.51.100.20");
  assert.equal(await rateLimitKey("203.0.113.7, 203.0.113.8, 198.51.100.20"), "198.51.100.20");
});

test("without X-Forwarded-For the key falls back to the socket peer", async () => {
  assert.equal(await rateLimitKey(undefined), CLOUD_RUN_PROXY);
});

test("a peer that is not the Cloud Run front end cannot choose its key through X-Forwarded-For", async () => {
  assert.equal(await rateLimitKey("203.0.113.7", "198.51.100.50"), "198.51.100.50");
  assert.equal(await rateLimitKey("203.0.113.7, 198.51.100.20", "127.0.0.1"), "127.0.0.1");
});
