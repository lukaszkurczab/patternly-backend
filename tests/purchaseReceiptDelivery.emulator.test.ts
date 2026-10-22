import { transactionKey } from "../src/modules/billing/purchaseCorrelation.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { PurchaseReceiptEmailRejectedError } from "../src/infrastructure/email/smtpPrivacyEmailSender.js";
import { revenueCatEventSchema } from "../src/modules/billing/revenuecatWebhook.js";
import { FirestoreRevenueCatWebhookStore, type PurchaseReceiptDelivery } from "../src/modules/billing/revenuecatWebhookStore.js";
import { clearFirestore, createEmulatorContext, type EmulatorContext } from "./support.js";
import { premiumSnapshotScope } from "./fixtures/premiumSnapshot.js";
import { buildApplication } from "../src/api/app.js";
import { testEnvironment } from "./support.js";
import { randomUUID } from "node:crypto";

// Contexts share the default Admin SDK client; close each app, terminate that client once in after().
const testReader = { read: async () => ({ ...premiumSnapshotScope, projectId: "projtest", mapVersion: "test-map-v1", entitlement: "premium", productId: "monthly", state: "expired" as const, providerExpiresAt: new Date(Date.now() - 1000).toISOString(), providerGraceExpiresAt: null, providerObservedAt: new Date().toISOString() }) };
const createTestContext = (options: Parameters<typeof createEmulatorContext>[0] = {}) => createEmulatorContext({ ...options, revenueCatEntitlementReader: testReader });
const context = createTestContext();
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
    const ctx = createTestContext({ purchaseReceiptEmailSender: { send: async (input) => {
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
  const ctx = createTestContext({ purchaseReceiptEmailSender: { send: async () => { if (++sends === 1) throw new PurchaseReceiptEmailRejectedError(); } } });
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
  const ctx = createTestContext({ purchaseReceiptEmailSender: { send: async () => { sends++; throw new Error("purchase_receipt_email_rejected"); } } });
  try {
    assert.equal((await webhook(ctx)).statusCode, 503);
    assert.equal((await (await receiptRef()).get()).get("deliveryStatus"), "unknown");
    assert.equal((await webhook(ctx)).json().error.code, "purchase_receipt_reconciliation_required");
    assert.equal(sends, 1);
  } finally { await ctx.app.close(); }
});

test("missing sender is a definite no-effect failure and remains retryable", async () => {
  const ctx = createTestContext({ purchaseReceiptEmailSender: null });
  try {
    assert.equal((await webhook(ctx)).json().error.code, "purchase_receipt_delivery_unavailable");
    assert.equal((await (await receiptRef()).get()).get("deliveryStatus"), "failed");
    assert.equal((await webhook(context)).statusCode, 200);
  } finally { await ctx.app.close(); }
});

test("expired claim cannot finalize or be reclaimed; reconciliation preserves the payload and identity", async () => {
  const store = new FirestoreRevenueCatWebhookStore(context.db, "projtest", testReader);
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
  const ctx = createTestContext({ purchaseReceiptEmailSender: { send: async () => {
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
  const ctx = createTestContext({ purchaseReceiptEmailSender: { send: async () => { sends++; started(); await held; } } });
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
  const ctx = createTestContext({ purchaseReceiptEmailSender: { send: async () => { sends++; } } });
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
  const ctx = createTestContext({ purchaseReceiptEmailSender: { send: async () => { sends++; } } });
  try {
    ctx.stores.revenueCatWebhook.process = async () => { throw new Error("injected_precommit_failure"); };
    assert.equal((await webhook(ctx)).statusCode, 500);
    assert.equal((await userRef().collection("purchaseReceipts").get()).size, 0);
    assert.equal(sends, 0);
  } finally { await ctx.app.close(); }
});

test("concurrent initial and refused-attempt claims each grant exactly one sender identity", async () => {
  const store = new FirestoreRevenueCatWebhookStore(context.db, "projtest", testReader);
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

async function reconciliationFixture(state: "unknown" | "sending" | "sent" = "unknown") {
  const map = { version: "receipt-map-v1", projectId: "projtest", entitlementId: "premium" as const, environment: "SANDBOX" as const, fixture: true,
    bindings: [{ platform: "ios" as const, store: "APP_STORE" as const, appId: "app-1", rcProductId: "monthly", storeProductId: "monthly", basePlanId: null }] };
  // The pre-existing M10 seed is legacy Apple; this case exercises the current explicit map.
  await userRef().collection("purchaseAttempts").doc("confirmation").update({ generation: 1, store: "APP_STORE", rcProductId: "monthly", storeProductId: "monthly", basePlanId: null, mapVersion: map.version });
  const store = new FirestoreRevenueCatWebhookStore(context.db, map, testReader);
  const delivery = (await store.process(...args)).receipt!;
  assert.ok(delivery);
  if (state !== "sending") assert.equal(await store.markReceiptDelivery(userId, delivery.receiptId, delivery.deliveryClaimId, state), true);
  const ref = await receiptRef(), attempt = ref.collection("deliveryAttempts").doc(delivery.deliveryClaimId);
  const key = transactionKey({ projectId: "projtest", appId: "app-1", environment: "SANDBOX", productId: "monthly" }, delivery.transactionId);
  const references = [userRef(), context.db.collection("revenueCatTransactions").doc(key), ref, attempt, userRef().collection("purchaseConfirmations").doc(delivery.confirmationId)];
  const snapshot = async () => JSON.stringify((await context.db.getAll(...references)).map(doc => [doc.ref.path, doc.data()]));
  const app = buildApplication({ environment: { ...testEnvironment, premiumMap: map }, firestore: null, verifier: null, appCheckVerifier: null,
    stores: { ...context.stores, revenueCatWebhook: store },
    operatorTokenVerifier: { verifyAndAuthorize: async (token, action) => {
      assert.equal(token, "controlled-operator-token"); assert.equal(action, "purchase_receipts:reconcile");
      return { actorPseudonym: "controlled-receipt-operator", role: "receipt_operator", action };
    } }, purchaseReceiptEmailSender: { send: async () => { throw new Error("Reconciliation must never invoke SMTP."); } } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address(); assert.ok(address && typeof address !== "string");
  const body = { operationId: randomUUID(), receiptId: delivery.receiptId, deliveryClaimId: delivery.deliveryClaimId, expectedAuthorizationGeneration: 1,
    scope: { firebaseProjectId: testEnvironment.firebaseProjectId!, databaseId: context.db.databaseId, revenueCatProjectId: map.projectId, appId: "app-1", environment: "SANDBOX", store: "APP_STORE", rcProductId: "monthly", productIdentifier: "monthly", basePlanId: null, mapVersion: map.version },
    attestation: { kind: "operator_attested_smtp_acceptance", deliveryClaimId: delivery.deliveryClaimId, exactAttemptVerified: true, smtpAcceptedAt: new Date().toISOString(), providerAccountReference: "controlled-provider-account", providerEventReference: "controlled-exact-attempt", evidenceReference: "private-case:receipt-acceptance", evidenceSha256: "a".repeat(64) } };
  const request = async (input: unknown = body) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/operator/purchase-cases/${key}/receipt-reconciliation`, { method: "POST", headers: { authorization: "Bearer controlled-operator-token", "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000) });
    return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() as { kind?: string; snapshotFingerprint?: string; error?: { code: string } } };
  };
  return { app, store, delivery, ref, attempt, body, snapshot, request, references };
}

test("real HTTP receipt reconciliation previews without writes and applies attested acceptance once", async () => {
  const fixture = await reconciliationFixture();
  try {
    await userRef().update({ contactEmail: "changed-contact@example.test", contactEmailVerified: false });
    const before = await fixture.snapshot();
    const originalAttempt = (await fixture.attempt.get()).data()!;
    const preview = await fixture.request();
    assert.equal(preview.status, 200);
    assert.equal(preview.body.kind, "preview");
    assert.equal(preview.cache, "private, no-store");
    assert.equal(await fixture.snapshot(), before);
    assert.match(preview.body.snapshotFingerprint!, /^[a-f0-9]{64}$/u);
    const command = { ...fixture.body, mode: "apply", expectedSnapshotFingerprint: preview.body.snapshotFingerprint };
    const applied = await fixture.request(command);
    assert.equal(applied.status, 200); assert.equal(applied.body.kind, "reconciled");
    const after = await fixture.snapshot();
    const [receipt, attempt] = await context.db.getAll(fixture.ref, fixture.attempt);
    assert.equal(receipt!.get("deliveryStatus"), "sent"); assert.equal(attempt!.get("status"), "sent");
    assert.deepEqual(attempt!.get("payload"), fixture.delivery);
    assert.equal(attempt!.get("payload.recipient"), "receipt@example.com", "Reconciliation must not retarget the original mail to current contact.");
    assert.deepEqual(attempt!.get("createdAt"), originalAttempt.createdAt);
    assert.deepEqual(attempt!.get("completedAt"), originalAttempt.completedAt);
    assert.equal(receipt!.get("deliveredAt"), undefined, "Resolution time is not a historical mailbox delivery time.");
    assert.equal(attempt!.get("resolution.smtpAcceptedAt"), fixture.body.attestation.smtpAcceptedAt);
    assert.ok(attempt!.get("resolution.resolutionRecordedAt") instanceof Timestamp);
    assert.equal((await fixture.request(command)).body.kind, "replayed");
    assert.equal(await fixture.snapshot(), after, "Lost apply ACK replay performs no further write.");
    const changed = await fixture.request({ ...command, attestation: { ...command.attestation, evidenceSha256: "b".repeat(64) } });
    assert.equal(changed.status, 409); assert.equal(changed.body.error?.code, "receipt_reconciliation_operation_conflict");
    assert.equal(await fixture.snapshot(), after);
    assert.equal((await fixture.store.claimReceipt(userId, fixture.delivery.receiptId)).receipt, undefined);
    assert.equal((await fixture.ref.collection("deliveryAttempts").get()).size, 1);
  } finally { await fixture.app.close(); }
});

test("real HTTP receipt reconciliation accepts only expired valid sending and preserves original SMTP sent", async () => {
  const fixture = await reconciliationFixture("sending");
  try {
    for (const lease of [Timestamp.fromMillis(Date.now() + 60000), null, "expired"] as const) {
      await fixture.ref.update({ deliveryLeaseUntil: lease });
      const before = await fixture.snapshot();
      const denied = await fixture.request();
      assert.equal(denied.status, 409); assert.equal(denied.body.error?.code, "receipt_reconciliation_state_invalid");
      assert.equal(await fixture.snapshot(), before);
    }
    await fixture.ref.update({ deliveryLeaseUntil: Timestamp.fromMillis(0) });
    const preview = await fixture.request(); assert.equal(preview.body.kind, "preview");
    const command = { ...fixture.body, mode: "apply", expectedSnapshotFingerprint: preview.body.snapshotFingerprint };
    const results = await Promise.all([fixture.request(command), fixture.request(command)]);
    assert.deepEqual(results.map(result => result.body.kind).sort(), ["reconciled", "replayed"]);
    assert.equal((await fixture.attempt.get()).get("completedAt"), undefined);
    assert.equal((await fixture.ref.collection("deliveryAttempts").get()).size, 1);
  } finally { await fixture.app.close(); }
});

test("real HTTP receipt reconciliation leaves already sent SMTP records unchanged", async () => {
  const fixture = await reconciliationFixture("sent");
  try {
    const before = await fixture.snapshot();
    const result = await fixture.request();
    assert.equal(result.status, 200); assert.equal(result.body.kind, "already_sent");
    assert.equal(await fixture.snapshot(), before);
    assert.equal((await fixture.attempt.get()).get("resolution"), undefined);
  } finally { await fixture.app.close(); }
});

test("real HTTP receipt reconciliation refuses foreign scope and malformed or nonacceptance attestations without writes", async () => {
  const fixture = await reconciliationFixture();
  try {
    const before = await fixture.snapshot();
    for (const [field, value] of Object.entries(fixture.body.scope)) {
      const invalid = { ...fixture.body, scope: { ...fixture.body.scope, [field]: value === null ? "foreign" : `foreign-${value}` } };
      assert.ok([400, 409].includes((await fixture.request(invalid)).status), field);
      assert.equal(await fixture.snapshot(), before);
    }
    for (const invalid of [
      { ...fixture.body, actorPseudonym: "spoofed" },
      { ...fixture.body, mode: "apply" },
      { ...fixture.body, expectedAuthorizationGeneration: 2 },
      { ...fixture.body, deliveryClaimId: randomUUID() },
      { ...fixture.body, receiptId: "b".repeat(64) },
      ...[{ kind: "definitely_not_accepted" }, { exactAttemptVerified: false }, { deliveryClaimId: randomUUID() },
        { smtpAcceptedAt: "2099-01-01T00:00:00.000Z" }, { smtpAcceptedAt: "2000-01-01T00:00:00.000Z" }, { evidenceSha256: "invalid" }]
        .map(change => ({ ...fixture.body, attestation: { ...fixture.body.attestation, ...change } })),
    ]) {
      assert.ok([400, 409].includes((await fixture.request(invalid)).status));
      assert.equal(await fixture.snapshot(), before);
    }
  } finally { await fixture.app.close(); }
});

test("real HTTP receipt reconciliation fences every preview record and current generation without requiring original generation", async () => {
  const fixture = await reconciliationFixture();
  try {
    for (const [index, reference] of fixture.references.entries()) {
      const preview = await fixture.request(); assert.equal(preview.body.kind, "preview");
      await reference.update({ controlledCasChange: index });
      const before = await fixture.snapshot();
      const result = await fixture.request({ ...fixture.body, mode: "apply", expectedSnapshotFingerprint: preview.body.snapshotFingerprint });
      assert.equal(result.status, 409); assert.equal(result.body.error?.code, "receipt_reconciliation_snapshot_conflict");
      assert.equal(await fixture.snapshot(), before);
    }
    await userRef().update({ authorizationGeneration: 2 });
    const before = await fixture.snapshot();
    assert.equal((await fixture.request()).body.error?.code, "receipt_reconciliation_authority_conflict");
    assert.equal(await fixture.snapshot(), before);
    const currentAuthority = { ...fixture.body, expectedAuthorizationGeneration: 2 };
    const preview = await fixture.request(currentAuthority); assert.equal(preview.body.kind, "preview");
    assert.equal((await fixture.request({ ...currentAuthority, mode: "apply", expectedSnapshotFingerprint: preview.body.snapshotFingerprint })).body.kind, "reconciled");
    assert.equal((await userRef().collection("purchaseAttempts").doc("confirmation").get()).get("generation"), 1);
  } finally { await fixture.app.close(); }
});

test("real HTTP receipt reconciliation rejects missing, malformed, conflicted and deleted authority without writes", async () => {
  const fixture = await reconciliationFixture();
  try {
    const cases = [
      { ref: fixture.ref, patch: { deliveryStatus: null } }, { ref: fixture.ref, patch: { deliveryStatus: "failed" } },
      { ref: fixture.ref, patch: { deliveryStatus: "ready" } }, { ref: fixture.ref, patch: { deliveryClaimId: randomUUID() } },
      { ref: fixture.attempt, patch: { status: "pending" } }, { ref: fixture.attempt, patch: { payload: { ...fixture.delivery, recipient: "foreign@example.test" } } },
      { ref: userRef(), patch: { billingIdentityConflict: true } }, { ref: userRef(), patch: { authorizationState: "deleted" } },
      { ref: userRef(), patch: { authorizationGeneration: "1" } },
      { ref: fixture.references[1]!, patch: { identityConflict: true } }, { ref: fixture.references[1]!, patch: { appId: "foreign" } },
      { ref: fixture.references[1]!, patch: { boundConfirmationId: "" } }, { ref: fixture.references[1]!, patch: { boundConfirmationId: "foreign/child/path" } },
    ];
    for (const { ref, patch } of cases) {
      const original = (await ref.get()).data()!;
      await ref.update(patch);
      const before = await fixture.snapshot();
      assert.equal((await fixture.request()).status, 409);
      assert.equal(await fixture.snapshot(), before);
      await ref.set(original);
    }
    for (const reference of [fixture.attempt, fixture.references[4]!, userRef()]) {
      const original = (await reference.get()).data()!;
      await reference.delete();
      const before = await fixture.snapshot();
      assert.equal((await fixture.request()).status, 409);
      assert.equal(await fixture.snapshot(), before);
      await reference.set(original);
    }
  } finally { await fixture.app.close(); }
});
