import assert from "node:assert/strict";
import test from "node:test";
import {
  isSandboxPromotionalAccessAllowed,
  parseSandboxPromotionalAccessPolicy,
  REVENUECAT_OFFICIAL_API_BASE_URL,
  SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID,
  SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID,
  SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID,
} from "../src/config/sandboxPromotionalAccess.js";

const policy = parseSandboxPromotionalAccessPolicy(JSON.stringify({
  firebaseProjectId: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID,
  revenueCatProjectId: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID,
  revenueCatAppId: SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID,
  customerId: "backend-account-uuid",
  expiresAt: "2026-10-18T12:00:00Z",
}))!;

const runtime = {
  firebaseProjectId: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID,
  revenueCatProjectId: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID,
  revenueCatAppId: SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID,
  revenueCatEnvironment: "SANDBOX" as const,
  revenueCatApiBaseUrl: REVENUECAT_OFFICIAL_API_BASE_URL,
  accountId: "backend-account-uuid",
  nowMs: Date.parse("2026-10-17T12:00:00Z"),
};

test("sandbox promotional policy is absent when unset and normalizes a valid finite ISO cutoff", () => {
  assert.equal(parseSandboxPromotionalAccessPolicy(undefined), null);
  assert.throws(() => parseSandboxPromotionalAccessPolicy(""), { message: "invalid_sandbox_promotional_access_config" });
  assert.equal(policy.expiresAt, "2026-10-18T12:00:00.000Z");
  assert.equal(isSandboxPromotionalAccessAllowed(policy, runtime), true);
});

test("sandbox promotional policy parser rejects malformed, production, wrong-project and invalid-date policies", () => {
  for (const input of [
    "{",
    JSON.stringify({ firebaseProjectId: "patternly-app", revenueCatProjectId: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID, customerId: "account", expiresAt: "2026-10-18T12:00:00Z" }),
    JSON.stringify({ firebaseProjectId: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID, revenueCatProjectId: "proj-production", customerId: "account", expiresAt: "2026-10-18T12:00:00Z" }),
    JSON.stringify({ firebaseProjectId: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID, revenueCatProjectId: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID, revenueCatAppId: "app-wrong", customerId: "account", expiresAt: "2026-10-18T12:00:00Z" }),
    JSON.stringify({ firebaseProjectId: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID, revenueCatProjectId: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID, revenueCatAppId: SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID, customerId: "account", expiresAt: "2026-10-18T12:00:00Z", ignored: true }),
    JSON.stringify({ firebaseProjectId: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID, revenueCatProjectId: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID, customerId: "account", expiresAt: "never" }),
    JSON.stringify({ firebaseProjectId: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID, revenueCatProjectId: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID, customerId: "account", expiresAt: "2026-02-30T12:00:00Z" }),
  ]) assert.throws(() => parseSandboxPromotionalAccessPolicy(input), { message: "invalid_sandbox_promotional_access_config" });
});

test("sandbox promotional access fails closed for identity, project, environment, endpoint or cutoff mismatch", () => {
  for (const override of [
    { accountId: "firebase-uid" },
    { firebaseProjectId: "patternly-app" },
    { revenueCatProjectId: "proj-production" },
    { revenueCatAppId: "app-wrong" },
    { revenueCatEnvironment: "PRODUCTION" as const },
    { revenueCatApiBaseUrl: "https://attacker.example" },
    { revenueCatApiBaseUrl: "https://api.revenuecat.com/v2" },
    { nowMs: Date.parse(policy.expiresAt) },
  ]) assert.equal(isSandboxPromotionalAccessAllowed(policy, { ...runtime, ...override }), false);
  assert.equal(isSandboxPromotionalAccessAllowed(null, runtime), false);
});
