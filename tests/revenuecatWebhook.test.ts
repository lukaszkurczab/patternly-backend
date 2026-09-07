import assert from "node:assert/strict";
import test from "node:test";
import { revenueCatEventSchema, reduceRevenueCatEvent, verifyRevenueCatAuthorization } from "../src/modules/billing/revenuecatWebhook.js";

const event = (type: string, overrides: Record<string, unknown> = {}) => revenueCatEventSchema.parse({
  id: `event-${type}`, type, app_user_id: "user-1", event_timestamp_ms: 1_000,
  expiration_at_ms: 2_000, app_id: "app-1", entitlement_ids: ["premium"],
  product_id: "monthly", environment: "PRODUCTION", ...overrides,
});

test("RevenueCat authorization is exact and rejects missing or different-length values", () => {
  assert.equal(verifyRevenueCatAuthorization("Bearer secret", "Bearer secret"), true);
  assert.equal(verifyRevenueCatAuthorization("Bearer secret-x", "Bearer secret"), false);
  assert.equal(verifyRevenueCatAuthorization(undefined, "Bearer secret"), false);
  assert.equal(verifyRevenueCatAuthorization("Bearer secret", undefined), false);
});

test("RevenueCat lifecycle grants, preserves and removes access at the correct events", () => {
  assert.deepEqual(reduceRevenueCatEvent(event("INITIAL_PURCHASE"), 10_000), { status: "active", expiresAtMs: 2_000, eventTimestampMs: 1_000, eventId: "event-INITIAL_PURCHASE" });
  assert.deepEqual(reduceRevenueCatEvent(event("CANCELLATION"), 10_000), { status: "active", expiresAtMs: 2_000, willRenew: false, eventTimestampMs: 1_000, eventId: "event-CANCELLATION" });
  assert.equal(reduceRevenueCatEvent(event("BILLING_ISSUE"), 10_000), null);
  assert.equal(reduceRevenueCatEvent(event("PRODUCT_CHANGE"), 10_000), null);
  assert.equal(reduceRevenueCatEvent(event("EXPIRATION"), 10_000)?.status, "expired");
  assert.equal(reduceRevenueCatEvent(event("EXPIRATION"), 10_000)?.willRenew, false);
  assert.equal(reduceRevenueCatEvent(event("EXPIRATION", { expiration_reason: "CUSTOMER_SUPPORT" }), 10_000)?.status, "refunded");
  assert.deepEqual(reduceRevenueCatEvent(event("CANCELLATION", { cancel_reason: "CUSTOMER_SUPPORT" }), 10_000), { status: "active", expiresAtMs: 2_000, willRenew: false, eventTimestampMs: 1_000, eventId: "event-CANCELLATION" });
  assert.equal(reduceRevenueCatEvent(event("REFUND_REVERSED"), 10_000)?.status, "active");
});

test("RevenueCat parser rejects incomplete payloads and reducer rejects future timestamps", () => {
  assert.equal(revenueCatEventSchema.safeParse({}).success, false);
  assert.throws(() => reduceRevenueCatEvent(event("RENEWAL", { event_timestamp_ms: 1_000_000 }), 0, 10), /event_timestamp_future/u);
});
