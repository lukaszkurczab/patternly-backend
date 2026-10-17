import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { FirestorePurchaseCorrelation, transactionKey, digest, PURCHASE_WINDOW_MS, RESOLUTION_WINDOW_MS } from "../src/modules/billing/purchaseCorrelation.js";
import { revenueCatEventSchema } from "../src/modules/billing/revenuecatWebhook.js";
import { RetentionPurgeService } from "../src/modules/retention-purge/service.js";
import { clearFirestore, createEmulatorContext, createVerifiedAuthUser, registerAuthUser, TEST_APP_CHECK_TOKEN } from "./support.js";
import { premiumSnapshotScope } from "./fixtures/premiumSnapshot.js";

// The provider reader is authoritative. Start expired so confirmation tests can
// exercise the purchase path, then pass this same reader through webhook refresh.
const reader = { read: async () => ({ ...premiumSnapshotScope, entitlement: "premium", productId: "monthly", state: "expired" as const, providerExpiresAt: new Date(Date.now() - 600000).toISOString(), providerGraceExpiresAt: null, providerObservedAt: new Date().toISOString() }) };
const context = createEmulatorContext({ revenueCatEntitlementReader: reader });
const db = context.db, scope = { projectId: "projtest", appId: "app-1", environment: "SANDBOX" as const, productId: "monthly" };
let now = Date.now();
const correlation = () => new FirestorePurchaseCorrelation(db, scope, () => now);
const store = context.stores.revenueCatWebhook;
test.beforeEach(async () => { await clearFirestore(); now = Date.now() - 2000; });
test.after(async () => { await clearFirestore(); await context.close(); });
const event = (owner: string, txId: string, purchasedAt = now + 1000, overrides: Record<string, unknown> = {}) => revenueCatEventSchema.parse({ id: randomUUID(), type: "INITIAL_PURCHASE", app_user_id: owner, original_app_user_id: owner, store: "APP_STORE", event_timestamp_ms: Date.now(), expiration_at_ms: Date.now() + 600000, purchased_at_ms: purchasedAt, transaction_id: txId, app_id: scope.appId, entitlement_ids: ["premium"], product_id: "monthly", environment: "SANDBOX", ...overrides });
const processEvent = (e: ReturnType<typeof event>) => store.process(e, scope.appId, scope.environment, "premium", scope.productId, reader);
const userRef = (id: string) => db.collection("users").doc(id);
async function seed(owner = randomUUID()) {
  await userRef(owner).set({ contactEmail: "owner@example.com", contactEmailVerified: true, acceptedTermsVersion: "v1", createdAt: Timestamp.fromMillis(now) });
  const confirmation = { confirmationId: randomUUID(), termsVersion: "v1", productIdentifier: "monthly", storefrontPrice: "29.99 PLN", locale: "pl" as const };
  await correlation().record(owner, 1, confirmation);
  await correlation().command(owner, 1, confirmation.confirmationId, "claim");
  return { owner, confirmation, id: confirmation.confirmationId };
}
for (const order of ["candidate_first", "webhook_first", "parallel"] as const) {
  test(`exact binding ${order}: one receipt across event IDs, concurrent resolves, lost ACK retry`, async () => {
    const { owner, id } = await seed(), e = event(owner, "T");
    const candidate = () => correlation().command(owner, 1, id, "candidate", "T");
    if (order === "candidate_first") { await candidate(); assert.equal((await userRef(owner).collection("purchaseReceipts").get()).size, 0); await processEvent(e); }
    else if (order === "webhook_first") { await processEvent(e); assert.equal((await userRef(owner).collection("purchaseReceipts").get()).size, 0); await candidate(); }
    else await Promise.all([candidate(), processEvent(e)]);
    await Promise.all([candidate(), processEvent(e), processEvent({ ...e, id: randomUUID() })]);
    assert.equal((await userRef(owner).collection("purchaseReceipts").get()).size, 1);
    const fact = await db.collection("revenueCatTransactions").doc(transactionKey(scope, "T")).get();
    assert.equal(fact.get("boundConfirmationId"), id);
    assert.equal((await correlation().status(owner, 1, id)).outcome, "bound");
    assert.equal((await userRef(owner).collection("purchaseReceipts").doc(digest("T")).collection("deliveryAttempts").get()).size, 1);
  });
}
test("confirmation and claim retries preserve history and never reauthorize SDK; mismatch conflicts", async () => {
  const { owner, id, confirmation } = await seed();
  const confirmationRef = userRef(owner).collection("purchaseConfirmations").doc(id);
  const historical = (await confirmationRef.get()).data()!;
  delete historical.store;
  await confirmationRef.set(historical);
  await correlation().record(owner, 1, confirmation);
  await assert.rejects(correlation().record(owner, 1, { ...confirmation, storefrontPrice: "1 PLN" }), /purchase_confirmation_conflict/);
  assert.equal((await correlation().command(owner, 1, id, "claim")).dispatchAllowed, false);
  now += PURCHASE_WINDOW_MS;
  await assert.rejects(correlation().record(owner, 1, { ...confirmation, confirmationId: randomUUID() }), /purchase_attempt_active/);
  assert.equal((await correlation().status(owner, 1, id)).outcome, "reconciliation_required");
  await userRef(owner).update({ authorizationGeneration: 2 });
  await assert.rejects(correlation().command(owner, 1, id, "pending"), /authorization_generation_conflict/);
  await correlation().command(owner, 2, id, "candidate", "T");
  assert.equal((await userRef(owner).collection("purchaseAttempts").doc(id).get()).get("generation"), 1);
});
for (const offset of [-1, PURCHASE_WINDOW_MS, PURCHASE_WINDOW_MS + 3600000]) {
  test(`purchased_at outside exact window (${offset}): durable case without receipt`, async () => {
    const { owner, id } = await seed();
    await correlation().command(owner, 1, id, "candidate", "T");
    await processEvent(event(owner, "T", now + offset));
    const cases = await correlation().cases(owner, 1);
    assert.equal(cases.items[0]?.resolutionReason, "outside_confirmation_window");
    assert.equal((await userRef(owner).collection("purchaseReceipts").get()).size, 0);
  });
}
test("late delivery uses purchased_at; pending approval >15min stays unresolved; expired claim denied", async () => {
  const { owner, id } = await seed();
  await correlation().command(owner, 1, id, "candidate", "T");
  await processEvent(event(owner, "T", now + 1000, { event_timestamp_ms: Date.now() - 1000 }));
  assert.equal((await correlation().status(owner, 1, id)).outcome, "bound");
  const other = await seed();
  now += PURCHASE_WINDOW_MS;
  await correlation().command(other.owner, 1, other.id, "pending");
  await processEvent(event(other.owner, "late", now + 1));
  assert.equal((await correlation().cases(other.owner, 1)).items[0]?.resolutionReason, "missing_exact_binding");
  const thirdOwner = randomUUID(); await userRef(thirdOwner).set({ acceptedTermsVersion: "v1" });
  const thirdId = randomUUID(); await correlation().record(thirdOwner, 1, { confirmationId: thirdId, termsVersion: "v1", productIdentifier: "monthly", storefrontPrice: "29", locale: "en" });
  now += PURCHASE_WINDOW_MS;
  await assert.rejects(correlation().command(thirdOwner, 1, thirdId, "claim"), /purchase_attempt_expired/);
});
test("wrong namespace/product/store rejects; wrong owner, alias and TRANSFER never transfer consent/projection", async () => {
  const a = await seed(), b = await seed();
  for (const invalid of [{ app_id: "wrong" }, { product_id: "wrong" }, { environment: "PRODUCTION" }, { store: "PLAY_STORE" }]) {
    assert.equal((await processEvent(event(a.owner, randomUUID(), now + 1000, invalid))).outcome, "ignored");
  }
  assert.equal((await db.collection("revenueCatTransactions").get()).size, 0);
  await correlation().command(a.owner, 1, a.id, "candidate", "T");
  const paid = event(a.owner, "T"); await processEvent(paid);
  await processEvent(event(b.owner, "T"));
  assert.equal((await userRef(b.owner).collection("purchaseReceipts").get()).size, 0);
  assert.equal(await store.identityAvailable(a.owner), false); assert.equal(await store.identityAvailable(b.owner), false);
  const fresh = await seed();
  await processEvent(event(fresh.owner, "alias", now + 1000, { original_app_user_id: "$RCAnonymousID:old", aliases: [fresh.owner] }));
  assert.equal(await store.identityAvailable(fresh.owner), false);
  const target = randomUUID(); await userRef(target).set({ createdAt: Timestamp.now() });
  const before = (await userRef(a.owner).collection("entitlements").doc("premium").get()).data();
  const transfer = event(a.owner, "ignored", now + 1000, { type: "TRANSFER", transferred_from: [a.owner], transferred_to: [target] });
  await processEvent(transfer); await processEvent(transfer);
  assert.deepEqual((await userRef(a.owner).collection("entitlements").doc("premium").get()).data(), before);
  assert.equal((await userRef(target).collection("entitlements").doc("premium").get()).exists, false);
  assert.equal(await store.identityAvailable(target), false);
});
test("candidate status and actual shared dispatcher run after ACKed webhook without another event", async () => {
  const auth = await createVerifiedAuthUser(), registered = await registerAuthUser(context, auth);
  await userRef(registered.userId).update({ acceptedTermsVersion: "v1" });
  const headers = { authorization: `Bearer ${registered.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const id = randomUUID();
  assert.equal((await context.app.inject({ method: "POST", url: "/v1/purchase-confirmations", headers, payload: { confirmationId: id, termsVersion: "v1", productIdentifier: "monthly", storefrontPrice: "29", locale: "pl", immediateStartRequested: true } })).statusCode, 201);
  const command = (payload: Record<string, unknown>) => context.app.inject({ method: "POST", url: `/v1/purchase-attempts/${id}`, headers, payload });
  assert.equal((await command({ action: "claim" })).json().attempt.dispatchAllowed, true);
  const e = event(registered.userId, "endpoint", Date.now());
  const before = context.purchaseReceipts.length;
  const hook = await context.app.inject({ method: "POST", url: "/v1/webhooks/revenuecat", headers: { authorization: "Bearer test-revenuecat-secret" }, payload: { event: e } });
  assert.equal(hook.statusCode, 200); assert.equal(context.purchaseReceipts.length, before);
  const candidate = await command({ action: "candidate", transactionId: "endpoint" });
  assert.equal(candidate.statusCode, 200); assert.equal(candidate.json().attempt.outcome, "bound");
  assert.equal(context.purchaseReceipts.length, before + 1);
  await command({ action: "candidate", transactionId: "endpoint" });
  assert.equal(context.purchaseReceipts.length, before + 1);
  const other = await seed();
  await processEvent(event(registered.userId, "alias", Date.now(), { original_app_user_id: other.owner }));
  assert.equal((await context.app.inject({ method: "GET", url: "/v1/entitlements", headers })).statusCode, 503);
  assert.equal((await context.app.inject({ method: "GET", url: "/v1/content/packages/track/node", headers })).statusCode, 503);
  assert.equal((await context.app.inject({ method: "GET", url: `/v1/purchase-attempts/${other.id}`, headers })).statusCode, 404);
});
test("missing transaction ID persists a visible case; out-of-order and inactive users never resurrect", async () => {
  const { owner } = await seed();
  await processEvent(event(owner, "T", now + 1000, { transaction_id: undefined }));
  assert.equal((await correlation().cases(owner, 1)).items[0]?.resolutionReason, "missing_transaction_id");
  await processEvent(event(owner, "renewal", now + 1000, { type: "EXPIRATION", event_timestamp_ms: Date.now() + 1000 }));
  await processEvent(event(owner, "old", now + 1000, { type: "RENEWAL", event_timestamp_ms: Date.now() - 1000 }));
  assert.equal((await userRef(owner).collection("entitlements").doc("premium").get()).get("status"), "expired");
  await userRef(owner).update({ authorizationState: "deleted" });
  assert.equal((await processEvent(event(owner, "deleted"))).outcome, "ignored");
  const absent = randomUUID(); await processEvent(event(absent, "absent")); assert.equal((await userRef(absent).get()).exists, false);
});
test("operator exact evidence bind/close is revision guarded; 30d expiry and 90d compaction never revive consent", async () => {
  const first = await seed();
  await processEvent(event(first.owner, "late", now + PURCHASE_WINDOW_MS + 1));
  const key = transactionKey(scope, "late"), item = (await correlation().cases(first.owner, 1)).items[0]!;
  const input = { operationId: randomUUID(), expectedRevision: item.revision, attemptId: first.id, action: "bind" as const, evidenceReference: "verified-original-operation/provider/T-late", evidence: { transactionId: "late", initiatedAt: new Date(now).toISOString(), source: "original_operation_provider_verified" as const }, releaseLock: false };
  assert.equal((await correlation().resolveCase(key, input, "operator-1")).status, "bound");
  assert.equal((await correlation().resolveCase(key, input, "operator-1")).status, "bound");
  await assert.rejects(correlation().resolveCase(key, { ...input, operationId: randomUUID() }, "operator-1"), /purchase_resolution_conflict/);
  const second = await seed(); await processEvent(event(second.owner, "unknown"));
  const secondKey = transactionKey(scope, "unknown");
  now += RESOLUTION_WINDOW_MS;
  await assert.rejects(correlation().resolveCase(secondKey, { ...input, operationId: randomUUID(), expectedRevision: 0, attemptId: second.id, evidence: { transactionId: "unknown", initiatedAt: new Date(now - RESOLUTION_WINDOW_MS).toISOString(), source: "original_operation_provider_verified" } }, "operator-1"), /purchase_attempt_expired/);
  assert.equal((await correlation().status(second.owner, 1, second.id)).outcome, "expired_unresolved");
  await correlation().resolveCase(secondKey, { ...input, operationId: randomUUID(), expectedRevision: 0, attemptId: second.id, action: "close_unresolved", releaseLock: true }, "operator-1");
  now += 61 * 86400000;
  await new RetentionPurgeService(db).run({ execute: true, now: new Date(now) });
  const compact = await userRef(second.owner).collection("purchaseAttempts").doc(second.id).get();
  assert.equal(compact.get("compacted"), true); assert.equal(compact.get("projectId"), undefined);
  await assert.rejects(correlation().command(second.owner, 1, second.id, "candidate", "unknown"), /purchase_attempt_closed/);
  assert.equal((await userRef(first.owner).collection("purchaseConfirmations").doc(first.id).get()).exists, true);
  assert.equal((await userRef(first.owner).collection("purchaseReceipts").get()).size, 1);
});

test("cancel closes without fake receipt; unknown old result prevents late approval binding to the next attempt", async () => {
  const first = await seed();
  await correlation().command(first.owner, 1, first.id, "cancelled");
  assert.equal((await correlation().status(first.owner, 1, first.id)).outcome, "cancelled");
  await correlation().command(first.owner, 1, first.id, "cancelled");
  const nextId = randomUUID();
  await correlation().record(first.owner, 1, { ...first.confirmation, confirmationId: nextId });
  await correlation().command(first.owner, 1, nextId, "claim");
  await correlation().command(first.owner, 1, nextId, "candidate", "late-after-cancel");
  await processEvent(event(first.owner, "late-after-cancel"));
  assert.equal((await correlation().cases(first.owner, 1)).items[0]?.resolutionReason, "conflicting_attempt");
  assert.equal((await userRef(first.owner).collection("purchaseReceipts").get()).size, 0);
});
test("close + explicit release with a known different old candidate allows a new exact transaction", async () => {
  const first = await seed();
  await correlation().command(first.owner, 1, first.id, "candidate", "old");
  await userRef(first.owner).update({ contactEmailVerified: false });
  await processEvent(event(first.owner, "old"));
  const oldKey = transactionKey(scope, "old"), item = (await correlation().cases(first.owner, 1)).items[0]!;
  await correlation().resolveCase(oldKey, { operationId: randomUUID(), expectedRevision: item.revision, attemptId: first.id, action: "close_unresolved", evidenceReference: "provider/old/closed", releaseLock: true }, "operator");
  await userRef(first.owner).update({ contactEmailVerified: true });
  const next = randomUUID();
  await correlation().record(first.owner, 1, { ...first.confirmation, confirmationId: next });
  await correlation().command(first.owner, 1, next, "claim");
  await correlation().command(first.owner, 1, next, "candidate", "new");
  await processEvent(event(first.owner, "new"));
  assert.equal((await correlation().status(first.owner, 1, next)).outcome, "bound");
  await processEvent(event(first.owner, "old"));
  assert.equal((await userRef(first.owner).collection("purchaseReceipts").get()).size, 1);
});
test("legacy active attempt gets reachable historical reconciliation and explicit close without heuristic migration", async () => {
  const owner = randomUUID(), id = randomUUID();
  await userRef(owner).set({ acceptedTermsVersion: "v1", createdAt: Timestamp.now() });
  const input = { confirmationId: id, termsVersion: "v1", productIdentifier: "monthly", storefrontPrice: "29", locale: "en" as const };
  await userRef(owner).collection("purchaseConfirmations").doc(id).set({ ...input, acceptedAt: Timestamp.fromMillis(now) });
  await userRef(owner).collection("purchaseAttempts").doc("active").set({ confirmationId: id, productIdentifier: "monthly", createdAt: Timestamp.fromMillis(now), expiresAt: Timestamp.fromMillis(now + PURCHASE_WINDOW_MS), consumedAt: null });
  await assert.rejects(correlation().record(owner, 1, input), /purchase_attempt_active/);
  assert.equal((await correlation().status(owner, 1, id)).resolutionReason, "legacy_exact_binding_unavailable");
  const item = (await correlation().cases(owner, 1)).items[0]!;
  await correlation().resolveCase(item.transactionKey, { operationId: randomUUID(), expectedRevision: item.revision, attemptId: id, action: "close_unresolved", evidenceReference: "legacy/closed", releaseLock: true }, "operator");
  await correlation().record(owner, 1, { ...input, confirmationId: randomUUID() });
  assert.equal((await userRef(owner).collection("purchaseConfirmations").get()).size, 2);
  assert.equal((await userRef(owner).collection("purchaseAttempts").doc("active").get()).get("consumedAt"), null);
});
test("pending without a transaction has an operator case; 30d owner/operator status is expired", async () => {
  const first = await seed();
  now += PURCHASE_WINDOW_MS;
  await correlation().status(first.owner, 1, first.id);
  let item = (await correlation().cases(first.owner, 1)).items[0]!;
  assert.match(item.transactionKey, /^attempt-/);
  now += RESOLUTION_WINDOW_MS;
  item = (await correlation().cases(first.owner, 1)).items[0]!;
  assert.equal(item.status, "expired_unresolved");
  await new RetentionPurgeService(db).run({ execute: true, now: new Date(now) });
  assert.equal((await db.collection("revenueCatTransactions").doc(item.transactionKey).get()).get("status"), "expired_unresolved");
});
test("TRANSFER without transaction ID has owner-visible incidents, no recreated deleted owner, and no raw UUID in event", async () => {
  const first = await seed(), target = randomUUID();
  await userRef(target).set({ createdAt: Timestamp.now() });
  const e = event(first.owner, "ignored", now, { type: "TRANSFER", transaction_id: undefined, product_id: undefined, store: undefined, entitlement_ids: undefined, transferred_from: [first.owner], transferred_to: [target] });
  await processEvent(e);
  assert.equal((await correlation().cases(first.owner, 1)).items[0]?.resolutionReason, "identity_reconciliation_required");
  assert.equal((await correlation().cases(target, 1)).items[0]?.resolutionReason, "identity_reconciliation_required");
  const rows = await db.collection("revenueCatEvents").get();
  assert.equal(JSON.stringify(rows.docs.map(doc => doc.data())).includes(first.owner), false);
  const gone = randomUUID();
  await processEvent(event(gone, "gone", now, { original_app_user_id: first.owner }));
  assert.equal((await userRef(gone).get()).exists, false);
  assert.equal((await db.collection("revenueCatTransactions").where("ownerAccountId", "==", gone).get()).size, 0);
});
test("receipt without verified contact stays a case; adding contact resolves, compaction replay does not conflict or resend", async () => {
  const first = await seed();
  await userRef(first.owner).update({ contactEmailVerified: false });
  await correlation().command(first.owner, 1, first.id, "candidate", "contact");
  const e = event(first.owner, "contact"); await processEvent(e);
  assert.equal((await correlation().cases(first.owner, 1)).items[0]?.resolutionReason, "receipt_contact_required");
  await userRef(first.owner).update({ contactEmailVerified: true });
  const result = await processEvent(e); assert.ok(result.receipt);
  await store.markReceiptDelivery(first.owner, result.receipt.receiptId, result.receipt.deliveryClaimId, "sent");
  await new RetentionPurgeService(db).run({ execute: true, now: new Date(now + 91 * 86400000) });
  await processEvent(e);
  assert.equal(await store.identityAvailable(first.owner), true);
  assert.equal((await userRef(first.owner).collection("purchaseReceipts").doc(result.receipt.receiptId).collection("deliveryAttempts").get()).size, 1);
});

test("actual mobile API client parses backend confirmation, claim, pending/candidate and case output", async () => {
  const adapterUrl = new URL("../../patternly/src/infrastructure/clients/PatternlyApiClientAdapter.ts", import.meta.url).href;
  const adapter = await import(adapterUrl) as { createPatternlyApiClient(input: { apiOrigin: string; getIdToken(): Promise<string>; getAppCheckToken(): Promise<string>; fetchImplementation(input: string | URL | Request, init?: RequestInit): Promise<Response> }): { recordPurchaseConfirmation(body: Record<string, unknown>): Promise<{ confirmation: { confirmationId: string; attemptExpiresAt: string } }>; getPurchaseAttempt(id: string): Promise<{ attempt: { outcome: string } }>; commandPurchaseAttempt(id: string, input: Record<string, unknown>): Promise<{ attempt: { dispatchAllowed?: boolean; outcome: string } }>; getPurchaseCases(): Promise<{ items: Array<{ resolutionReason: string }> }> } };
  const auth = await createVerifiedAuthUser(), registered = await registerAuthUser(context, auth);
  await userRef(registered.userId).update({ acceptedTermsVersion: "v1" });
  const client = adapter.createPatternlyApiClient({ apiOrigin: "https://api.patternly.invalid", getIdToken: async () => registered.idToken, getAppCheckToken: async () => TEST_APP_CHECK_TOKEN, fetchImplementation: async (url, init) => {
    const target = new URL(String(url));
    const response = await context.app.inject({ method: init?.method === "POST" ? "POST" : "GET", url: target.pathname + target.search, headers: Object.fromEntries(new Headers(init?.headers)), ...(init?.body === undefined ? {} : { payload: String(init.body) }) });
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  } });
  const id = randomUUID();
  assert.equal((await client.recordPurchaseConfirmation({ confirmationId: id, termsVersion: "v1", productIdentifier: "monthly", storefrontPrice: "29", locale: "pl", immediateStartRequested: true })).confirmation.confirmationId, id);
  assert.equal((await client.commandPurchaseAttempt(id, { action: "claim" })).attempt.dispatchAllowed, true);
  assert.equal((await client.commandPurchaseAttempt(id, { action: "pending" })).attempt.outcome, "pending");
  await processEvent(event(registered.userId, "mobile", Date.now()));
  assert.equal((await client.getPurchaseCases()).items[0]?.resolutionReason, "missing_exact_binding");
  assert.equal((await client.commandPurchaseAttempt(id, { action: "candidate", transactionId: "mobile" })).attempt.outcome, "bound");
  assert.equal((await client.getPurchaseAttempt(id)).attempt.outcome, "bound");
});
