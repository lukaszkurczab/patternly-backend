import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { revenueCatEventSchema } from "../src/modules/billing/revenuecatWebhook.js";
import { FirestoreRevenueCatWebhookStore } from "../src/modules/billing/revenuecatWebhookStore.js";
import { clearFirestore, createEmulatorContext, firestore } from "./support.js";

const userId = "revenuecat-user";
const context = createEmulatorContext();
test.beforeEach(async () => { await clearFirestore(); });
test.after(async () => { await clearFirestore(); await context.close(); });
const event = (id: string, type: string, timestamp: number, overrides: Record<string, unknown> = {}) => revenueCatEventSchema.parse({
  id, type, app_user_id: userId, event_timestamp_ms: timestamp, expiration_at_ms: timestamp + 60_000,
  purchased_at_ms: timestamp, transaction_id: `tx-${id}`, app_id: "app-1", entitlement_ids: ["premium"], product_id: "monthly", environment: "SANDBOX", ...overrides,
});

async function seedPurchasableUser(id = userId, purchasedAt = 1_000): Promise<void> {
  const db = firestore();
  const confirmationId = `confirmation-${id}`;
  await db.collection("users").doc(id).set({ createdAt: Timestamp.now(), contactEmail: `${id}@example.com`, contactEmailVerified: true });
  await db.collection("users").doc(id).collection("purchaseConfirmations").doc(confirmationId).set({ confirmationId, productIdentifier: "monthly", storefrontPrice: "29,99 zł", locale: "pl", termsVersion: "2026-09-01" });
  await db.collection("users").doc(id).collection("purchaseAttempts").doc("active").set({ confirmationId, productIdentifier: "monthly", expiresAt: Timestamp.fromMillis(purchasedAt + 15 * 60_000), consumedAt: null });
}

test("RevenueCat store is idempotent and monotonic across lifecycle events", async () => {
  {
    const db = firestore();
    await seedPurchasableUser();
    const store = new FirestoreRevenueCatWebhookStore(db);
    const first = await store.process(event("purchase", "INITIAL_PURCHASE", 1_000), "app-1", "SANDBOX", "premium", "monthly");
    assert.equal(first.outcome, "processed"); assert.equal(first.duplicate, false); assert.equal(first.receipt?.transactionId, "tx-purchase");
    assert.deepEqual(await store.process(event("purchase", "INITIAL_PURCHASE", 1_000), "app-1", "SANDBOX", "premium", "monthly"), { outcome: "processed", duplicate: true });
    assert.equal(await store.markReceiptDelivery(userId, first.receipt!.receiptId, first.receipt!.deliveryClaimId, "failed"), true);
    const retried = (await store.process(event("purchase", "INITIAL_PURCHASE", 1_000), "app-1", "SANDBOX", "premium", "monthly")).receipt;
    assert.equal(retried?.receiptId, first.receipt!.receiptId);
    assert.notEqual(retried?.deliveryClaimId, first.receipt!.deliveryClaimId);
    assert.equal(await store.markReceiptDelivery(userId, first.receipt!.receiptId, first.receipt!.deliveryClaimId, "sent"), false);
    assert.equal(await store.markReceiptDelivery(userId, first.receipt!.receiptId, retried!.deliveryClaimId, "sent"), true);
    assert.deepEqual(await store.process(event("purchase", "INITIAL_PURCHASE", 1_000), "app-1", "SANDBOX", "premium", "monthly"), { outcome: "processed", duplicate: true });
    await store.process(event("expiration", "EXPIRATION", 3_000), "app-1", "SANDBOX", "premium", "monthly");
    assert.deepEqual(await store.process(event("old-renewal", "RENEWAL", 2_000), "app-1", "SANDBOX", "premium", "monthly"), { outcome: "ignored", duplicate: false });
    const projection = (await db.collection("users").doc(userId).collection("entitlements").doc("premium").get()).data();
    assert.equal(projection?.status, "expired");
    assert.equal(projection?.eventId, "expiration");
    assert.equal((await db.collection("revenueCatEvents").get()).size, 3);
  }
});

