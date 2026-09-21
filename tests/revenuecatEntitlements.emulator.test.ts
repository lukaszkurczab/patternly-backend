import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import type { RevenueCatEntitlementReader } from "../src/infrastructure/revenuecat/client.js";
import { TEST_APP_CHECK_TOKEN, clearFirestore, createEmulatorContext, createVerifiedAuthUser, registerAuthUser } from "./support.js";

const confirmed = {
  entitlement: "premium",
  productId: "monthly",
  state: "grace" as const,
  providerExpiresAt: "2026-09-20T00:00:00.000Z",
  providerGraceExpiresAt: "2026-09-23T00:00:00.000Z",
  providerObservedAt: "2026-09-21T12:00:00.000Z",
};
let fail = false;
let state: Awaited<ReturnType<RevenueCatEntitlementReader["read"]>> = confirmed;
const reads: string[] = [];
const context = createEmulatorContext({ revenueCatEntitlementReader: { read: async (userId) => {
  reads.push(userId);
  if (fail) throw new Error("provider_timeout");
  return state;
} } });
after(async () => context.close());
beforeEach(async () => { await clearFirestore(); fail = false; state = confirmed; reads.length = 0; });

test("entitlement refresh requires App Check and returns only a fresh provider result for the bound account", async () => {
  const auth = await createVerifiedAuthUser();
  const registered = await registerAuthUser(context, auth);
  const url = "/v1/entitlements";
  const noAttestation = await context.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${registered.idToken}` } });
  assert.equal(noAttestation.statusCode, 401);
  assert.deepEqual(reads, []);
  const response = await context.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${registered.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().entitlements.length, 1);
  assert.deepEqual(response.json().entitlements[0], { accountId: registered.userId, ...confirmed, source: "revenuecat" });
  assert.ok(Number.isFinite(Date.parse(response.json().serverObservedAt)));
  assert.deepEqual(reads, [registered.userId]);
});

test("provider failure and ambiguous state return explicit 503 without exposing a stored webhook projection", async () => {
  const auth = await createVerifiedAuthUser();
  const registered = await registerAuthUser(context, auth);
  const headers = { authorization: `Bearer ${registered.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  fail = true;
  const failed = await context.app.inject({ method: "GET", url: "/v1/entitlements", headers });
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(failed.json(), { error: { code: "revenuecat_read_unavailable" } });
  state = { ...confirmed, state: "unavailable" };
  fail = false;
  const ambiguous = await context.app.inject({ method: "GET", url: "/v1/entitlements", headers });
  assert.equal(ambiguous.statusCode, 503);
  assert.deepEqual(ambiguous.json(), failed.json());
});

test("provider-confirmed billing hold remains an explicit negative result", async () => {
  const auth = await createVerifiedAuthUser();
  const registered = await registerAuthUser(context, auth);
  state = { ...confirmed, state: "hold", providerGraceExpiresAt: null };
  const response = await context.app.inject({ method: "GET", url: "/v1/entitlements", headers: { authorization: `Bearer ${registered.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().entitlements[0], { accountId: registered.userId, ...state, source: "revenuecat" });
});

test("missing provider composition fails closed with 503", async () => {
  const auth = await createVerifiedAuthUser();
  const registered = await registerAuthUser(context, auth);
  const missing = createEmulatorContext();
  try {
    const response = await missing.app.inject({ method: "GET", url: "/v1/entitlements", headers: { authorization: `Bearer ${registered.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: { code: "revenuecat_read_unavailable" } });
  } finally {
    await missing.close();
  }
});
