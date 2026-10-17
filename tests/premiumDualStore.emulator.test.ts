import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { parsePremiumMap, productIdentifier, type StoreBinding } from "../src/config/premiumMap.js";
import { digest, FirestorePurchaseCorrelation, transactionKey } from "../src/modules/billing/purchaseCorrelation.js";
import { revenueCatEventSchema } from "../src/modules/billing/revenuecatWebhook.js";
import { FirestoreRevenueCatWebhookStore } from "../src/modules/billing/revenuecatWebhookStore.js";
import { clearFirestore, createEmulatorContext } from "./support.js";

const map = parsePremiumMap(JSON.parse(await readFile(new URL("./fixtures/premiumMap.fixture.json", import.meta.url), "utf8")) as unknown, { allowTestFixtures: true });
const context = createEmulatorContext();
const db = context.db;
const userRef = (id: string) => db.collection("users").doc(id);
const now = Date.now() - 2_000;
const readerFor = (binding: StoreBinding) => ({
  read: async () => ({
    entitlement: "premium", productId: "com.lkurczab.patternly.premium.monthly", state: "active" as const,
    providerExpiresAt: new Date(now + 3_600_000).toISOString(), providerGraceExpiresAt: null,
    providerObservedAt: new Date(now).toISOString(), projectId: map.projectId, mapVersion: map.version,
    environment: map.environment, reason: null,
    sources: [binding].map(sourceBinding => ({ ...sourceBinding, state: "active" as const, reason: null, managementURL: null,
      providerExpiresAt: new Date(now + 3_600_000).toISOString(), providerGraceExpiresAt: null })),
  }),
});

test.beforeEach(async () => clearFirestore());
test.after(async () => { await clearFirestore(); await context.close(); });

test("same transaction ID stays store-qualified; Apple receipt namespace stays stable and Play receipt is namespaced", async () => {
  const webhook = new FirestoreRevenueCatWebhookStore(db, map);
  const results: Array<{ owner: string; transactionKey: string; receiptId: string }> = [];
  for (const binding of map.bindings) {
    const owner = randomUUID(), confirmationId = randomUUID();
    const storeProduct = productIdentifier(binding);
    const correlation = new FirestorePurchaseCorrelation(db, map, () => now);
    await userRef(owner).set({ authorizationGeneration: 1, acceptedTermsVersion: "terms-v1", contactEmail: `${owner}@example.test`, contactEmailVerified: true, createdAt: Timestamp.fromMillis(now) });
    await correlation.record(owner, 1, { confirmationId, termsVersion: "terms-v1", productIdentifier: storeProduct, storefrontPrice: "29.99", locale: "en", store: binding.store });
    await correlation.command(owner, 1, confirmationId, "claim");
    await correlation.command(owner, 1, confirmationId, "candidate", "same-provider-transaction");
    const event = revenueCatEventSchema.parse({
      id: randomUUID(), type: "INITIAL_PURCHASE", app_user_id: owner, original_app_user_id: owner,
      app_id: binding.appId, store: binding.store, product_id: storeProduct, entitlement_ids: ["premium"],
      transaction_id: "same-provider-transaction", purchased_at_ms: now + 1_000, expiration_at_ms: now + 3_600_000,
      event_timestamp_ms: now + 2_000, environment: "SANDBOX",
    });
    const processed = await webhook.process(event, binding.appId, "SANDBOX", "premium", binding.rcProductId, readerFor(binding));
    assert.equal(processed.refreshPending, false);
    const key = transactionKey({ projectId: map.projectId, appId: binding.appId, environment: map.environment, store: binding.store, productId: binding.rcProductId }, "same-provider-transaction");
    const fact = await db.collection("revenueCatTransactions").doc(key).get();
    assert.equal(fact.get("boundConfirmationId"), confirmationId);
    assert.equal(fact.get("store"), binding.store);
    const receiptId = String(fact.get("receiptId"));
    assert.equal(receiptId, binding.store === "APP_STORE" ? digest("same-provider-transaction") : `play-${key}`);
    results.push({ owner, transactionKey: key, receiptId });
  }
  assert.notEqual(results[0]!.transactionKey, results[1]!.transactionKey);
  assert.notEqual(results[0]!.receiptId, results[1]!.receiptId);
});

