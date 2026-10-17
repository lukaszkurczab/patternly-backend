import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parsePremiumMap } from "../src/config/premiumMap.js";
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

const projectId = "fixture-project";
const entitlementId = "premium";
const entitlementResourceId = "fixture-entitlement";
const userId = "account-1";
const observedAt = Date.parse("2026-10-17T12:00:00.000Z");
const expiry = Date.parse("2026-10-18T12:00:00.000Z");
const graceExpiry = Date.parse("2026-10-17T18:00:00.000Z");
const mapFixture = JSON.parse(await readFile(new URL("./fixtures/premiumMap.fixture.json", import.meta.url), "utf8")) as unknown;
const map = parsePremiumMap(mapFixture, { allowTestFixtures: true });
const appleBinding = map.bindings.find((binding) => binding.platform === "ios")!;
const playBinding = map.bindings.find((binding) => binding.platform === "android")!;

const config: RevenueCatReaderConfig = {
  baseUrl: "https://api.revenuecat.test",
  apiKey: "server-secret",
  v2ApiKey: "server-v2-secret",
  entitlementId,
  productId: "legacy-product-ignored-by-paid-reader",
  environment: "SANDBOX",
  revenueCatProjectId: projectId,
  premiumMap: map,
  allowTestFixtures: true,
};

type SubscriptionOverrides = Partial<Record<string, unknown>>;
function v2Subscription(binding: typeof appleBinding | typeof playBinding, overrides: SubscriptionOverrides = {}): Record<string, unknown> {
  return {
    id: `sub-${binding.platform}`,
    customer_id: userId,
    original_customer_id: userId,
    product_id: binding.rcProductId,
    store: binding.store === "APP_STORE" ? "app_store" : "play_store",
    environment: "sandbox",
    status: "active",
    gives_access: true,
    pending_payment: false,
    ends_at: expiry,
    store_subscription_identifier: binding.platform === "ios" ? "100000000000001" : "GPA.1234-5678-9012-34567..0",
    management_url: binding.store === "APP_STORE" ? "https://apps.apple.com/account/subscriptions" : "https://play.google.com/store/account/subscriptions",
    entitlements: { object: "list", items: [{ id: entitlementResourceId, project_id: projectId, state: "active" }], next_page: null },
    ...overrides,
  };
}

