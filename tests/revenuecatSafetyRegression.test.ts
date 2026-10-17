import assert from "node:assert/strict";
import test from "node:test";
import { createRevenueCatEntitlementReader, RevenueCatProviderUnavailableError, type RevenueCatFetch } from "../src/infrastructure/revenuecat/client.js";
import { defaultPremiumMap } from "../src/config/premiumMap.js";
import { SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID, SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID, SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID } from "../src/config/sandboxPromotionalAccess.js";
const observedAt = "2026-09-22T12:00:00.000Z", graceExpiry = "2026-09-22T18:00:00.000Z";
const config = { baseUrl: "https://api.revenuecat.test", apiKey: "server-secret", entitlementId: "premium", productId: "com.lkurczab.patternly.premium.monthly", environment: "SANDBOX" as const, premiumMap: defaultPremiumMap(SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID, "SANDBOX") };
function jsonResponse(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status }); }
function readerFor(body: unknown, options: { timeoutMs?: number; onRequest?: RevenueCatFetch } = {}) { return createRevenueCatEntitlementReader(config, { fetch: options.onRequest ?? (async () => jsonResponse(body)), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }); }
const promoCustomerId = "11111111-1111-4111-8111-111111111111";
const promoProductId = "rc_promo_premium_custom";

function promoPayload(overrides: {
  requestDateMs?: number;
  originalAppUserId?: string;
  entitlement?: Record<string, unknown>;
  subscription?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
  return {
    request_date_ms: overrides.requestDateMs ?? Date.now() - 1_000,
    subscriber: {
      original_app_user_id: overrides.originalAppUserId ?? promoCustomerId,
      entitlements: {
        premium: {
          product_identifier: promoProductId,
          expires_date: expiresAt,
          grace_period_expires_date: null,
          ...overrides.entitlement,
        },
      },
      subscriptions: {
        [promoProductId]: {
          expires_date: expiresAt,
          grace_period_expires_date: null,
          refunded_at: null,
          is_sandbox: false,
          store: "promotional",
          billing_issues_detected_at: null,
          ...overrides.subscription,
        },
      },
    },
  };
}

function promoReader(body: unknown, policyExpiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000).toISOString()) {
  return createRevenueCatEntitlementReader({
    ...config,
    baseUrl: "https://api.revenuecat.com",
    environment: "SANDBOX",
    firebaseProjectId: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID,
    revenueCatProjectId: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID,
    revenueCatAppId: SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID,
    sandboxPromotionalAccess: {
      firebaseProjectId: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID,
      revenueCatProjectId: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID,
      revenueCatAppId: SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID,
      customerId: promoCustomerId,
      expiresAt: policyExpiresAt,
    },
  }, { fetch: async () => jsonResponse(body) });
}

test("sandbox promotional entitlement maps to the configured Patternly Premium namespace and caps expiry at policy cutoff", async () => {
  const policyExpiry = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  const result = await promoReader(promoPayload(), policyExpiry).read(promoCustomerId);
  assert.equal(result.entitlement, "premium");
  assert.equal(result.productId, "com.lkurczab.patternly.premium.monthly");
  assert.equal(result.state, "active");
  assert.equal(result.providerExpiresAt, policyExpiry);
  assert.equal(result.providerGraceExpiresAt, null);
});

test("sandbox promotional entitlement requires exact account, project, app, sandbox and promotional product contract", async () => {
  for (const body of [
    promoPayload({ originalAppUserId: "firebase-uid" }),
    promoPayload({ entitlement: { product_identifier: "rc_promo_unknown" } }),
    promoPayload({ entitlement: { expires_date: new Date(Date.now() + 48 * 60 * 60 * 1_000).toISOString() } }),
    promoPayload({ subscription: { store: "app_store" } }),
    promoPayload({ subscription: { is_sandbox: true } }),
    promoPayload({ subscription: { refunded_at: observedAt } }),
    promoPayload({ subscription: { grace_period_expires_date: graceExpiry } }),
    promoPayload({ subscription: { billing_issues_detected_at: observedAt } }),
  ]) assert.equal((await promoReader(body).read(promoCustomerId)).state, "unavailable");

  assert.equal((await promoReader(promoPayload()).read("another-account")).state, "unavailable");
  assert.equal((await createRevenueCatEntitlementReader({ ...config, environment: "PRODUCTION" }, { fetch: async () => jsonResponse(promoPayload()) }).read(promoCustomerId)).state, "unavailable");
});

test("sandbox promotional entitlement respects both provider and local policy cutoffs", async () => {
  const providerAfterCutoff = Date.now() + 2_000;
  const policyCutoff = new Date(providerAfterCutoff - 1_000).toISOString();
  assert.equal((await promoReader(promoPayload({ requestDateMs: providerAfterCutoff }), policyCutoff).read(promoCustomerId)).state, "unavailable");

  const localExpiredCutoff = new Date(Date.now() - 1_000).toISOString();
  assert.equal((await promoReader(promoPayload(), localExpiredCutoff).read(promoCustomerId)).state, "unavailable");
});

test("RevenueCat network, HTTP, non-JSON and timeout failures are typed and secret-free", async () => {
  const networkReader = readerFor(null, { onRequest: async () => { throw new Error("server-secret network failure"); } });
  await assert.rejects(networkReader.read("user-1"), (error: unknown) => {
    assert.ok(error instanceof RevenueCatProviderUnavailableError);
    assert.equal((error as RevenueCatProviderUnavailableError).kind, "network");
    assert.doesNotMatch((error as Error).message, /server-secret/u);
    return true;
  });

  const httpReader = readerFor(null, { onRequest: async () => jsonResponse({ error: "server-secret" }, 500) });
  await assert.rejects(httpReader.read("user-1"), (error: unknown) => error instanceof RevenueCatProviderUnavailableError && error.kind === "http");

  const nonJsonReader = readerFor(null, { onRequest: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("invalid JSON"); } }) as unknown as Response });
  await assert.rejects(nonJsonReader.read("user-1"), (error: unknown) => error instanceof RevenueCatProviderUnavailableError && error.kind === "non_json");

  const timeoutReader = readerFor(null, { timeoutMs: 10, onRequest: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }) });
  await assert.rejects(timeoutReader.read("user-1"), (error: unknown) => error instanceof RevenueCatProviderUnavailableError && error.kind === "timeout");

  const bodyTimeoutReader = readerFor(null, { timeoutMs: 10, onRequest: async (_url, init) => ({
    ok: true,
    status: 200,
    json: async () => await new Promise<unknown>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("body aborted")), { once: true });
    }),
  }) as unknown as Response });
  await assert.rejects(bodyTimeoutReader.read("user-1"), (error: unknown) => error instanceof RevenueCatProviderUnavailableError && error.kind === "timeout");
});