test("a trusted duplicate retries an unfinished reader refresh", async () => {
  const owner = randomUUID(), binding = map.bindings[0]!, webhook = new FirestoreRevenueCatWebhookStore(db, map);
  await userRef(owner).set({ authorizationGeneration: 1, acceptedTermsVersion: "terms-v1" });
  const event = revenueCatEventSchema.parse({ id: randomUUID(), type: "CANCELLATION", app_user_id: owner, original_app_user_id: owner,
    app_id: binding.appId, store: binding.store, product_id: productIdentifier(binding), entitlement_ids: ["premium"],
    transaction_id: "cancelled-transaction", event_timestamp_ms: now + 1_000, expiration_at_ms: now + 3_600_000, environment: "SANDBOX" });
  let attempts = 0;
  const failingReader = { read: async () => { attempts += 1; throw new Error("reader unavailable"); } };
  const first = await webhook.process(event, binding.appId, "SANDBOX", "premium", binding.rcProductId, failingReader);
  assert.equal(first.refreshPending, true);
  const entitlementRef = userRef(owner).collection("entitlements").doc("premium");
  const pendingFence = Number((await entitlementRef.get()).get("refreshFence"));
  const succeedingReader = readerFor(binding);
  const second = await webhook.process(event, binding.appId, "SANDBOX", "premium", binding.rcProductId, succeedingReader);
  assert.equal(second.duplicate, true);
  assert.equal(second.refreshPending, false);
  assert.equal(attempts, 1);
  const final = await entitlementRef.get();
  assert.equal(final.get("refreshPending"), false);
  assert.equal(final.get("refreshedFence"), pendingFence + 1);
  assert.equal(final.get("readerSnapshot.state"), "active");
});

test("per-account refresh fence rejects a late older reader result", async () => {
  const owner = randomUUID(), binding = map.bindings[0]!, webhook = new FirestoreRevenueCatWebhookStore(db, map);
  await userRef(owner).set({ authorizationGeneration: 1, acceptedTermsVersion: "terms-v1" });
  const event = revenueCatEventSchema.parse({ id: randomUUID(), type: "BILLING_ISSUE", app_user_id: owner, original_app_user_id: owner,
    app_id: binding.appId, store: binding.store, product_id: productIdentifier(binding), entitlement_ids: ["premium"], transaction_id: "tx-fence",
    event_timestamp_ms: now + 1_000, expiration_at_ms: now + 3_600_000, environment: "SANDBOX" });
  let startOld!: () => void, finishOld!: () => void;
  const oldStarted = new Promise<void>(resolve => { startOld = resolve; });
  const oldResult = new Promise<void>(resolve => { finishOld = resolve; });
  const slowReader = { read: async () => { startOld(); await oldResult; return { ...(await readerFor(binding).read()), state: "hold" as const }; } };
  const firstPending = webhook.process(event, binding.appId, "SANDBOX", "premium", binding.rcProductId, slowReader);
  await oldStarted;
  const second = await webhook.process(event, binding.appId, "SANDBOX", "premium", binding.rcProductId, readerFor(binding));
  assert.equal(second.refreshPending, false);
  finishOld();
  const first = await firstPending;
  assert.equal(first.refreshPending, true);
  const final = await userRef(owner).collection("entitlements").doc("premium").get();
  assert.equal(final.get("readerSnapshot.state"), "active");
  assert.equal(final.get("refreshFence"), 2);
  assert.equal(final.get("refreshedFence"), 2);
});

