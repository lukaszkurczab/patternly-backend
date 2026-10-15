import type { Firestore } from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";
import { COLLECTIONS } from "../../infrastructure/firestore/paths.js";
import { revenueCatEventSchema, reduceRevenueCatEvent, type RevenueCatEvent } from "./revenuecatWebhook.js";
import { activeAccount, digest, FirestorePurchaseCorrelation, isAccountId, transactionKey, PURCHASE_PAYLOAD_MS } from "./purchaseCorrelation.js";

export type PurchaseReceiptDelivery = Readonly<{ userId: string; receiptId: string; deliveryClaimId: string; recipient: string; transactionId: string; confirmationId: string; productIdentifier: string; storefrontPrice: string; locale: "en" | "pl"; termsVersion: string; immediateStartRequested: true }>;
export type RevenueCatWebhookResult = Readonly<{ outcome: "processed" | "ignored"; duplicate: boolean; receipt?: PurchaseReceiptDelivery; receiptDeliveryState?: "pending" | "unknown" | "contact_required" }>;
export interface RevenueCatWebhookStore {
  process(event: RevenueCatEvent, appId: string, expectedEnvironment: "PRODUCTION" | "SANDBOX", entitlementId: string, productId: string): Promise<RevenueCatWebhookResult>;
  claimBoundReceipt(userId: string, key: string): Promise<Pick<RevenueCatWebhookResult, "receipt" | "receiptDeliveryState">>;
  claimReceipt(userId: string, receiptId: string): Promise<Pick<RevenueCatWebhookResult, "receipt" | "receiptDeliveryState">>;
  identityAvailable(userId: string): Promise<boolean>;
  markReceiptDelivery(userId: string, receiptId: string, deliveryClaimId: string, status: "sent" | "failed" | "unknown"): Promise<boolean>;
}
function hasActiveAuthorization(snapshot: { exists: boolean; data(): Record<string, unknown> | undefined }): boolean { return snapshot.exists && activeAccount(snapshot.data()); }
function strictlyNewer(timestamp: number, eventId: string, snapshot: { exists: boolean; get(field: string): unknown }): boolean {
  if (!snapshot.exists) return true;
  const currentTimestamp = snapshot.get("eventTimestampMs"), currentId = snapshot.get("eventId");
  return typeof currentTimestamp !== "number" || timestamp > currentTimestamp || (timestamp === currentTimestamp && typeof currentId === "string" && eventId > currentId);
}
export class FirestoreRevenueCatWebhookStore implements RevenueCatWebhookStore {
  constructor(private readonly db: Firestore, private readonly projectId?: string) {}
  async identityAvailable(userId: string): Promise<boolean> {
    const user = await this.db.collection("users").doc(userId).get();
    return activeAccount(user.data()) && user.get("billingIdentityConflict") !== true;
  }
  async process(event: RevenueCatEvent, appId: string, expectedEnvironment: "PRODUCTION" | "SANDBOX", entitlementId: string, productId: string): Promise<RevenueCatWebhookResult> {
    if (!this.projectId) throw new Error("revenuecat_not_configured");
    const parsed = revenueCatEventSchema.parse(event), projection = reduceRevenueCatEvent(parsed);
    const scope = { projectId: this.projectId, appId, environment: expectedEnvironment, productId };
    const eventKey = digest(JSON.stringify([this.projectId, appId, expectedEnvironment, parsed.id]));
    const fingerprint = digest(JSON.stringify([parsed.type, parsed.app_user_id, parsed.original_app_user_id, parsed.app_id, parsed.store, parsed.environment, parsed.product_id, parsed.transaction_id, parsed.purchased_at_ms, parsed.event_timestamp_ms, parsed.expiration_at_ms, [...(parsed.transferred_from ?? [])].sort(), [...(parsed.transferred_to ?? [])].sort()]));
    const eventRef = this.db.collection("revenueCatEvents").doc(eventKey);
    const baseTrusted = parsed.app_id === appId && parsed.environment === expectedEnvironment;
    const trusted = baseTrusted && parsed.store === "APP_STORE" && parsed.product_id === productId && parsed.entitlement_ids?.includes(entitlementId) === true;
    const owner = isAccountId(parsed.app_user_id) ? parsed.app_user_id : null;
    const identityValid = owner !== null && parsed.original_app_user_id === owner;
    const key = trusted && parsed.transaction_id ? transactionKey(scope, parsed.transaction_id) : null;
    const factRef = key ? this.db.collection("revenueCatTransactions").doc(key) : null;
    const result = await this.db.runTransaction(async tx => {
      const prior = await tx.get(eventRef);
      if (prior.exists && prior.get("fingerprint") !== fingerprint) throw new Error("revenuecat_event_conflict");
      const userRef = owner ? this.db.collection("users").doc(owner) : null;
      const user = userRef ? await tx.get(userRef) : null;
      const entitlementRef = userRef?.collection("entitlements").doc(entitlementId);
      const current = entitlementRef ? await tx.get(entitlementRef) : null;
      const fact = factRef ? await tx.get(factRef) : null;
      const affectedIds = parsed.type === "TRANSFER" ? [...new Set([...(parsed.transferred_from ?? []), ...(parsed.transferred_to ?? [])])].filter(isAccountId) : !identityValid && trusted ? [...new Set([parsed.app_user_id, parsed.original_app_user_id])].filter(isAccountId) : [];
      const affectedRefs = affectedIds.map(id => this.db.collection("users").doc(id));
      const affectedUsers = affectedRefs.length ? await tx.getAll(...affectedRefs) : [];
      if (!baseTrusted || (parsed.type !== "TRANSFER" && !trusted)) {
        if (!prior.exists) tx.create(eventRef, { fingerprint, eventId: parsed.id, outcome: "ignored", processedAt: FieldValue.serverTimestamp() });
        return { outcome: "ignored" as const, duplicate: prior.exists };
      }
      if (parsed.type === "TRANSFER" || !identityValid) {
        if (!prior.exists) {
          const activeOwnerIndex = affectedUsers.findIndex(hasActiveAuthorization);
          if (trusted && factRef && activeOwnerIndex >= 0) {
            if (!fact?.exists) tx.create(factRef, { ...scope, store: "APP_STORE", ownerAccountId: affectedIds[activeOwnerIndex], productId: parsed.product_id, transactionId: parsed.transaction_id, purchasedAtMs: parsed.purchased_at_ms ?? null, boundConfirmationId: null, identityConflict: true, status: "reconciliation_required", resolutionReason: "identity_conflict", revision: 0, createdAt: Timestamp.now(), payloadUntil: Timestamp.fromMillis(Date.now() + PURCHASE_PAYLOAD_MS) });
            else tx.update(factRef, { identityConflict: true, resolutionReason: "identity_conflict", revision: Number(fact.get("revision") ?? 0) + 1 });
          }
          tx.create(eventRef, { fingerprint, eventId: parsed.id, outcome: "ignored", resolutionReason: "identity_reconciliation_required", createdAt: Timestamp.now(), payloadUntil: Timestamp.fromMillis(Date.now() + PURCHASE_PAYLOAD_MS) });
          affectedUsers.forEach((target, index) => {
            if (!hasActiveAuthorization(target)) return;
            tx.update(affectedRefs[index]!, { billingIdentityConflict: true });
            tx.create(this.db.collection("revenueCatTransactions").doc(`event-${digest(JSON.stringify([eventKey, affectedIds[index]]))}`), { ownerAccountId: affectedIds[index], status: "reconciliation_required", resolutionReason: "identity_reconciliation_required", revision: 0, identityConflict: true, createdAt: Timestamp.now(), payloadUntil: Timestamp.fromMillis(Date.now() + PURCHASE_PAYLOAD_MS) });
          });
        }
        return { outcome: "ignored" as const, duplicate: prior.exists };
      }
      if (!user || !hasActiveAuthorization(user)) {
        if (!prior.exists) tx.create(eventRef, { fingerprint, eventId: parsed.id, outcome: "ignored", processedAt: FieldValue.serverTimestamp() });
        return { outcome: "ignored" as const, duplicate: prior.exists };
      }
      let conflict = fact?.exists && (fact.get("ownerAccountId") !== owner || fact.get("productId") !== parsed.product_id || (typeof parsed.purchased_at_ms === "number" && fact.get("purchasedAtMs") !== parsed.purchased_at_ms));
      const oldOwnerRef = conflict && isAccountId(fact!.get("ownerAccountId")) ? this.db.collection("users").doc(String(fact!.get("ownerAccountId"))) : null;
      const oldOwner = oldOwnerRef ? await tx.get(oldOwnerRef) : null;
      if (conflict && factRef) {
        tx.update(factRef, { identityConflict: true, status: "reconciliation_required", resolutionReason: "identity_conflict", revision: Number(fact!.get("revision") ?? 0) + (prior.exists ? 0 : 1) });
        if (!prior.exists) {
          for (const accountId of [...new Set([owner, oldOwnerRef?.id])]) {
            if (typeof accountId !== "string") continue;
            const targetActive = accountId === owner ? hasActiveAuthorization(user) : oldOwner !== null && hasActiveAuthorization(oldOwner);
            if (targetActive) tx.create(this.db.collection("revenueCatTransactions").doc(`event-${digest(JSON.stringify([eventKey, accountId]))}`), { ownerAccountId: accountId, status: "reconciliation_required", resolutionReason: "identity_reconciliation_required", revision: 0, identityConflict: true, createdAt: Timestamp.now(), payloadUntil: Timestamp.fromMillis(Date.now() + PURCHASE_PAYLOAD_MS) });
          }
        }
        tx.update(userRef!, { billingIdentityConflict: true });
        if (oldOwner && oldOwnerRef && hasActiveAuthorization(oldOwner)) tx.update(oldOwnerRef, { billingIdentityConflict: true });
      }
      conflict = conflict || fact?.get("identityConflict") === true || user.get("billingIdentityConflict") === true;
      // Paid observations persist independently from the event's projection order.
      if (parsed.type === "INITIAL_PURCHASE" && !conflict) {
        if (factRef && !fact?.exists) tx.create(factRef, { ...scope, store: "APP_STORE", ownerAccountId: owner, productId: parsed.product_id, transactionId: parsed.transaction_id, purchasedAtMs: parsed.purchased_at_ms ?? null, boundConfirmationId: null, status: "reconciliation_required", resolutionReason: "missing_exact_binding", revision: 0, createdAt: Timestamp.now(), payloadUntil: Timestamp.fromMillis(Date.now() + PURCHASE_PAYLOAD_MS) });
        if (!factRef) {
          // Malformed paid events still have a durable, owner-visible case.
          const malformedRef = this.db.collection("revenueCatTransactions").doc(`event-${eventKey}`);
          if (!prior.exists) tx.create(malformedRef, { ownerAccountId: owner, status: "reconciliation_required", resolutionReason: "missing_transaction_id", revision: 0, createdAt: Timestamp.now(), payloadUntil: Timestamp.fromMillis(Date.now() + PURCHASE_PAYLOAD_MS) });
        }
      }
      const willProject = !conflict && projection && current && strictlyNewer(parsed.event_timestamp_ms, parsed.id, current);
      const outcome = willProject ? "processed" as const : "ignored" as const;
      if (!prior.exists) tx.create(eventRef, { fingerprint, eventId: parsed.id, outcome, processedAt: FieldValue.serverTimestamp() });
      if (willProject && entitlementRef && projection) tx.set(entitlementRef, { entitlement: entitlementId, status: projection.status, source: "revenuecat", expiresAt: projection.expiresAtMs === null ? null : Timestamp.fromMillis(projection.expiresAtMs), updatedAt: Timestamp.fromMillis(projection.eventTimestampMs), eventTimestampMs: projection.eventTimestampMs, eventId: projection.eventId, willRenew: projection.willRenew ?? true }, { merge: true });
      return { outcome: prior.exists && prior.get("outcome") === "processed" ? "processed" as const : outcome, duplicate: prior.exists };
    });
    // Always retry the resolver after event dedupe; a later candidate must not be lost.
    if (key && trusted && identityValid) await new FirestorePurchaseCorrelation(this.db, scope).resolve(key);
    const fact = factRef ? await factRef.get() : null;
    const receiptId = fact?.get("receiptId");
    const delivery = typeof receiptId === "string" && owner && fact?.get("ownerAccountId") === owner && fact?.get("identityConflict") !== true ? await this.claimReceipt(owner, receiptId) : {};
    return { ...result, ...delivery };
  }
  async claimBoundReceipt(userId: string, key: string): Promise<Pick<RevenueCatWebhookResult, "receipt" | "receiptDeliveryState">> {
    const fact = await this.db.collection("revenueCatTransactions").doc(key).get();
    if (fact.get("ownerAccountId") !== userId || fact.get("identityConflict") === true || typeof fact.get("receiptId") !== "string") return {};
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
    return Object.freeze({ userId: String(data.userId), receiptId, deliveryClaimId: String(data.deliveryClaimId), recipient: String(data.recipient), transactionId: String(data.transactionId), confirmationId: String(data.confirmationId), productIdentifier: String(data.productIdentifier), storefrontPrice: String(data.storefrontPrice), locale: data.locale === "pl" ? "pl" : "en", termsVersion: String(data.termsVersion), immediateStartRequested: true });
  }
}

function asReceipt(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
