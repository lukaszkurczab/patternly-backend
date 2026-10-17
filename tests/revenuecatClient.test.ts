import assert from "node:assert/strict";
import test from "node:test";
import {
  createRevenueCatEntitlementReader,
  RevenueCatProviderUnavailableError,
  type RevenueCatFetch,
  type RevenueCatReaderConfig,
} from "../src/infrastructure/revenuecat/client.js";
import {
  SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID,
  SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID,
  SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID,
} from "../src/config/sandboxPromotionalAccess.js";

const observedAt = "2026-09-22T12:00:00.000Z";
const observedAtMs = Date.parse(observedAt);
const expiry = "2026-09-23T12:00:00.000Z";
const graceExpiry = "2026-09-22T18:00:00.000Z";

const config: RevenueCatReaderConfig = {
  baseUrl: "https://api.revenuecat.test/",
  apiKey: "server-secret",
  entitlementId: "premium",
  productId: "monthly",
  environment: "PRODUCTION",
};

function payload(overrides: {
  entitlement?: Record<string, unknown> | null;
  subscription?: Record<string, unknown> | null;
  requestDateMs?: number;
  originalAppUserId?: string;
} = {}): Record<string, unknown> {
  const entitlement = {
    product_identifier: "monthly",
    expires_date: expiry,
    grace_period_expires_date: null,
    ...overrides.entitlement,
  };
  const subscription = {
    expires_date: expiry,
    grace_period_expires_date: null,
    refunded_at: null,
    is_sandbox: false,
    store: "app_store",
    billing_issues_detected_at: null,
    ...overrides.subscription,
  };
  return {
    request_date_ms: overrides.requestDateMs ?? observedAtMs,
    subscriber: {
      original_app_user_id: overrides.originalAppUserId ?? "user-1",
      entitlements: { premium: overrides.entitlement === null ? undefined : entitlement },
      subscriptions: { monthly: overrides.subscription === null ? undefined : subscription },
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function readerFor(body: unknown, options: { timeoutMs?: number; onRequest?: RevenueCatFetch } = {}) {
  const fetchImpl: RevenueCatFetch = options.onRequest ?? (async () => jsonResponse(body));
  return createRevenueCatEntitlementReader(config, {
    fetch: fetchImpl,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

test("RevenueCat reader returns active and sends the encoded subscriber request", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const reader = readerFor(payload(), {
    onRequest: async (url, init) => {
      requestUrl = url;
      requestInit = init;
      return jsonResponse(payload({ originalAppUserId: "user/with space" }));
    },
  });

  assert.deepEqual(await reader.read("user/with space"), {
    entitlement: "premium",
    productId: "monthly",
    state: "active",
    providerExpiresAt: expiry,
    providerGraceExpiresAt: null,
    providerObservedAt: observedAt,
  });
  assert.equal(requestUrl, "https://api.revenuecat.test/v1/subscribers/user%2Fwith%20space");
  assert.equal(requestInit?.method, "GET");
  assert.deepEqual(requestInit?.headers, { accept: "application/json", authorization: "Bearer server-secret" });
  assert.ok(requestInit?.signal instanceof AbortSignal);
});

test("RevenueCat cancellation keeps access active through the provider expiry", async () => {
  const result = await readerFor(payload({ subscription: { unsubscribe_detected_at: observedAt } })).read("user-1");
  assert.equal(result.state, "active");
  assert.equal(result.providerExpiresAt, expiry);
});

test("RevenueCat billing issue with a future provider grace date returns grace", async () => {
  const result = await readerFor(payload({
    entitlement: { grace_period_expires_date: graceExpiry },
    subscription: { grace_period_expires_date: graceExpiry, billing_issues_detected_at: observedAt },
  })).read("user-1");
  assert.equal(result.state, "grace");
  assert.equal(result.providerGraceExpiresAt, graceExpiry);
});

test("provider grace date confirms grace even when billing issue timestamp is absent", async () => {
  const result = await readerFor(payload({
    entitlement: { expires_date: "2026-09-21T12:00:00.000Z", grace_period_expires_date: graceExpiry },
    subscription: { expires_date: "2026-09-21T12:00:00.000Z", grace_period_expires_date: graceExpiry },
  })).read("user-1");
  assert.equal(result.state, "grace");
});

test("RevenueCat billing issue without a future grace date returns hold", async () => {
  const result = await readerFor(payload({ subscription: { billing_issues_detected_at: observedAt } })).read("user-1");
  assert.equal(result.state, "hold");
  assert.equal(result.providerGraceExpiresAt, null);
});

test("RevenueCat expiry is evaluated against request_date_ms and never extended locally", async () => {
  const result = await readerFor(payload({
    requestDateMs: Date.parse("2026-09-24T12:00:00.000Z"),
  })).read("user-1");
  assert.equal(result.state, "expired");
  assert.equal(result.providerExpiresAt, expiry);
});

test("RevenueCat refund takes precedence over the expiry state", async () => {
  const result = await readerFor(payload({ subscription: { refunded_at: observedAt } })).read("user-1");
  assert.equal(result.state, "refunded");
});

test("RevenueCat absent entitlement or subscription is expired", async () => {
  const absentEntitlement = await readerFor(payload({ entitlement: null })).read("user-1");
  const absentSubscription = await readerFor(payload({ subscription: null })).read("user-1");
  assert.equal(absentEntitlement.state, "expired");
  assert.equal(absentSubscription.state, "expired");
  assert.equal(absentEntitlement.providerExpiresAt, null);
  assert.equal(absentSubscription.providerExpiresAt, null);
});

test("RevenueCat product or environment mismatch is unavailable", async () => {
  const mismatchedProduct = await readerFor(payload({ entitlement: { product_identifier: "annual" } })).read("user-1");
  const mismatchedEnvironment = await readerFor(payload({ subscription: { is_sandbox: true } })).read("user-1");
  assert.equal(mismatchedProduct.state, "unavailable");
  assert.equal(mismatchedEnvironment.state, "unavailable");
});

test("RevenueCat alias or transferred customer cannot confirm another Patternly account", async () => {
  const result = await readerFor(payload({ originalAppUserId: "other-user" })).read("user-1");
  assert.equal(result.state, "unavailable");
});

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
  assert.equal(result.productId, "monthly");
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

test("missing entitlement or subscription map is unavailable rather than an authoritative expiry", async () => {
  const noEntitlementMap = payload();
  const noSubscriptionMap = payload();
  delete (noEntitlementMap.subscriber as Record<string, unknown>).entitlements;
  delete (noSubscriptionMap.subscriber as Record<string, unknown>).subscriptions;
  assert.equal((await readerFor(noEntitlementMap).read("user-1")).state, "unavailable");
  assert.equal((await readerFor(noSubscriptionMap).read("user-1")).state, "unavailable");
});

test("RevenueCat missing required expiry is unavailable", async () => {
  const result = await readerFor(payload({
    entitlement: { expires_date: null },
    subscription: { expires_date: null },
  })).read("user-1");
  assert.equal(result.state, "unavailable");
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

for (const store of ["play_store", "test_store", "stripe", "APP_STORE", ""]) {
  test(`RevenueCat reader rejects unsupported store ${store}`, async () => {
    assert.equal((await readerFor(payload({ subscription: { store } })).read("user-1")).state, "unavailable");
  });
}
