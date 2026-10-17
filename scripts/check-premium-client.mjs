import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parsePremiumMap, productIdentifier } from "../src/config/premiumMap.ts";
import { createRevenueCatEntitlementReader } from "../src/infrastructure/revenuecat/client.ts";

const mobileRoot = resolve(process.env.PATTERNLY_FRONTEND_ROOT ?? "../patternly");
const { premiumCacheFromFreshResponse, evaluateOfflinePremiumAccess } = await import(pathToFileURL(resolve(mobileRoot, "src/domain/entitlements/premiumEntitlement.ts")).href);
const map = parsePremiumMap(JSON.parse(await readFile(new URL("../tests/fixtures/premiumMap.fixture.json", import.meta.url), "utf8")), { allowTestFixtures: true });
const accountId = "00000000-0000-4000-8000-000000000001";
const now = Date.parse("2026-10-17T12:00:00.000Z"), end = now + 86_400_000;
const identity = { accountId, entitlement: "premium", productId: "com.lkurczab.patternly.premium.monthly", projectId: map.projectId, environment: map.environment, mapVersion: map.version };
let checks = 0;
for (const binding of map.bindings) {
  for (const state of ["active", "grace", "hold", "paused", "expired"]) {
    const status = { active: "active", grace: "in_grace_period", hold: "in_billing_retry", paused: "paused", expired: "expired" }[state];
    const graceEnd = state === "grace" ? new Date(end).toISOString() : null;
    const subscription = {
      id: "fixture-subscription", customer_id: accountId, original_customer_id: accountId,
      product_id: binding.rcProductId, store: binding.store === "APP_STORE" ? "app_store" : "play_store",
      environment: "sandbox", status, gives_access: ["active", "grace"].includes(state), pending_payment: false,
      ends_at: state === "grace" ? now - 1000 : end, store_subscription_identifier: "fixture-exact-transaction",
      management_url: binding.store === "APP_STORE" ? "https://apps.apple.com/account/subscriptions" : "https://play.google.com/store/account/subscriptions",
      entitlements: { items: [{ id: "fixture-entitlement-resource", project_id: map.projectId }], next_page: null },
    };
    const reader = createRevenueCatEntitlementReader({
      baseUrl: "https://api.revenuecat.test", apiKey: "explicit-local-v1-fixture", v2ApiKey: "explicit-local-v2-fixture", entitlementId: "premium",
      productId: identity.productId, environment: map.environment, revenueCatProjectId: map.projectId,
      premiumMap: map, allowTestFixtures: true,
    }, { fetch: async (url) => {
      const path = new URL(url).pathname;
      let payload;
      if (path.startsWith("/v1/subscribers/")) payload = { request_date_ms: now, subscriber: {
        original_app_user_id: accountId,
        entitlements: { premium: { product_identifier: productIdentifier(binding), grace_period_expires_date: graceEnd } },
        subscriptions: { [productIdentifier(binding)]: { store: subscription.store, is_sandbox: true, store_transaction_id: "fixture-exact-transaction", grace_period_expires_date: graceEnd } },
      } };
      else if (path.endsWith("/products")) payload = { items: map.bindings.map(row => ({
        id: row.rcProductId, app_id: row.appId, store_identifier: productIdentifier(row), type: "subscription", state: "active",
        app: { id: row.appId, type: row.store === "APP_STORE" ? "app_store" : "play_store", project_id: map.projectId },
      })), next_page: null };
      else if (path.endsWith("/entitlements")) payload = { items: [{ id: "fixture-entitlement-resource", lookup_key: "premium", project_id: map.projectId }], next_page: null };
      else if (path.endsWith("/subscriptions")) payload = { items: [subscription], next_page: null };
      else throw new Error("unexpected_fixture_request");
      return new Response(JSON.stringify(payload));
    } });
    const result = await reader.read(accountId);
    assert.notEqual(result.state, "unavailable", `${binding.store}/${state}`);
    // The actual reader's wire output is consumed by the APP's exact-key parser.
    const response = JSON.parse(JSON.stringify({ serverObservedAt: new Date(now).toISOString(), entitlements: [{ accountId, ...result, source: "revenuecat" }] }));
    const cache = premiumCacheFromFreshResponse(response, identity, now, null);
    assert.ok(cache, `${binding.store}/${state}: producer rejected by consumer`);
    assert.equal(evaluateOfflinePremiumAccess(cache, identity, now).allowed, ["active", "grace"].includes(state));
    assert.equal(evaluateOfflinePremiumAccess(cache, { ...identity, mapVersion: "foreign-map" }, now).allowed, false);
    assert.equal(evaluateOfflinePremiumAccess(cache, { ...identity, environment: "PRODUCTION" }, now).allowed, false);
    assert.equal(evaluateOfflinePremiumAccess(cache, identity, end).allowed, false);
    checks++;
  }
}
console.log(`Premium reader → APP cache: ${checks} store/lifecycle cases PASS; map/environment/expiry rejection PASS.`);
