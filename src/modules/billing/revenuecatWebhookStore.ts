import type { Firestore } from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createHash, randomUUID } from "node:crypto";
import { COLLECTIONS } from "../../infrastructure/firestore/paths.js";
import { revenueCatEventSchema, reduceRevenueCatEvent, type RevenueCatEvent } from "./revenuecatWebhook.js";

export type PurchaseReceiptDelivery = Readonly<{ userId: string; receiptId: string; deliveryClaimId: string; recipient: string; transactionId: string; confirmationId: string; productIdentifier: string; storefrontPrice: string; locale: "en" | "pl"; termsVersion: string; immediateStartRequested: true }>;
export type RevenueCatWebhookResult = Readonly<{ outcome: "processed" | "ignored"; duplicate: boolean; receipt?: PurchaseReceiptDelivery }>;
export interface RevenueCatWebhookStore {
  process(event: RevenueCatEvent, appId: string, expectedEnvironment: "PRODUCTION" | "SANDBOX", entitlementId: string, productId: string): Promise<RevenueCatWebhookResult>;
  markReceiptDelivery(userId: string, receiptId: string, deliveryClaimId: string, status: "sent" | "failed"): Promise<boolean>;
}
function strictlyNewer(timestamp: number, eventId: string, snapshot: { exists: boolean; get(field: string): unknown }): boolean {
  if (!snapshot.exists) return true;
  const currentTimestamp = snapshot.get("eventTimestampMs"); const currentEventId = snapshot.get("eventId");
  return typeof currentTimestamp !== "number" || timestamp > currentTimestamp || (timestamp === currentTimestamp && typeof currentEventId === "string" && eventId > currentEventId);
}
export class FirestoreRevenueCatWebhookStore implements RevenueCatWebhookStore {
  constructor(private readonly db: Firestore) {}
  async process(event: RevenueCatEvent, appId: string, expectedEnvironment: "PRODUCTION" | "SANDBOX", entitlementId: string, productId: string): Promise<RevenueCatWebhookResult> {
    const parsed = revenueCatEventSchema.parse(event);
    const key = createHash("sha256").update(`${appId}\0${expectedEnvironment}\0${parsed.id}`, "utf8").digest("hex");
    const eventRef = this.db.collection("revenueCatEvents").doc(key);
    const projection = reduceRevenueCatEvent(parsed);
    const baseTrusted = parsed.app_id === appId && parsed.environment === expectedEnvironment;
    const trusted = baseTrusted && parsed.product_id === productId && parsed.entitlement_ids?.includes(entitlementId) === true;
    const userId = parsed.app_user_id && parsed.app_user_id.length <= 128 ? parsed.app_user_id : null;
    const userRef = userId ? this.db.collection(COLLECTIONS.users).doc(userId) : null;
    const entitlementRef = userRef?.collection("entitlements").doc(entitlementId) ?? null;
    const activeAttemptRef = userRef?.collection("purchaseAttempts").doc("active") ?? null;
    return this.db.runTransaction(async (tx) => {
      const existing = await tx.get(eventRef);
      if (existing.exists) {
        const receiptId = existing.get("receiptId");
        if (typeof receiptId === "string" && userRef) {
          const receiptRef = userRef.collection("purchaseReceipts").doc(receiptId);
          const receipt = await tx.get(receiptRef);
          const deliveryStatus = receipt.get("deliveryStatus");
          const leaseUntil = receipt.get("deliveryLeaseUntil");
          const leaseExpired = !(leaseUntil instanceof Timestamp) || leaseUntil.toMillis() <= Date.now();
          if (receipt.exists && deliveryStatus !== "sent" && (deliveryStatus !== "sending" || leaseExpired)) {
            const deliveryClaimId = randomUUID();
            tx.set(receiptRef, { deliveryStatus: "sending", deliveryClaimId, deliveryLeaseUntil: Timestamp.fromMillis(Date.now() + 5 * 60_000), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
            return { outcome: "processed", duplicate: true, receipt: this.receiptDelivery(receiptId, { ...asReceipt(receipt.data()), deliveryClaimId }) };
          }
        }
        return { outcome: existing.get("outcome") === "processed" ? "processed" : "ignored", duplicate: true };
      }
      if (parsed.type === "TRANSFER") {
        const fromIds = [...new Set(parsed.transferred_from ?? [])].filter((id) => id.length <= 128);
        const toIds = [...new Set(parsed.transferred_to ?? [])].filter((id) => id.length <= 128);
        if (!baseTrusted || fromIds.length === 0 || toIds.length === 0 || fromIds.some((id) => toIds.includes(id))) {
          tx.create(eventRef, { appId, environment: expectedEnvironment, eventId: parsed.id, eventTimestampMs: parsed.event_timestamp_ms, outcome: "ignored", processedAt: FieldValue.serverTimestamp() });
          return { outcome: "ignored", duplicate: false };
        }
        const fromUserRefs = fromIds.map((id) => this.db.collection(COLLECTIONS.users).doc(id)); const toUserRefs = toIds.map((id) => this.db.collection(COLLECTIONS.users).doc(id));
        const fromEntitlementRefs = fromUserRefs.map((ref) => ref.collection("entitlements").doc(entitlementId)); const toEntitlementRefs = toUserRefs.map((ref) => ref.collection("entitlements").doc(entitlementId));
        const [fromUsers, toUsers, sources, targets] = await Promise.all([
          Promise.all(fromUserRefs.map((ref) => tx.get(ref))), Promise.all(toUserRefs.map((ref) => tx.get(ref))),
          Promise.all(fromEntitlementRefs.map((ref) => tx.get(ref))), Promise.all(toEntitlementRefs.map((ref) => tx.get(ref))),
        ]);
        const existingTargets = toUsers.map((user, index) => ({ user, target: targets[index]!, ref: toEntitlementRefs[index]! })).filter(({ user }) => user.exists);
        const activeSources = fromUsers.map((user, index) => ({ user, source: sources[index]!, ref: fromEntitlementRefs[index]! })).filter(({ user, source }) => user.exists && source.exists && source.get("status") === "active");
        const ordered = [...activeSources.map(({ source }) => source), ...existingTargets.map(({ target }) => target)].every((snapshot) => strictlyNewer(parsed.event_timestamp_ms, parsed.id, snapshot));
        const canTransfer = existingTargets.length === 1 && activeSources.length > 0 && ordered;
        tx.create(eventRef, { appId, environment: expectedEnvironment, eventId: parsed.id, eventTimestampMs: parsed.event_timestamp_ms, outcome: canTransfer ? "processed" : "ignored", processedAt: FieldValue.serverTimestamp() });
        if (!canTransfer) return { outcome: "ignored", duplicate: false };
        const common = { entitlement: entitlementId, source: "revenuecat", updatedAt: Timestamp.fromMillis(parsed.event_timestamp_ms), eventTimestampMs: parsed.event_timestamp_ms, eventId: parsed.id };
        for (const source of activeSources) tx.set(source.ref, { ...common, status: "revoked", willRenew: false }, { merge: true });
        const source = activeSources[0]!.source; const target = existingTargets[0]!;
        tx.set(target.ref, { ...common, status: "active", expiresAt: source.get("expiresAt") ?? null, willRenew: source.get("willRenew") !== false }, { merge: true });
        return { outcome: "processed", duplicate: false };
      }
      const user = trusted && projection && userRef ? await tx.get(userRef) : null;
      const current = user?.exists && entitlementRef ? await tx.get(entitlementRef) : null;
      let receipt: PurchaseReceiptDelivery | undefined;
      let receiptId: string | undefined;
      if (parsed.type === "INITIAL_PURCHASE" && trusted && user?.exists && userRef && activeAttemptRef && typeof parsed.transaction_id === "string" && typeof parsed.purchased_at_ms === "number") {
        const attempt = await tx.get(activeAttemptRef);
        if (attempt.exists && attempt.get("consumedAt") == null && attempt.get("productIdentifier") === parsed.product_id) {
          const expiresAt = attempt.get("expiresAt");
          const confirmationId = attempt.get("confirmationId");
          if (expiresAt instanceof Timestamp && expiresAt.toMillis() >= parsed.purchased_at_ms && typeof confirmationId === "string") {
            const confirmation = await tx.get(userRef.collection("purchaseConfirmations").doc(confirmationId));
            const recipient = user.get("contactEmail");
            if (confirmation.exists && typeof recipient === "string" && user.get("contactEmailVerified") === true) {
              receiptId = createHash("sha256").update(parsed.transaction_id, "utf8").digest("hex");
              const deliveryClaimId = randomUUID();
              const receiptData = {
                userId, receiptId, deliveryClaimId, recipient, transactionId: parsed.transaction_id, confirmationId,
                productIdentifier: String(confirmation.get("productIdentifier")), storefrontPrice: String(confirmation.get("storefrontPrice")),
                locale: confirmation.get("locale") === "pl" ? "pl" : "en", termsVersion: String(confirmation.get("termsVersion")),
                immediateStartRequested: true as const, deliveryStatus: "sending", deliveryLeaseUntil: Timestamp.fromMillis(Date.now() + 5 * 60_000), eventId: parsed.id,
                createdAt: Timestamp.fromMillis(parsed.event_timestamp_ms), updatedAt: FieldValue.serverTimestamp(),
              };
              tx.create(userRef.collection("purchaseReceipts").doc(receiptId), receiptData);
              tx.set(activeAttemptRef, { consumedAt: FieldValue.serverTimestamp(), transactionId: parsed.transaction_id, receiptId }, { merge: true });
              receipt = this.receiptDelivery(receiptId, receiptData);
            }
          }
        }
      }
      const newer = current ? strictlyNewer(parsed.event_timestamp_ms, parsed.id, current) : true;
      const willProject = Boolean(trusted && projection && user?.exists && entitlementRef && newer);
      const outcome = willProject ? "processed" : "ignored";
      tx.create(eventRef, { appId, environment: expectedEnvironment, eventId: parsed.id, eventTimestampMs: parsed.event_timestamp_ms, outcome, ...(receiptId ? { receiptId, userId } : {}), processedAt: FieldValue.serverTimestamp() });
      if (willProject && entitlementRef && projection) tx.set(entitlementRef, {
        entitlement: entitlementId, status: projection.status, source: "revenuecat",
        expiresAt: projection.expiresAtMs === null ? null : Timestamp.fromMillis(projection.expiresAtMs),
        updatedAt: Timestamp.fromMillis(projection.eventTimestampMs), eventTimestampMs: projection.eventTimestampMs,
        eventId: projection.eventId, willRenew: projection.willRenew ?? true,
      }, { merge: true });
      return receipt ? { outcome, duplicate: false, receipt } : { outcome, duplicate: false };
    });
  }

  public async markReceiptDelivery(userId: string, receiptId: string, deliveryClaimId: string, status: "sent" | "failed"): Promise<boolean> {
    const ref = this.db.collection(COLLECTIONS.users).doc(userId).collection("purchaseReceipts").doc(receiptId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.get("deliveryStatus") !== "sending" || snapshot.get("deliveryClaimId") !== deliveryClaimId) return false;
      transaction.set(ref, { deliveryStatus: status, deliveryClaimId: null, deliveryLeaseUntil: null, updatedAt: FieldValue.serverTimestamp(), ...(status === "sent" ? { deliveredAt: FieldValue.serverTimestamp() } : {}) }, { merge: true });
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
