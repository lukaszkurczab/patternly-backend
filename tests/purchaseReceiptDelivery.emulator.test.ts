import { transactionKey } from "../src/modules/billing/purchaseCorrelation.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { PurchaseReceiptEmailRejectedError } from "../src/infrastructure/email/smtpPrivacyEmailSender.js";
import { revenueCatEventSchema } from "../src/modules/billing/revenuecatWebhook.js";
import { FirestoreRevenueCatWebhookStore, type PurchaseReceiptDelivery } from "../src/modules/billing/revenuecatWebhookStore.js";
import { clearFirestore, createEmulatorContext, type EmulatorContext } from "./support.js";

// Contexts share the default Admin SDK client; close each app, terminate that client once in after().
const context = createEmulatorContext();
const userId = "00000000-0000-4000-8000-000000000070";
const baseTime = Date.now() - 2000;
const payload = { event: revenueCatEventSchema.parse({ id: "receipt-fault", type: "INITIAL_PURCHASE", app_user_id: userId, original_app_user_id: userId, store: "APP_STORE", event_timestamp_ms: baseTime + 1000, expiration_at_ms: 60000, purchased_at_ms: baseTime + 1000, transaction_id: "receipt-fault-tx", app_id: "app-1", entitlement_ids: ["premium"], product_id: "monthly", environment: "SANDBOX" }) };
const args = [payload.event, "app-1", "SANDBOX", "premium", "monthly"] as const;
const userRef = () => context.db.collection("users").doc(userId);
const receiptRef = async () => (await userRef().collection("purchaseReceipts").get()).docs[0]!.ref;
const webhook = (ctx: EmulatorContext) => ctx.app.inject({ method: "POST", url: "/v1/webhooks/revenuecat", headers: { authorization: "Bearer test-revenuecat-secret" }, payload });
async function seed() {
  await userRef().set({ contactEmail: "receipt@example.com", contactEmailVerified: true });
  await userRef().collection("purchaseConfirmations").doc("confirmation").set({ productIdentifier: "monthly", storefrontPrice: "29.99 PLN", locale: "pl", termsVersion: "v1", immediateStartRequested: true });
  await userRef().collection("purchaseAttempts").doc("confirmation").set({ ownerAccountId: userId, confirmationId: "confirmation", projectId: "projtest", appId: "app-1", environment: "SANDBOX", productIdentifier: "monthly", acceptedAt: Timestamp.fromMillis(baseTime), initiatedAt: Timestamp.fromMillis(baseTime), startExpiresAt: Timestamp.fromMillis(baseTime + 900000), resolveBy: Timestamp.fromMillis(baseTime + 30 * 86400000), outcome: "initiated", boundTransactionKey: null, candidateTransactionKey: transactionKey({ projectId: "projtest", appId: "app-1", environment: "SANDBOX", productId: "monthly" }, "receipt-fault-tx") });
}
test.beforeEach(async () => { await clearFirestore(); await seed(); });
test.after(async () => { await clearFirestore(); await context.close(); });

for (const fault of ["before_sent_commit", "after_sent_commit", "sent_and_unknown_commit"] as const) {
  test(`accepted SMTP, ${fault}: webhook retries never send again`, async () => {
    let sends = 0;
    let sentPayload: PurchaseReceiptDelivery | undefined;
    const ctx = createEmulatorContext({ purchaseReceiptEmailSender: { send: async (input) => {
      sends++; sentPayload = input;
      const attempt = await (await receiptRef()).collection("deliveryAttempts").doc(input.deliveryClaimId).get();
      assert.equal(attempt.get("status"), "pending");
      assert.deepEqual(attempt.get("payload"), input); // Actual committed Firestore read before effect.
    } } });
    try {
      const store = ctx.stores.revenueCatWebhook;
      const mark = store.markReceiptDelivery.bind(store);
      store.markReceiptDelivery = async (...parameters) => {
        if (parameters[3] === "sent") {
          if (fault === "after_sent_commit") await mark(...parameters);
          throw new Error("injected_finalization_response_loss");
        }
        if (fault === "sent_and_unknown_commit") throw new Error("injected_unknown_write_failure");
        return mark(...parameters);
      };
      const result = await webhook(ctx);
      assert.equal(result.statusCode, 503);
      assert.equal(result.json().error.code, "purchase_receipt_reconciliation_required");
      assert.equal(sends, 1);
      assert.ok(sentPayload);
      const ref = await receiptRef();
      const status = fault === "after_sent_commit" ? "sent" : fault === "sent_and_unknown_commit" ? "sending" : "unknown";
      assert.equal((await ref.get()).get("deliveryStatus"), status);
      const attemptRef = ref.collection("deliveryAttempts").doc(sentPayload.deliveryClaimId);
      assert.equal((await attemptRef.get()).get("status"), status === "sending" ? "pending" : status);
      assert.deepEqual((await attemptRef.get()).get("payload"), sentPayload);
      assert.equal((await webhook(ctx)).statusCode, status === "sent" ? 200 : 503);
      if (status === "sending") {
        // The failed unknown write did NOT persist an unknown marker.
        assert.equal((await attemptRef.get()).get("status"), "pending");
        await ref.update({ deliveryLeaseUntil: Timestamp.fromMillis(0) });
        assert.equal((await webhook(ctx)).json().error.code, "purchase_receipt_reconciliation_required");
        assert.equal((await attemptRef.get()).get("status"), "unknown");
      }
      assert.equal((await ref.collection("deliveryAttempts").get()).size, 1);
      assert.equal(sends, 1);
    } finally { await ctx.app.close(); }
  });
}