test("a trusted paid purchase grants Premium even when durable-receipt evidence is unavailable", async () => {
  const db = firestore();
  await db.collection("users").doc(userId).set({ createdAt: Timestamp.now() });
  const store = new FirestoreRevenueCatWebhookStore(db);
  const result = await store.process(event("paid-without-attempt", "INITIAL_PURCHASE", 4_000), "app-1", "SANDBOX", "premium", "monthly");
  assert.deepEqual(result, { outcome: "processed", duplicate: false });
  assert.equal((await db.collection("users").doc(userId).collection("entitlements").doc("premium").get()).get("status"), "active");
});

test("RevenueCat endpoint authenticates and materializes the Premium projection", async () => {
  {
    await seedPurchasableUser(userId, Date.now());
    const payload = { event: event("endpoint-purchase", "INITIAL_PURCHASE", Date.now()) };
    assert.equal((await context.app.inject({ method: "POST", url: "/v1/webhooks/revenuecat", payload })).statusCode, 401);
    const accepted = await context.app.inject({ method: "POST", url: "/v1/webhooks/revenuecat", headers: { authorization: "Bearer test-revenuecat-secret" }, payload });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().outcome, "processed");
    assert.equal((await firestore().collection("users").doc(userId).collection("entitlements").doc("premium").get()).data()?.status, "active");
  }
});

test("RevenueCat transfer atomically moves an active projection and replays safely", async () => {
  const db = firestore(); const targetId = "revenuecat-target";
  await seedPurchasableUser(); await db.collection("users").doc(targetId).set({ createdAt: Timestamp.now() });
  const store = new FirestoreRevenueCatWebhookStore(db);
  await store.process(event("before-transfer", "INITIAL_PURCHASE", 1_000), "app-1", "SANDBOX", "premium", "monthly");
  const transfer = revenueCatEventSchema.parse({ id: "transfer", type: "TRANSFER", event_timestamp_ms: 2_000, app_id: "app-1", environment: "SANDBOX", transferred_from: [userId, "historical-alias"], transferred_to: [targetId] });
  assert.deepEqual(await store.process(transfer, "app-1", "SANDBOX", "premium", "monthly"), { outcome: "processed", duplicate: false });
  assert.deepEqual(await store.process(transfer, "app-1", "SANDBOX", "premium", "monthly"), { outcome: "processed", duplicate: true });
  assert.equal((await db.collection("users").doc(userId).collection("entitlements").doc("premium").get()).data()?.status, "revoked");
  assert.equal((await db.collection("users").doc(targetId).collection("entitlements").doc("premium").get()).data()?.status, "active");
});

test("RevenueCat transfer cannot overwrite an event with the same timestamp and later id", async () => {
  const db = firestore(); const targetId = "revenuecat-target";
  await seedPurchasableUser(); await db.collection("users").doc(targetId).set({ createdAt: Timestamp.now() });
  const store = new FirestoreRevenueCatWebhookStore(db);
  await store.process(event("source", "INITIAL_PURCHASE", 1_000), "app-1", "SANDBOX", "premium", "monthly");
  await store.process(event("zz-expiration", "EXPIRATION", 2_000, { app_user_id: targetId }), "app-1", "SANDBOX", "premium", "monthly");
  const transfer = revenueCatEventSchema.parse({ id: "aa-transfer", type: "TRANSFER", event_timestamp_ms: 2_000, app_id: "app-1", environment: "SANDBOX", transferred_from: [userId], transferred_to: [targetId] });
  assert.equal((await store.process(transfer, "app-1", "SANDBOX", "premium", "monthly")).outcome, "ignored");
  assert.equal((await db.collection("users").doc(targetId).collection("entitlements").doc("premium").get()).data()?.status, "expired");
});