function v1Payload(overrides: {
  owner?: string;
  subscriptionKey?: string;
  subscription?: Record<string, unknown>;
  entitlement?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  const key = overrides.subscriptionKey ?? appleBinding.storeProductId;
  return {
    request_date_ms: observedAt,
    subscriber: {
      original_app_user_id: overrides.owner ?? userId,
      entitlements: { [entitlementId]: { product_identifier: key, grace_period_expires_date: null, ...overrides.entitlement } },
      subscriptions: {
        [key]: {
          store: key === appleBinding.storeProductId ? "app_store" : "play_store",
          is_sandbox: true,
          store_transaction_id: key === appleBinding.storeProductId ? 100000000000001 : "GPA.1234-5678-9012-34567..0",
          grace_period_expires_date: null,
          ...overrides.subscription,
        },
      },
    },
  };
}

function productsPage(overrides: { next?: unknown; products?: Record<string, unknown>[] } = {}): Record<string, unknown> {
  const products = overrides.products ?? map.bindings.map((binding) => ({
    state: "active",
    id: binding.rcProductId,
    app_id: binding.appId,
    app: { id: binding.appId, project_id: projectId, type: binding.store === "APP_STORE" ? "app_store" : "play_store" },
    project_id: projectId,
    type: "subscription",
    store_identifier: binding.platform === "android" ? `${binding.storeProductId}:${binding.basePlanId}` : binding.storeProductId,
  }));
  return { object: "list", items: products, next_page: overrides.next ?? null };
}

function defaultProductRows(): Record<string, unknown>[] {
  return productsPage().items as Record<string, unknown>[];
}

function entitlementsPage(): Record<string, unknown> {
  return { object: "list", items: [{ id: entitlementResourceId, project_id: projectId, lookup_key: "premium" }], next_page: null };
}

function subscriptionsPage(subscriptions: Record<string, unknown>[], next: unknown = null): Record<string, unknown> {
  return { object: "list", items: subscriptions, next_page: next };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function readerFor(options: {
  v1?: unknown;
  products?: unknown;
  subscriptions?: unknown;
  fetch?: RevenueCatFetch;
  extraPages?: Map<string, unknown>;
} = {}) {
  const fetchImpl: RevenueCatFetch = options.fetch ?? (async (url) => {
    if (url.includes("/v1/subscribers/")) return jsonResponse(options.v1 ?? v1Payload());
    if (url.includes("/products")) return jsonResponse(options.extraPages?.get(url) ?? options.products ?? productsPage());
    if (url.includes("/entitlements")) return jsonResponse(entitlementsPage());
    return jsonResponse(options.extraPages?.get(url) ?? options.subscriptions ?? subscriptionsPage([v2Subscription(appleBinding)]));
  });
  return createRevenueCatEntitlementReader(config, { fetch: fetchImpl });
}

test("reader validates v1 owner and returns one scoped v2 source for active access", async () => {
  const seen: string[] = [];
  const result = await readerFor({ fetch: async (url, init) => {
    seen.push(url);
    assert.equal((init?.headers as Record<string, string>).authorization, url.includes("/v1/") ? "Bearer server-secret" : "Bearer server-v2-secret");
    return jsonResponse(url.includes("/v1/subscribers/") ? v1Payload() : url.includes("/products") ? productsPage() : url.includes("/entitlements") ? entitlementsPage() : subscriptionsPage([v2Subscription(appleBinding)]));
  } }).read(userId);
  assert.equal(seen.length, 4);
  assert.deepEqual(result, {
    entitlement: "premium",
    productId: "com.lkurczab.patternly.premium.monthly",
    state: "active",
    providerExpiresAt: new Date(expiry).toISOString(),
    providerGraceExpiresAt: null,
    providerObservedAt: new Date(observedAt).toISOString(),
    projectId,
    mapVersion: "premium-map-fixture-v1",
    environment: "SANDBOX",
    reason: null,
    sources: [{ ...appleBinding, state: "active", reason: null, managementURL: "https://apps.apple.com/account/subscriptions", providerExpiresAt: new Date(expiry).toISOString(), providerGraceExpiresAt: null }],
  });
});

test("reader fully follows product catalog and subscription next_page URLs", async () => {
  const secondProducts = "https://api.revenuecat.test/v2/projects/fixture-project/products?starting_after=page1";
  const secondSubscriptions = "https://api.revenuecat.test/v2/projects/fixture-project/customers/account-1/subscriptions?starting_after=sub1";
  const requested: string[] = [];
  const result = await readerFor({ fetch: async (url) => {
    requested.push(url);
    if (url.includes("/v1/subscribers/")) return jsonResponse(v1Payload());
    if (url === secondProducts) return jsonResponse(productsPage({ products: [defaultProductRows()[1]!] }));
    if (url.includes("/products?")) return jsonResponse(productsPage({ products: [defaultProductRows()[0]!], next: secondProducts }));
    if (url.includes("/subscriptions?") || url.endsWith("/subscriptions")) {
      return url.endsWith("/subscriptions") ? jsonResponse(subscriptionsPage([], secondSubscriptions)) : jsonResponse(subscriptionsPage([v2Subscription(playBinding)]));
    }
    if (url.includes("/entitlements")) return jsonResponse(entitlementsPage());
    throw new Error("unexpected_request");
  } }).read(userId);
  assert.ok(requested.includes(secondProducts));
  assert.ok(requested.includes(secondSubscriptions));
  assert.equal(result.sources[0]?.platform, "android");
  assert.equal(result.sources[0]?.storeProductId, "fixture_play_monthly");
});

test("v2 scope, owner, environment, catalog and incomplete paging failures never grant access", async () => {
  const cases: Array<{ label: string; input: Parameters<typeof readerFor>[0] }> = [
    { label: "wrong original owner", input: { subscriptions: subscriptionsPage([v2Subscription(appleBinding, { original_customer_id: "alias" })]) } },
    { label: "wrong product catalog app", input: { products: productsPage({ products: [{ ...defaultProductRows()[0]!, app_id: "foreign-app", app: { id: "foreign-app", project_id: projectId, type: "app_store" } }] }) } },
    { label: "wrong environment", input: { subscriptions: subscriptionsPage([v2Subscription(appleBinding, { environment: "production" })]) } },
    { label: "unknown status", input: { subscriptions: subscriptionsPage([v2Subscription(appleBinding, { status: "future_status" })]) } },
    { label: "incomplete page", input: { subscriptions: subscriptionsPage([], "https://foreign.example/next") } },
  ];
  for (const item of cases) {
    const read = readerFor(item.input).read(userId);
    if (item.label === "wrong original owner") {
      const result = await read;
      assert.equal(result.state, "unavailable", item.label);
      assert.equal(result.reason, "identity_conflict", item.label);
    } else if (item.label === "wrong environment" || item.label === "unknown status") {
      assert.equal((await read).state, "unavailable", item.label);
    } else {
      await assert.rejects(read, (error: unknown) => error instanceof RevenueCatProviderUnavailableError, item.label);
    }
  }
});

test("active and grace access use positive v2 gives_access and exact v1 transaction matching", async () => {
  const active = await readerFor({ subscriptions: subscriptionsPage([v2Subscription(appleBinding, { status: "in_billing_retry", gives_access: false })]) }).read(userId);
  assert.equal(active.state, "hold");
  assert.equal(active.sources[0]?.reason, "account_hold");

  const grace = await readerFor({
    v1: v1Payload({ subscription: { store_transaction_id: "100000000000001", grace_period_expires_date: new Date(graceExpiry).toISOString() }, entitlement: { grace_period_expires_date: new Date(graceExpiry).toISOString() } }),
    subscriptions: subscriptionsPage([v2Subscription(appleBinding, { status: "in_grace_period", ends_at: expiry })]),
  }).read(userId);
  assert.equal(grace.state, "grace");
  assert.equal(grace.providerGraceExpiresAt, new Date(graceExpiry).toISOString());

  const unsafe = await readerFor({
    v1: v1Payload({ subscription: { store_transaction_id: 9007199254740992, grace_period_expires_date: new Date(graceExpiry).toISOString() } }),
    subscriptions: subscriptionsPage([v2Subscription(appleBinding, { status: "in_grace_period" })]),
  }).read(userId);
  assert.equal(unsafe.state, "unavailable");
});

test("two active store sources grant one premium and preserve both management URLs", async () => {
  const result = await readerFor({
    subscriptions: subscriptionsPage([v2Subscription(appleBinding), v2Subscription(playBinding)]),
  }).read(userId);
  assert.equal(result.state, "active");
  assert.deepEqual(result.sources.map((source) => source.platform), ["ios", "android"]);
});

test("OR aggregation selects timestamps from the source with the latest effective access end", async () => {
  const playKey = "fixture_play_monthly:monthly";
  const withPlayGrace = (graceEnd: number) => ({
    request_date_ms: observedAt,
    subscriber: {
      original_app_user_id: userId,
      entitlements: { premium: { product_identifier: playKey, grace_period_expires_date: new Date(graceEnd).toISOString() } },
      subscriptions: { [playKey]: { store: "play_store", is_sandbox: true, store_transaction_id: "GPA.1234-5678-9012-34567..0", grace_period_expires_date: new Date(graceEnd).toISOString() } },
    },
  });
  const playGrace = v2Subscription(playBinding, { status: "in_grace_period", ends_at: observedAt - 1 });

  const activeWins = await readerFor({ v1: withPlayGrace(observedAt + 6 * 60 * 60 * 1_000), subscriptions: subscriptionsPage([
    v2Subscription(appleBinding), playGrace,
  ]) }).read(userId);
  assert.equal(activeWins.state, "active");
  assert.equal(activeWins.providerExpiresAt, new Date(expiry).toISOString());
  assert.equal(activeWins.providerGraceExpiresAt, null);

  const graceWins = await readerFor({ v1: withPlayGrace(observedAt + 36 * 60 * 60 * 1_000), subscriptions: subscriptionsPage([
    v2Subscription(appleBinding), playGrace,
  ]) }).read(userId);
  assert.equal(graceWins.state, "grace");
  assert.equal(graceWins.providerExpiresAt, new Date(observedAt - 1).toISOString());
  assert.equal(graceWins.providerGraceExpiresAt, new Date(observedAt + 36 * 60 * 60 * 1_000).toISOString());
});

test("promotional access remains constrained to the configured test customer and cutoff", async () => {
  const promoCustomerId = "sandbox-test-account";
  const promoExpiresAt = "2026-10-20T12:00:00.000Z";
  const promoMap = parsePremiumMap({
    version: "premium-map-v1", projectId: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID, entitlementId: "premium", environment: "SANDBOX",
    bindings: [{ platform: "ios", store: "APP_STORE", appId: "app7b06e9a4c1", rcProductId: "prod8d07384c8c", storeProductId: "com.lkurczab.patternly.premium.monthly", basePlanId: null }],
  });
  const promoConfig = { ...config, baseUrl: "https://api.revenuecat.com", premiumMap: promoMap, revenueCatProjectId: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID, revenueCatAppId: SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID, firebaseProjectId: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID,
    sandboxPromotionalAccess: { customerId: promoCustomerId, expiresAt: promoExpiresAt,
      firebaseProjectId: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID, revenueCatProjectId: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID,
      revenueCatAppId: SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID } };
  const subscriber = {
    original_app_user_id: promoCustomerId,
    entitlements: { [entitlementId]: { product_identifier: "rc_promo_premium_custom", expires_date: new Date(expiry).toISOString(), grace_period_expires_date: null } },
    subscriptions: { rc_promo_premium_custom: { store: "promotional", is_sandbox: false, expires_date: new Date(expiry).toISOString(), grace_period_expires_date: null, refunded_at: null, billing_issues_detected_at: null } },
  };
  const result = await createRevenueCatEntitlementReader(promoConfig, { fetch: async () => jsonResponse({ request_date_ms: observedAt, subscriber }) }).read(promoCustomerId);
  assert.equal(result.state, "active");
  assert.equal(result.reason, "promotional");
  assert.deepEqual(result.sources, []);
});

test("paid reader never substitutes its v1 credential for a missing v2 credential", async () => {
  let calls = 0;
  await assert.rejects(createRevenueCatEntitlementReader({ ...config, v2ApiKey: undefined }, { fetch: async () => {
    calls++; return jsonResponse(v1Payload());
  } }).read(userId), RevenueCatProviderUnavailableError);
  assert.equal(calls, 1);
});