test("confirmed refusal retries with a new durable attempt and preserves the rejected attempt", async () => {
  let sends = 0;
  const ctx = createEmulatorContext({ purchaseReceiptEmailSender: { send: async () => { if (++sends === 1) throw new PurchaseReceiptEmailRejectedError(); } } });
  try {
    assert.equal((await webhook(ctx)).json().error.code, "purchase_receipt_delivery_failed");
    assert.equal((await webhook(ctx)).statusCode, 200);
    assert.equal((await webhook(ctx)).statusCode, 200);
    assert.equal(sends, 2);
    const attempts = await (await receiptRef()).collection("deliveryAttempts").get();
    assert.deepEqual(attempts.docs.map(doc => doc.get("status")).sort(), ["failed", "sent"]);
    assert.notEqual(attempts.docs[0]!.get("payload.deliveryClaimId"), attempts.docs[1]!.get("payload.deliveryClaimId"));
  } finally { await ctx.app.close(); }
});

test("an ambiguous sender error, including a string resembling refusal, requires reconciliation", async () => {
  let sends = 0;
  const ctx = createEmulatorContext({ purchaseReceiptEmailSender: { send: async () => { sends++; throw new Error("purchase_receipt_email_rejected"); } } });
  try {
    assert.equal((await webhook(ctx)).statusCode, 503);
    assert.equal((await (await receiptRef()).get()).get("deliveryStatus"), "unknown");
    assert.equal((await webhook(ctx)).json().error.code, "purchase_receipt_reconciliation_required");
    assert.equal(sends, 1);
  } finally { await ctx.app.close(); }
});

test("missing sender is a definite no-effect failure and remains retryable", async () => {
  const ctx = createEmulatorContext({ purchaseReceiptEmailSender: null });
  try {
    assert.equal((await webhook(ctx)).json().error.code, "purchase_receipt_delivery_unavailable");
    assert.equal((await (await receiptRef()).get()).get("deliveryStatus"), "failed");
    assert.equal((await webhook(context)).statusCode, 200);
  } finally { await ctx.app.close(); }
});

test("expired claim cannot finalize or be reclaimed; reconciliation preserves the payload and identity", async () => {
  const store = new FirestoreRevenueCatWebhookStore(context.db, "projtest");
  const first = (await store.process(...args)).receipt!;
  const ref = await receiptRef();
  await ref.update({ deliveryLeaseUntil: Timestamp.fromMillis(0) });
  assert.equal(await store.markReceiptDelivery(userId, first.receiptId, first.deliveryClaimId, "sent"), false);
  const duplicates = await Promise.all(Array.from({ length: 5 }, () => store.process(...args)));
  for (const duplicate of duplicates) { assert.equal(duplicate.receipt, undefined); assert.equal(duplicate.receiptDeliveryState, "unknown"); }
  assert.equal((await ref.get()).get("deliveryClaimId"), first.deliveryClaimId);
  assert.equal((await ref.get()).get("deliveryStatus"), "unknown");
  const attempts = await ref.collection("deliveryAttempts").get();
  assert.equal(attempts.size, 1);
  assert.equal(attempts.docs[0]!.get("status"), "unknown");
  assert.deepEqual(attempts.docs[0]!.get("payload"), first);
});

