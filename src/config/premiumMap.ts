export type RevenueCatEnvironment = "SANDBOX" | "PRODUCTION";

export type StoreBinding = Readonly<
  | {
    platform: "ios";
    store: "APP_STORE";
    appId: string;
    rcProductId: string;
    storeProductId: string;
    basePlanId: null;
  }
  | {
    platform: "android";
    store: "PLAY_STORE";
    appId: string;
    rcProductId: string;
    storeProductId: string;
    basePlanId: string;
  }
>;

export type PremiumMap = Readonly<{
  version: string;
  projectId: string;
  entitlementId: "premium";
  environment: RevenueCatEnvironment;
  bindings: readonly StoreBinding[];
  fixture: boolean;
}>;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const placeholderPattern = /(?:placeholder|example|your[-_ ]?(?:id|key)|changeme|test[-_ ]?only)/iu;
const fixtureIdentifierPattern = /(?:^|[-_.])(?:fixture|test)(?:[-_.]|$)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value) && !placeholderPattern.test(value);
}

export function parsePremiumMap(value: unknown, options: { allowTestFixtures?: boolean } = {}): PremiumMap {
  if (!isRecord(value) || typeof value.version !== "string" || value.version.trim() === ""
    || !validId(value.projectId) || value.entitlementId !== "premium"
    || (value.environment !== "SANDBOX" && value.environment !== "PRODUCTION")
    || !Array.isArray(value.bindings) || value.bindings.length < 1 || value.bindings.length > 2) {
    throw new Error("premium_map_invalid");
  }
  const fixture = value.fixture === true;
  if (value.fixture !== undefined && typeof value.fixture !== "boolean") throw new Error("premium_map_invalid");
  if (fixture && !options.allowTestFixtures) throw new Error("premium_map_fixture_forbidden");
  const seenPlatforms = new Set<string>();
  const seenIds = new Set<string>();
  const bindings = value.bindings.map((raw): StoreBinding => {
    if (!isRecord(raw) || !validId(raw.appId) || !validId(raw.rcProductId) || !validId(raw.storeProductId)) {
      throw new Error("premium_map_binding_invalid");
    }
    if (raw.platform === "ios" && raw.store === "APP_STORE" && raw.basePlanId === null) {
      // Apple binding has a fixed application and monthly product contract.
      if (!fixture && (raw.appId !== "app7b06e9a4c1" || raw.rcProductId !== "prod8d07384c8c"
        || raw.storeProductId !== "com.lkurczab.patternly.premium.monthly")) throw new Error("premium_map_binding_invalid");
      return Object.freeze({ platform: "ios", store: "APP_STORE", appId: raw.appId, rcProductId: raw.rcProductId, storeProductId: raw.storeProductId, basePlanId: null });
    }
    if (raw.platform === "android" && raw.store === "PLAY_STORE" && validId(raw.basePlanId)) {
      return Object.freeze({ platform: "android", store: "PLAY_STORE", appId: raw.appId, rcProductId: raw.rcProductId, storeProductId: raw.storeProductId, basePlanId: raw.basePlanId });
    }
    throw new Error("premium_map_binding_invalid");
  });
  for (const binding of bindings) {
    if (seenPlatforms.has(binding.platform)) throw new Error("premium_map_duplicate_platform");
    seenPlatforms.add(binding.platform);
    for (const id of [binding.appId, binding.rcProductId, binding.storeProductId]) {
      if (seenIds.has(id)) throw new Error("premium_map_duplicate_identifier");
      seenIds.add(id);
    }
  }
  if (fixture) {
    if (value.projectId !== "fixture-project" || value.environment !== "SANDBOX" || bindings.length !== 2
      || !bindings.some((binding) => binding.platform === "ios" && binding.appId === "fixture-ios" && binding.rcProductId === "fixture-rc-ios" && binding.storeProductId === "fixture.ios.monthly")
      || !bindings.some((binding) => binding.platform === "android" && binding.appId === "fixture-play" && binding.rcProductId === "fixture-rc-play" && binding.storeProductId === "fixture_play_monthly" && binding.basePlanId === "monthly")) {
      throw new Error("premium_map_fixture_invalid");
    }
  } else if (value.projectId !== "proj8ae78267") {
    throw new Error("premium_map_project_invalid");
  } else if (bindings.some((binding) => [binding.appId, binding.rcProductId, binding.storeProductId, binding.basePlanId ?? ""].some((id) => fixtureIdentifierPattern.test(id)))) {
    throw new Error("premium_map_fixture_forbidden");
  }
  return Object.freeze({ version: value.version, projectId: value.projectId, entitlementId: "premium", environment: value.environment, bindings: Object.freeze(bindings), fixture });
}

export function productIdentifier(binding: StoreBinding): string {
  return binding.platform === "android" ? `${binding.storeProductId}:${binding.basePlanId}` : binding.storeProductId;
}

export function findBinding(map: PremiumMap, scope: { appId: unknown; productId: unknown; store: unknown }): StoreBinding | undefined {
  return map.bindings.find((binding) => binding.appId === scope.appId && binding.rcProductId === scope.productId && binding.store === scope.store);
}

export function defaultPremiumMap(projectId: string | undefined, environment: RevenueCatEnvironment | undefined): PremiumMap | null {
  if (projectId !== "proj8ae78267" || !environment) return null;
  return parsePremiumMap({
    version: "premium-map-v1",
    projectId,
    entitlementId: "premium",
    environment,
    bindings: [{ platform: "ios", store: "APP_STORE", appId: "app7b06e9a4c1", rcProductId: "prod8d07384c8c", storeProductId: "com.lkurczab.patternly.premium.monthly", basePlanId: null }],
  });
}
