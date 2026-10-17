import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { defaultPremiumMap, findBinding, parsePremiumMap, productIdentifier } from "../src/config/premiumMap.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/premiumMap.fixture.json", import.meta.url), "utf8")) as unknown;

test("default map pins the verified Apple row and leaves Play unconfigured", () => {
  const map = defaultPremiumMap("proj8ae78267", "SANDBOX");
  assert.ok(map);
  assert.equal(map.version, "premium-map-v1");
  assert.equal(map.bindings.length, 1);
  assert.deepEqual(map.bindings[0], {
    platform: "ios", store: "APP_STORE", appId: "app7b06e9a4c1", rcProductId: "prod8d07384c8c",
    storeProductId: "com.lkurczab.patternly.premium.monthly", basePlanId: null,
  });
  assert.equal(defaultPremiumMap("projtest", "SANDBOX"), null);
  assert.equal(defaultPremiumMap("proj8ae78267", undefined), null);
});

test("fixture bindings require explicit test mode and preserve the three product identifiers", () => {
  assert.throws(() => parsePremiumMap(fixture), /premium_map_fixture_forbidden/u);
  const map = parsePremiumMap(fixture, { allowTestFixtures: true });
  const play = findBinding(map, { appId: "fixture-play", productId: "fixture-rc-play", store: "PLAY_STORE" });
  assert.ok(play);
  assert.equal(play.storeProductId, "fixture_play_monthly");
  assert.equal(productIdentifier(play), "fixture_play_monthly:monthly");
  const apple = findBinding(map, { appId: "fixture-ios", productId: "fixture-rc-ios", store: "APP_STORE" });
  assert.ok(apple);
  assert.equal(productIdentifier(apple), "fixture.ios.monthly");
  assert.equal(findBinding(map, { appId: "fixture-play", productId: "fixture_play_monthly", store: "PLAY_STORE" }), undefined);
});

test("map validation rejects unsupported stores, duplicate rows, placeholders and foreign projects", () => {
  const base = (fixture as { [key: string]: unknown });
  assert.throws(() => parsePremiumMap({ ...base, fixture: false, projectId: "proj8ae78267", bindings: [
    { platform: "ios", store: "PLAY_STORE", appId: "app7b06e9a4c1", rcProductId: "prod8d07384c8c", storeProductId: "com.lkurczab.patternly.premium.monthly", basePlanId: null },
  ] }), /premium_map_binding_invalid/u);
  assert.throws(() => parsePremiumMap({ ...base, fixture: false, projectId: "proj8ae78267", bindings: [
    { platform: "ios", store: "APP_STORE", appId: "app7b06e9a4c1", rcProductId: "prod8d07384c8c", storeProductId: "com.lkurczab.patternly.premium.monthly", basePlanId: null },
    { platform: "ios", store: "APP_STORE", appId: "app7b06e9a4c1", rcProductId: "prod8d07384c8c", storeProductId: "com.lkurczab.patternly.premium.monthly", basePlanId: null },
  ] }), /premium_map_binding_invalid|premium_map_duplicate_platform/u);
  assert.throws(() => parsePremiumMap({ ...base, fixture: false, projectId: "projforeign", bindings: [
    { platform: "ios", store: "APP_STORE", appId: "app7b06e9a4c1", rcProductId: "prod8d07384c8c", storeProductId: "com.lkurczab.patternly.premium.monthly", basePlanId: null },
  ] }), /premium_map_project_invalid/u);
  assert.throws(() => parsePremiumMap({ ...base, fixture: false, projectId: "proj8ae78267", bindings: [
    { platform: "ios", store: "APP_STORE", appId: "your-app-id", rcProductId: "prod8d07384c8c", storeProductId: "com.lkurczab.patternly.premium.monthly", basePlanId: null },
  ] }), /premium_map_binding_invalid/u);
});