test("stale finalization returns explicit failure from the production webhook", async () => {
  const ctx = createEmulatorContext({ purchaseReceiptEmailSender: { send: async () => {
    await (await receiptRef()).update({ deliveryLeaseUntil: Timestamp.fromMillis(0) });
  } } });
  try {
    assert.equal((await webhook(ctx)).json().error.code, "purchase_receipt_reconciliation_required");
    assert.equal((await webhook(ctx)).statusCode, 503);
    assert.equal((await (await receiptRef()).get()).get("deliveryStatus"), "unknown");
  } finally { await ctx.app.close(); }
});

test("concurrent webhook requests run only one sender while the durable claim is pending", async () => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let sends = 0;
  const ctx = createEmulatorContext({ purchaseReceiptEmailSender: { send: async () => { sends++; started(); await held; } } });
  try {
    const first = webhook(ctx);
    await ready;
    const duplicates = await Promise.all(Array.from({ length: 5 }, () => webhook(ctx)));
    for (const duplicate of duplicates) { assert.equal(duplicate.statusCode, 503); assert.equal(duplicate.json().error.code, "purchase_receipt_delivery_pending"); }
    release();
    assert.equal((await first).statusCode, 200);
    assert.equal((await webhook(ctx)).statusCode, 200);
    assert.equal(sends, 1);
  } finally { release(); await ctx.app.close(); }
});

test("lost response after initial commit sends nothing and retry reconciles the committed attempt", async () => {
  let sends = 0;
  const ctx = createEmulatorContext({ purchaseReceiptEmailSender: { send: async () => { sends++; } } });
  try {
    const store = ctx.stores.revenueCatWebhook;
    const process = store.process.bind(store);
    store.process = async (...parameters) => { await process(...parameters); throw new Error("injected_initial_commit_response_loss"); };
    assert.equal((await webhook(ctx)).statusCode, 500);
    store.process = process;
    const ref = await receiptRef();
    assert.equal((await ref.get()).get("deliveryStatus"), "sending");
    assert.equal((await webhook(ctx)).statusCode, 503);
    await ref.update({ deliveryLeaseUntil: Timestamp.fromMillis(0) });
    assert.equal((await webhook(ctx)).json().error.code, "purchase_receipt_reconciliation_required");
    assert.equal(sends, 0);
  } finally { await ctx.app.close(); }
});

test("initial store failure before commit cannot invoke the sender", async () => {
  let sends = 0;
  const ctx = createEmulatorContext({ purchaseReceiptEmailSender: { send: async () => { sends++; } } });
  try {
    ctx.stores.revenueCatWebhook.process = async () => { throw new Error("injected_precommit_failure"); };
    assert.equal((await webhook(ctx)).statusCode, 500);
    assert.equal((await userRef().collection("purchaseReceipts").get()).size, 0);
    assert.equal(sends, 0);
  } finally { await ctx.app.close(); }
});

test("concurrent initial and refused-attempt claims each grant exactly one sender identity", async () => {
  const store = new FirestoreRevenueCatWebhookStore(context.db, "projtest");
  const initial = await Promise.all(Array.from({ length: 5 }, () => store.process(...args)));
  const first = initial.flatMap(result => result.receipt ? [result.receipt] : []);
  assert.equal(first.length, 1);
  assert.equal(await store.markReceiptDelivery(userId, first[0]!.receiptId, first[0]!.deliveryClaimId, "failed"), true);
  const retries = await Promise.all(Array.from({ length: 5 }, () => store.process(...args)));
  const next = retries.flatMap(result => result.receipt ? [result.receipt] : []);
  assert.equal(next.length, 1);
  assert.notEqual(next[0]!.deliveryClaimId, first[0]!.deliveryClaimId);
  assert.equal(await store.markReceiptDelivery(userId, first[0]!.receiptId, first[0]!.deliveryClaimId, "sent"), false);
  assert.equal(await store.markReceiptDelivery(userId, next[0]!.receiptId, next[0]!.deliveryClaimId, "sent"), true);
  assert.equal((await (await receiptRef()).collection("deliveryAttempts").get()).size, 2);
});