test("unknown app/product webhook scopes are ignored and do not set identity conflict", async () => {
  const owner = randomUUID(), webhook = new FirestoreRevenueCatWebhookStore(db, map);
  await userRef(owner).set({ authorizationGeneration: 1 });
  const binding = map.bindings[1]!;
  const event = revenueCatEventSchema.parse({ id: randomUUID(), type: "INITIAL_PURCHASE", app_user_id: owner, original_app_user_id: owner,
    app_id: "unknown-app", store: binding.store, product_id: productIdentifier(binding), entitlement_ids: ["premium"], transaction_id: "tx",
    purchased_at_ms: now, event_timestamp_ms: now, environment: "SANDBOX" });
  const result = await webhook.process(event, binding.appId, "SANDBOX", "premium", binding.rcProductId, readerFor(binding));
  assert.equal(result.outcome, "ignored");
  assert.equal((await userRef(owner).get()).get("billingIdentityConflict"), undefined);
  assert.equal((await db.collection("revenueCatTransactions").get()).size, 0);
});

test("account plus logical Premium lock prevents a second store attempt", async () => {
  const owner = randomUUID(), correlation = new FirestorePurchaseCorrelation(db, map, () => now);
  await userRef(owner).set({ authorizationGeneration: 1, acceptedTermsVersion: "terms-v1" });
  const apple = map.bindings.find(row => row.store === "APP_STORE")!, play = map.bindings.find(row => row.store === "PLAY_STORE")!;
  await correlation.record(owner, 1, { confirmationId: randomUUID(), termsVersion: "terms-v1", productIdentifier: productIdentifier(apple), storefrontPrice: "29.99", locale: "en", store: apple.store });
  await assert.rejects(correlation.record(owner, 1, { confirmationId: randomUUID(), termsVersion: "terms-v1", productIdentifier: productIdentifier(play), storefrontPrice: "29.99", locale: "en", store: play.store }), /purchase_attempt_active/);
  await assert.rejects(correlation.record(owner, 1, { confirmationId: randomUUID(), termsVersion: "terms-v1", productIdentifier: productIdentifier(play), storefrontPrice: "29.99", locale: "en", store: "APP_STORE" }), /purchase_product_invalid/);
});

test("Play event before exact candidate binds once, and invalid product/store combinations do not bind", async () => {
  const binding = map.bindings.find(row => row.store === "PLAY_STORE")!, owner = randomUUID(), confirmationId = randomUUID();
  const correlation = new FirestorePurchaseCorrelation(db, map, () => now), webhook = new FirestoreRevenueCatWebhookStore(db, map);
  await userRef(owner).set({ authorizationGeneration: 1, acceptedTermsVersion: "terms-v1", contactEmail: `${owner}@example.test`, contactEmailVerified: true });
  await correlation.record(owner, 1, { confirmationId, termsVersion: "terms-v1", productIdentifier: productIdentifier(binding), storefrontPrice: "29.99", locale: "en", store: binding.store });
  await correlation.command(owner, 1, confirmationId, "claim");
  const event = revenueCatEventSchema.parse({ id: randomUUID(), type: "INITIAL_PURCHASE", app_user_id: owner, original_app_user_id: owner,
    app_id: binding.appId, store: binding.store, product_id: productIdentifier(binding), entitlement_ids: ["premium"], transaction_id: "play-tx",
    purchased_at_ms: now + 1_000, event_timestamp_ms: now + 2_000, expiration_at_ms: now + 3_600_000, environment: "SANDBOX" });
  await webhook.process(event, binding.appId, "SANDBOX", "premium", binding.rcProductId, readerFor(binding));
  const key = transactionKey({ projectId: map.projectId, appId: binding.appId, environment: map.environment, store: binding.store }, "play-tx");
  assert.equal((await userRef(owner).collection("purchaseReceipts").get()).size, 0);
  await correlation.command(owner, 1, confirmationId, "candidate", "play-tx");
  const fact = await db.collection("revenueCatTransactions").doc(key).get();
  assert.equal(fact.get("boundConfirmationId"), confirmationId);
  assert.equal(fact.get("receiptId"), `play-${key}`);
  const invalid = revenueCatEventSchema.parse({ ...event, id: randomUUID(), store: "APP_STORE" });
  assert.equal((await webhook.process(invalid, binding.appId, "SANDBOX", "premium", binding.rcProductId, readerFor(binding))).outcome, "ignored");
});

