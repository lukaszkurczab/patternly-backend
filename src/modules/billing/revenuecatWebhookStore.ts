import type { Firestore } from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";
import { COLLECTIONS } from "../../infrastructure/firestore/paths.js";
import { revenueCatEventSchema, type RevenueCatEvent } from "./revenuecatWebhook.js";
import { activeAccount, digest, FirestorePurchaseCorrelation, isAccountId, transactionKey, PURCHASE_PAYLOAD_MS, type PurchaseScopeInput, type PurchaseStore } from "./purchaseCorrelation.js";
import { productIdentifier, type PremiumMap, type StoreBinding } from "../../config/premiumMap.js";
import type { RevenueCatEntitlementReader, RevenueCatEntitlementResult } from "../../infrastructure/revenuecat/client.js";

export type PurchaseReceiptDelivery = Readonly<{ userId: string; receiptId: string; deliveryClaimId: string; recipient: string; transactionId: string; confirmationId: string; productIdentifier: string; storefrontPrice: string; locale: "en" | "pl"; termsVersion: string; immediateStartRequested: true; store?: PurchaseStore }>;
export type RevenueCatWebhookResult = Readonly<{ outcome: "processed" | "ignored"; duplicate: boolean; refreshPending?: boolean; receipt?: PurchaseReceiptDelivery; receiptDeliveryState?: "pending" | "unknown" | "contact_required" }>;
export type RevenueCatRefreshReader = RevenueCatEntitlementReader;
export interface RevenueCatWebhookStore {
  process(event: RevenueCatEvent, appId: string, expectedEnvironment: "PRODUCTION" | "SANDBOX", entitlementId: string, productId: string, refreshReader?: RevenueCatRefreshReader): Promise<RevenueCatWebhookResult>;
  claimBoundReceipt(userId: string, key: string): Promise<Pick<RevenueCatWebhookResult, "receipt" | "receiptDeliveryState">>;
  claimReceipt(userId: string, receiptId: string): Promise<Pick<RevenueCatWebhookResult, "receipt" | "receiptDeliveryState">>;
  identityAvailable(userId: string): Promise<boolean>;
  markIdentityConflict(userId: string): Promise<void>;
  markReceiptDelivery(userId: string, receiptId: string, deliveryClaimId: string, status: "sent" | "failed" | "unknown"): Promise<boolean>;
}
function hasActiveAuthorization(snapshot: { exists: boolean; data(): Record<string, unknown> | undefined }): boolean { return snapshot.exists && activeAccount(snapshot.data()); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export class FirestoreRevenueCatWebhookStore implements RevenueCatWebhookStore {
  private readonly projectId: string | undefined;
  private readonly map: PremiumMap | undefined;
  private readonly refreshReader: RevenueCatRefreshReader | undefined;
  constructor(private readonly db: Firestore, scope: string | PremiumMap | PurchaseScopeInput | undefined, mapOrReader?: PremiumMap | RevenueCatRefreshReader, refreshReader?: RevenueCatRefreshReader) {
    if (typeof scope === "string") {
      this.projectId = scope;
      if (mapOrReader && "bindings" in mapOrReader) this.map = mapOrReader;
      else this.refreshReader = mapOrReader;
    } else if (scope && "bindings" in scope) { this.map = scope; this.projectId = scope.projectId; }
    else this.projectId = scope?.projectId;
    if (refreshReader) this.refreshReader = refreshReader;
  }
  async identityAvailable(userId: string): Promise<boolean> {
    const user = await this.db.collection("users").doc(userId).get();
    return activeAccount(user.data()) && user.get("billingIdentityConflict") !== true;
  }
  async markIdentityConflict(userId: string): Promise<void> {
    const userRef = this.db.collection("users").doc(userId);
    await this.db.runTransaction(async tx => {
      const user = await tx.get(userRef);
      if (hasActiveAuthorization(user)) tx.update(userRef, { billingIdentityConflict: true });
    });
  }
  private eventBinding(event: RevenueCatEvent, appId: string, environment: "PRODUCTION" | "SANDBOX", legacyProductId: string): StoreBinding | undefined {
    if (this.map) return this.map.bindings.find(binding => binding.appId === event.app_id && binding.store === event.store && productIdentifier(binding) === event.product_id);
    if (event.app_id !== appId || event.environment !== environment || event.store !== "APP_STORE" || event.product_id !== legacyProductId) return undefined;
    return { platform: "ios", store: "APP_STORE", appId, rcProductId: legacyProductId, storeProductId: legacyProductId, basePlanId: null };
  }
  private async completeRefresh(userId: string, fence: number, result: RevenueCatEntitlementResult): Promise<boolean> {
    const ref = this.db.collection("users").doc(userId).collection("entitlements").doc("premium");
    return this.db.runTransaction(async tx => {
      const current = await tx.get(ref);
      if (!current.exists || current.get("refreshFence") !== fence || current.get("refreshPending") !== true) return false;
      tx.set(ref, { entitlement: result.entitlement, status: result.state, source: "revenuecat", expiresAt: result.providerExpiresAt === null ? null : Timestamp.fromDate(new Date(result.providerExpiresAt)), updatedAt: Timestamp.fromDate(new Date(result.providerObservedAt)), readerSnapshot: result, mapVersion: result.mapVersion, environment: result.environment, refreshPending: false, refreshedFence: fence, refreshedAt: FieldValue.serverTimestamp() }, { merge: true });
      return true;
    });
  }
  private async completeIdentityConflict(userId: string, fence: number, result: RevenueCatEntitlementResult): Promise<void> {
    const ref = this.db.collection("users").doc(userId).collection("entitlements").doc("premium");
    await this.db.runTransaction(async tx => {
      const current = await tx.get(ref);
      if (!current.exists || current.get("refreshFence") !== fence || current.get("refreshPending") !== true) return;
      tx.set(ref, { entitlement: "premium", status: "unavailable", source: "revenuecat", readerSnapshot: result, mapVersion: result.mapVersion, environment: result.environment, identityConflict: true, refreshPending: false, refreshedFence: fence, refreshedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
  }
  async process(event: RevenueCatEvent, appId: string, expectedEnvironment: "PRODUCTION" | "SANDBOX", entitlementId: string, productId: string, refreshReader = this.refreshReader): Promise<RevenueCatWebhookResult> {
    if (!this.projectId) throw new Error("revenuecat_not_configured");
    const parsed = revenueCatEventSchema.parse(event);
    const binding = this.eventBinding(parsed, appId, expectedEnvironment, productId);
    const store = binding?.store ?? (parsed.store === "PLAY_STORE" ? "PLAY_STORE" : "APP_STORE");
    const storeProductId = binding ? productIdentifier(binding) : productId;
    const rcProductId = binding?.rcProductId ?? productId;
    const scope = { projectId: this.projectId, appId: binding?.appId ?? appId, environment: expectedEnvironment, productId: rcProductId, store };
    const eventKey = digest(JSON.stringify([this.projectId, parsed.app_id, parsed.environment, parsed.id]));
    const fingerprint = digest(canonicalJson(parsed));
    const eventRef = this.db.collection("revenueCatEvents").doc(eventKey);
    const baseTrusted = this.map ? parsed.environment === this.map.environment && this.map.bindings.some(row => row.appId === parsed.app_id) : parsed.app_id === appId && parsed.environment === expectedEnvironment;
    const trusted = baseTrusted && !!binding && parsed.app_id === binding.appId && parsed.store === binding.store && parsed.product_id === storeProductId && parsed.entitlement_ids?.includes(entitlementId) === true;
    const owner = isAccountId(parsed.app_user_id) ? parsed.app_user_id : null;
    const identityValid = owner !== null && parsed.original_app_user_id === owner;
    const key = trusted && parsed.transaction_id ? transactionKey(scope, parsed.transaction_id) : null;
    const factRef = key ? this.db.collection("revenueCatTransactions").doc(key) : null;
    const result = await this.db.runTransaction(async tx => {
      const prior = await tx.get(eventRef);
      if (prior.exists && prior.get("fingerprint") !== fingerprint) throw new Error("revenuecat_event_conflict");
      if (!baseTrusted || (parsed.type !== "TRANSFER" && !trusted)) {
        if (!prior.exists) tx.create(eventRef, { fingerprint, eventId: parsed.id, outcome: "ignored", processedAt: FieldValue.serverTimestamp() });
        return { outcome: "ignored" as const, duplicate: prior.exists, owner: null as string | null, refreshFence: null as number | null };
      }
      if (parsed.type === "TRANSFER") {
        const affectedIds = [...new Set([...(parsed.transferred_from ?? []), ...(parsed.transferred_to ?? [])])].filter(isAccountId);
        const refs = affectedIds.map(id => this.db.collection("users").doc(id));
        const affected = refs.length ? await tx.getAll(...refs) : [];
        if (!prior.exists) {
          affected.forEach((target, index) => { if (hasActiveAuthorization(target)) tx.update(refs[index]!, { billingIdentityConflict: true }); });
          tx.create(eventRef, { fingerprint, eventId: parsed.id, outcome: "ignored", resolutionReason: "identity_reconciliation_required", createdAt: Timestamp.now(), payloadUntil: Timestamp.fromMillis(Date.now() + PURCHASE_PAYLOAD_MS) });
          affectedIds.forEach((id, index) => { if (hasActiveAuthorization(affected[index]!)) tx.create(this.db.collection("revenueCatTransactions").doc(`event-${digest(JSON.stringify([eventKey, id]))}`), { ownerAccountId: id, status: "reconciliation_required", resolutionReason: "identity_reconciliation_required", revision: 0, identityConflict: true, createdAt: Timestamp.now(), payloadUntil: Timestamp.fromMillis(Date.now() + PURCHASE_PAYLOAD_MS) }); });
        }
        return { outcome: "ignored" as const, duplicate: prior.exists, owner: null as string | null, refreshFence: null as number | null };
      }
      if (!owner || !identityValid) {
        const affectedIds = [...new Set([parsed.app_user_id, parsed.original_app_user_id])].filter(isAccountId);
        const refs = affectedIds.map(id => this.db.collection("users").doc(id));
        const users = refs.length ? await tx.getAll(...refs) : [];
        if (!prior.exists) {
          users.forEach((target, index) => { if (hasActiveAuthorization(target)) tx.update(refs[index]!, { billingIdentityConflict: true }); });
          tx.create(eventRef, { fingerprint, eventId: parsed.id, outcome: "ignored", resolutionReason: "identity_reconciliation_required", createdAt: Timestamp.now(), payloadUntil: Timestamp.fromMillis(Date.now() + PURCHASE_PAYLOAD_MS) });
        }
        return { outcome: "ignored" as const, duplicate: prior.exists, owner: null as string | null, refreshFence: null as number | null };
      }
      const userRef = this.db.collection("users").doc(owner), user = await tx.get(userRef);
      if (!hasActiveAuthorization(user)) {
        if (!prior.exists) tx.create(eventRef, { fingerprint, eventId: parsed.id, outcome: "ignored", processedAt: FieldValue.serverTimestamp() });
        return { outcome: "ignored" as const, duplicate: prior.exists, owner: null as string | null, refreshFence: null as number | null };
      }
      const fact = factRef ? await tx.get(factRef) : null;
      const priorStore = fact?.get("store") ?? "APP_STORE";
      const priorStoreProduct = fact?.get("storeProductId") ?? fact?.get("productIdentifier") ?? fact?.get("productId");
      const conflict = fact?.exists === true && (fact.get("ownerAccountId") !== owner || priorStore !== store || priorStoreProduct !== storeProductId || fact.get("appId") !== scope.appId || fact.get("environment") !== expectedEnvironment || (typeof parsed.purchased_at_ms === "number" && fact.get("purchasedAtMs") !== parsed.purchased_at_ms));
      const oldOwnerId = conflict && fact?.exists && isAccountId(fact.get("ownerAccountId")) ? String(fact.get("ownerAccountId")) : null;
      const oldOwnerRef = oldOwnerId && oldOwnerId !== owner ? this.db.collection("users").doc(oldOwnerId) : null;
      const oldOwner = oldOwnerRef ? await tx.get(oldOwnerRef) : null;
      const refreshRef = userRef.collection("entitlements").doc("premium"), refresh = await tx.get(refreshRef);
      const refreshFence = prior.exists && refresh.get("refreshPending") !== true ? null : Number(refresh.get("refreshFence") ?? 0) + 1;
      if (conflict && factRef) {
        tx.update(factRef, { identityConflict: true, status: "reconciliation_required", resolutionReason: "identity_conflict", revision: Number(fact!.get("revision") ?? 0) + (prior.exists ? 0 : 1) });
        tx.update(userRef, { billingIdentityConflict: true });
        if (oldOwnerRef && oldOwner && hasActiveAuthorization(oldOwner)) tx.update(oldOwnerRef, { billingIdentityConflict: true });
        if (!prior.exists) {
          for (const [accountId, target] of [[owner, user], ...(oldOwnerRef && oldOwner ? [[oldOwnerRef.id, oldOwner] as const] : [])] as const) {
            if (hasActiveAuthorization(target)) tx.create(this.db.collection("revenueCatTransactions").doc(`event-${digest(JSON.stringify([eventKey, accountId]))}`), { ownerAccountId: accountId, status: "reconciliation_required", resolutionReason: "identity_reconciliation_required", revision: 0, identityConflict: true, createdAt: Timestamp.now(), payloadUntil: Timestamp.fromMillis(Date.now() + PURCHASE_PAYLOAD_MS) });
          }
        }
      }
      if (parsed.type === "INITIAL_PURCHASE" && !conflict) {
        if (factRef && !fact?.exists) tx.create(factRef, { ...scope, store, storeProductId, productIdentifier: storeProductId, rcProductId, basePlanId: binding?.basePlanId ?? null, mapVersion: this.map?.version ?? null, ownerAccountId: owner, productId: storeProductId, transactionId: parsed.transaction_id, purchasedAtMs: parsed.purchased_at_ms ?? null, boundConfirmationId: null, status: "reconciliation_required", resolutionReason: "missing_exact_binding", revision: 0, createdAt: Timestamp.now(), payloadUntil: Timestamp.fromMillis(Date.now() + PURCHASE_PAYLOAD_MS) });
        if (!factRef && !prior.exists) tx.create(this.db.collection("revenueCatTransactions").doc(`event-${eventKey}`), { ownerAccountId: owner, status: "reconciliation_required", resolutionReason: "missing_transaction_id", revision: 0, createdAt: Timestamp.now(), payloadUntil: Timestamp.fromMillis(Date.now() + PURCHASE_PAYLOAD_MS) });
      }
      if (refreshFence !== null) tx.set(refreshRef, { entitlement: "premium", refreshFence, refreshPending: true, refreshRequestedAt: FieldValue.serverTimestamp(), refreshEventId: parsed.id }, { merge: true });
      if (!prior.exists) tx.create(eventRef, { fingerprint, eventId: parsed.id, outcome: "processed", createdAt: Timestamp.now(), payloadUntil: Timestamp.fromMillis(Date.now() + PURCHASE_PAYLOAD_MS) });
      return { outcome: "processed" as const, duplicate: prior.exists, owner, refreshFence };
    });
    let refreshPending = result.refreshFence !== null && !!result.owner;
    if (result.refreshFence !== null && result.owner && refreshReader) {
      try {
        const snapshot = await refreshReader.read(result.owner);
        if (snapshot.reason === "identity_conflict") {
          await this.markIdentityConflict(result.owner);
          await this.completeIdentityConflict(result.owner, result.refreshFence, snapshot);
          refreshPending = false;
        } else if (snapshot.state !== "unavailable") refreshPending = !(await this.completeRefresh(result.owner, result.refreshFence, snapshot));
      } catch { /* Durable refreshPending remains true for a later duplicate/read retry. */ }
    }
    if (key && trusted && identityValid && parsed.type === "INITIAL_PURCHASE") await new FirestorePurchaseCorrelation(this.db, this.map ?? { projectId: this.projectId, appId: scope.appId, environment: expectedEnvironment, productId: scope.productId }).resolve(key);
    const delivery = factRef && owner && trusted ? await this.claimBoundReceipt(owner, String(key)) : {};
    return { outcome: result.outcome, duplicate: result.duplicate, ...(result.refreshFence !== null ? { refreshPending } : {}), ...delivery };
  }
  async claimBoundReceipt(userId: string, key: string): Promise<Pick<RevenueCatWebhookResult, "receipt" | "receiptDeliveryState">> {
    const fact = await this.db.collection("revenueCatTransactions").doc(key).get();
    if (fact.get("ownerAccountId") !== userId || fact.get("identityConflict") === true || typeof fact.get("receiptId") !== "string") return {};
    const receiptId = String(fact.get("receiptId")), receipt = await this.db.collection("users").doc(userId).collection("purchaseReceipts").doc(receiptId).get();
    const factStore = fact.get("store") ?? "APP_STORE";
    const scopeMismatch = !receipt.exists || receipt.get("userId") !== userId || receipt.get("transactionKey") !== key
      || receipt.get("confirmationId") !== fact.get("boundConfirmationId") || receipt.get("transactionId") !== fact.get("transactionId")
      || (receipt.get("store") ?? "APP_STORE") !== factStore || receipt.get("productIdentifier") !== (fact.get("productIdentifier") ?? fact.get("storeProductId") ?? fact.get("productId"))
      || (receipt.get("projectId") !== undefined && receipt.get("projectId") !== fact.get("projectId"))
      || (receipt.get("appId") !== undefined && receipt.get("appId") !== fact.get("appId"))
      || (receipt.get("environment") !== undefined && receipt.get("environment") !== fact.get("environment"))
      || (receipt.get("basePlanId") !== undefined && receipt.get("basePlanId") !== fact.get("basePlanId"));
    if (scopeMismatch) {
      await this.db.runTransaction(async tx => {
        const current = await tx.get(this.db.collection("revenueCatTransactions").doc(key));
        if (current.get("ownerAccountId") === userId && current.get("receiptId") === receiptId) {
          tx.update(current.ref, { status: "reconciliation_required", resolutionReason: "receipt_scope_conflict", revision: Number(current.get("revision") ?? 0) + 1, receiptScopeConflict: true });
        }
      });
      return { receiptDeliveryState: "unknown" };
    }
    return this.claimReceipt(userId, String(fact.get("receiptId")));
  }
  async claimReceipt(userId: string, receiptId: string): Promise<Pick<RevenueCatWebhookResult, "receipt" | "receiptDeliveryState">> {
    const userRef = this.db.collection("users").doc(userId), receiptRef = userRef.collection("purchaseReceipts").doc(receiptId);
    return this.db.runTransaction(async tx => {
      const [user, receipt] = await tx.getAll(userRef, receiptRef);
      if (!hasActiveAuthorization(user!) || user!.get("billingIdentityConflict") === true || !receipt!.exists) return {};
      const status = receipt!.get("deliveryStatus"), leaseUntil = receipt!.get("deliveryLeaseUntil");
      const leaseExpired = !(leaseUntil instanceof Timestamp) || leaseUntil.toMillis() <= Date.now();
      if (status === "ready" || status === "failed") {
        if (user!.get("contactEmailVerified") !== true || typeof user!.get("contactEmail") !== "string") return { receiptDeliveryState: "contact_required" };
        const deliveryClaimId = randomUUID(), delivery = this.receiptDelivery(receiptId, { ...asReceipt(receipt!.data()), recipient: user!.get("contactEmail"), deliveryClaimId });
        tx.create(receiptRef.collection("deliveryAttempts").doc(deliveryClaimId), { payload: delivery, status: "pending", createdAt: FieldValue.serverTimestamp() });
        tx.update(receiptRef, { recipient: user!.get("contactEmail"), deliveryStatus: "sending", deliveryClaimId, deliveryLeaseUntil: Timestamp.fromMillis(Date.now() + 5 * 60_000), updatedAt: FieldValue.serverTimestamp() });
        return { receipt: delivery };
      }
      if (status !== "sent") {
        if (status === "sending" && leaseExpired) {
          const claimId = receipt!.get("deliveryClaimId");
          const attemptRef = typeof claimId === "string" ? receiptRef.collection("deliveryAttempts").doc(claimId) : null;
          const attempt = attemptRef ? await tx.get(attemptRef) : null;
          if (attempt?.exists && attemptRef) tx.update(attemptRef, { status: "unknown", reconciledAt: FieldValue.serverTimestamp() });
          tx.update(receiptRef, { deliveryStatus: "unknown", deliveryLeaseUntil: null, updatedAt: FieldValue.serverTimestamp() });
        }
        return { receiptDeliveryState: status === "sending" && !leaseExpired ? "pending" : "unknown" };
      }
      return {};
    });
  }
  public async markReceiptDelivery(userId: string, receiptId: string, deliveryClaimId: string, status: "sent" | "failed" | "unknown"): Promise<boolean> {
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const ref = userRef.collection("purchaseReceipts").doc(receiptId);
    return this.db.runTransaction(async (transaction) => {
      const user = await transaction.get(userRef);
      const snapshot = await transaction.get(ref);
      const attemptRef = ref.collection("deliveryAttempts").doc(deliveryClaimId);
      const attempt = await transaction.get(attemptRef);
      const leaseUntil = snapshot.get("deliveryLeaseUntil");
      if (!hasActiveAuthorization(user) || !snapshot.exists || snapshot.get("deliveryStatus") !== "sending" || snapshot.get("deliveryClaimId") !== deliveryClaimId
        || !(leaseUntil instanceof Timestamp) || leaseUntil.toMillis() <= Date.now() || !attempt.exists || attempt.get("status") !== "pending") return false;
      transaction.set(attemptRef, { status, completedAt: FieldValue.serverTimestamp() }, { merge: true });
      transaction.set(ref, { deliveryStatus: status, deliveryLeaseUntil: null, updatedAt: FieldValue.serverTimestamp(), ...(status === "sent" ? { deliveredAt: FieldValue.serverTimestamp() } : {}) }, { merge: true });
      return true;
    });
  }

  private receiptDelivery(receiptId: string, data: Record<string, unknown>): PurchaseReceiptDelivery {
    return Object.freeze({ userId: String(data.userId), receiptId, deliveryClaimId: String(data.deliveryClaimId), recipient: String(data.recipient), transactionId: String(data.transactionId), confirmationId: String(data.confirmationId), productIdentifier: String(data.productIdentifier), storefrontPrice: String(data.storefrontPrice), locale: data.locale === "pl" ? "pl" : "en", termsVersion: String(data.termsVersion), immediateStartRequested: true, store: data.store === "PLAY_STORE" ? "PLAY_STORE" : "APP_STORE" });
  }
}

function asReceipt(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
