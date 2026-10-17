import assert from "node:assert/strict";
import test from "node:test";
import { buildApplication } from "../src/api/app.js";
import type { RevenueCatEntitlementResult } from "../src/infrastructure/revenuecat/client.js";
import { smokeEnvironment, smokeEndpoints, localAppCheckVerifier } from "../scripts/localSmoke.js";
import { premiumSnapshotScope } from "./fixtures/premiumSnapshot.js";

const keys = { appCheckToken: "a".repeat(64), storageKey: "b".repeat(64), hmacKey: "c".repeat(64), recoveryOperationKey: "d".repeat(64) };
const environment = smokeEnvironment({ FIREBASE_PROJECT_ID: smokeEndpoints.project, FIREBASE_AUTH_EMULATOR_HOST: smokeEndpoints.auth, FIRESTORE_EMULATOR_HOST: smokeEndpoints.firestore }, keys);
const accountId = "00000000-0000-4000-8000-000000000001";
const attemptId = "00000000-0000-4000-8000-000000000002";
const confirmation = { confirmationId: attemptId, termsVersion: "v1", productIdentifier: "fixture_play_monthly:monthly", store: "PLAY_STORE", storefrontPrice: "29.99 PLN", locale: "pl", immediateStartRequested: true };
const headers = { authorization: "Bearer fixture-token", "x-firebase-appcheck": keys.appCheckToken };

for (const condition of ["active", "grace", "hold", "paused", "unavailable", "network", "identity_conflict", "expired", "refunded"] as const) {
  test(`both confirmation and claim require a fresh all-store read: ${condition}`, async () => {
    let records = 0, claims = 0, conflicts = 0, reads = 0;
    const snapshot: RevenueCatEntitlementResult = {
      ...premiumSnapshotScope, entitlement: "premium", productId: "com.lkurczab.patternly.premium.monthly",
      state: condition === "paused" ? "hold" : ["network", "identity_conflict"].includes(condition) ? "unavailable" : condition as RevenueCatEntitlementResult["state"],
      reason: condition === "identity_conflict" ? "identity_conflict" : condition === "paused" ? "paused" : null,
      providerExpiresAt: null, providerGraceExpiresAt: null, providerObservedAt: new Date().toISOString(),
    };
    const app = buildApplication({
      environment, firestore: null,
      stores: {
        users: {
          resolveExistingUser: async () => ({ userId: accountId, authorizationGeneration: 1 }),
          recordPurchaseConfirmation: async (_id: string, _generation: number, input: unknown) => { records++; assert.deepEqual(input, confirmation); return { confirmationId: attemptId }; },
        },
        purchases: {
          status: async () => { if (reads === 0) throw new Error("purchase_attempt_not_found"); return { initiatedAt: null }; },
          command: async () => { claims++; return { transactionKey: null, dispatchAllowed: true }; },
        },
        revenueCatWebhook: { identityAvailable: async () => conflicts === 0, markIdentityConflict: async () => { conflicts++; } },
      } as never,
      verifier: { verify: async () => ({ provider: "firebase", subject: "fixture-subject", emailVerified: true, authTime: Math.floor(Date.now() / 1000) }) },
      appCheckVerifier: localAppCheckVerifier(keys.appCheckToken),
      revenueCatEntitlementReader: { read: async () => { reads++; if (condition === "network") throw new Error("fixture failure"); return snapshot; } },
    });
    try {
      const record = await app.inject({ method: "POST", url: "/v1/purchase-confirmations", headers, payload: confirmation });
      const claim = await app.inject({ method: "POST", url: `/v1/purchase-attempts/${attemptId}`, headers, payload: { action: "claim" } });
      const allowed = condition === "expired" || condition === "refunded";
      assert.equal(records, allowed ? 1 : 0); assert.equal(claims, allowed ? 1 : 0);
      assert.equal(record.statusCode, allowed ? 201 : ["network", "unavailable"].includes(condition) ? 503 : 409);
      assert.equal(claim.statusCode, allowed ? 200 : ["network", "unavailable"].includes(condition) ? 503 : 409);
      assert.equal(reads, condition === "identity_conflict" ? 1 : 2);
      assert.equal(conflicts, condition === "identity_conflict" ? 1 : 0);
    } finally { await app.close(); }
  });
}