test("event ID fingerprint includes entitlement scope; TRANSFER requires a configured app and environment", async () => {
  const owner = randomUUID(), binding = map.bindings[0]!, webhook = new FirestoreRevenueCatWebhookStore(db, map);
  await userRef(owner).set({ authorizationGeneration: 1 });
  const event = revenueCatEventSchema.parse({ id: randomUUID(), type: "CANCELLATION", app_user_id: owner, original_app_user_id: owner,
    app_id: binding.appId, store: binding.store, product_id: productIdentifier(binding), entitlement_ids: ["premium"], transaction_id: "scope-tx",
    event_timestamp_ms: now + 1_000, expiration_at_ms: now + 3_600_000, environment: "SANDBOX" });
  await webhook.process(event, binding.appId, "SANDBOX", "premium", binding.rcProductId, readerFor(binding));
  await assert.rejects(webhook.process({ ...event, entitlement_ids: ["other"] }, binding.appId, "SANDBOX", "premium", binding.rcProductId, readerFor(binding)), /revenuecat_event_conflict/);
  const other = randomUUID();
  await userRef(other).set({ authorizationGeneration: 1 });
  const transfer = revenueCatEventSchema.parse({ id: randomUUID(), type: "TRANSFER", app_id: binding.appId, environment: "SANDBOX", event_timestamp_ms: now + 2_000, transferred_from: [owner], transferred_to: [other] });
  await webhook.process(transfer, binding.appId, "SANDBOX", "premium", binding.rcProductId);
  assert.equal((await userRef(owner).get()).get("billingIdentityConflict"), true);
  assert.equal((await userRef(other).get()).get("billingIdentityConflict"), true);
  const unknownTransfer = revenueCatEventSchema.parse({ ...transfer, id: randomUUID(), app_id: "unknown-app" });
  assert.equal((await webhook.process(unknownTransfer, binding.appId, "SANDBOX", "premium", binding.rcProductId)).outcome, "ignored");
});

test("bound receipt claim rejects an owner or transaction-scope mismatch", async () => {
  const owner = randomUUID(), binding = map.bindings[0]!, key = transactionKey({ projectId: map.projectId, appId: binding.appId, environment: map.environment, store: binding.store }, "receipt-tx");
  await userRef(owner).set({ authorizationGeneration: 1, contactEmail: "owner@example.test", contactEmailVerified: true });
  const receiptId = digest("receipt-tx"), webhook = new FirestoreRevenueCatWebhookStore(db, map);
  await db.collection("revenueCatTransactions").doc(key).set({ ownerAccountId: owner, boundConfirmationId: randomUUID(), receiptId, transactionKey: key, transactionId: "receipt-tx", store: binding.store, projectId: map.projectId, appId: binding.appId, environment: map.environment, productIdentifier: productIdentifier(binding) });
  await userRef(owner).collection("purchaseReceipts").doc(receiptId).set({ userId: owner, receiptId, transactionKey: "wrong-key", confirmationId: "wrong-confirmation", transactionId: "receipt-tx", store: binding.store, productIdentifier: productIdentifier(binding), deliveryStatus: "ready", recipient: "owner@example.test" });
  assert.deepEqual(await webhook.claimBoundReceipt(owner, key), { receiptDeliveryState: "unknown" });
  const conflictedFact = await db.collection("revenueCatTransactions").doc(key).get();
  assert.equal(conflictedFact.get("status"), "reconciliation_required");
  assert.equal(conflictedFact.get("resolutionReason"), "receipt_scope_conflict");
  assert.equal(conflictedFact.get("receiptScopeConflict"), true);
  assert.equal((await userRef(owner).collection("purchaseReceipts").doc(receiptId).get()).get("deliveryStatus"), "ready");
  assert.equal((await userRef(owner).collection("purchaseReceipts").doc(receiptId).collection("deliveryAttempts").get()).size, 0);
});
