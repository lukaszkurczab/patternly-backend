import type { Firestore } from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";
import { COLLECTIONS } from "../../infrastructure/firestore/paths.js";
import { revenueCatEventSchema, type RevenueCatEvent } from "./revenuecatWebhook.js";
import { activeAccount, digest, FirestorePurchaseCorrelation, isAccountId, transactionKey, PURCHASE_PAYLOAD_MS, type PurchaseScopeInput, type PurchaseStore } from "./purchaseCorrelation.js";
import { productIdentifier, type PremiumMap, type StoreBinding } from "../../config/premiumMap.js";
import type { RevenueCatEntitlementReader, RevenueCatEntitlementResult } from "../../infrastructure/revenuecat/client.js";
import { z } from "zod";
import { assertExpectedAuthorizationGeneration } from "../auth/authorizationGeneration.js";

const boundedReference = z.string().trim().min(1).max(512);
const receiptReconciliationScopeSchema = z.object({
  firebaseProjectId: boundedReference, databaseId: boundedReference, revenueCatProjectId: boundedReference,
  appId: boundedReference, environment: z.enum(["SANDBOX", "PRODUCTION"]), store: z.enum(["APP_STORE", "PLAY_STORE"]),
  rcProductId: boundedReference, productIdentifier: boundedReference, basePlanId: boundedReference.nullable(), mapVersion: boundedReference,
}).strict();
export const receiptReconciliationRequestSchema = z.object({
  mode: z.enum(["preview", "apply"]).default("preview"), operationId: z.string().uuid(),
  receiptId: z.string().regex(/^(?:play-)?[a-f0-9]{64}$/u), deliveryClaimId: z.string().uuid(),
  expectedAuthorizationGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expectedSnapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(), scope: receiptReconciliationScopeSchema,
  attestation: z.object({
    kind: z.literal("operator_attested_smtp_acceptance"), deliveryClaimId: z.string().uuid(), exactAttemptVerified: z.literal(true),
    smtpAcceptedAt: z.string().datetime(), providerAccountReference: boundedReference, providerEventReference: boundedReference,
    evidenceReference: boundedReference, evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
}).strict().superRefine((input, context) => {
  if (input.mode === "apply" && !input.expectedSnapshotFingerprint) context.addIssue({ code: "custom", path: ["expectedSnapshotFingerprint"], message: "required_for_apply" });
  if (input.attestation.deliveryClaimId !== input.deliveryClaimId) context.addIssue({ code: "custom", path: ["attestation"], message: "exact_attempt_required" });
});
export type ReceiptReconciliationRequest = z.infer<typeof receiptReconciliationRequestSchema>;
export type ReceiptReconciliationResult = Readonly<{ kind: "preview" | "reconciled" | "replayed" | "already_sent"; snapshotFingerprint?: string }>;

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
  reconcileReceipt(key: string, input: ReceiptReconciliationRequest, actorPseudonym: string, firebaseProjectId: string): Promise<ReceiptReconciliationResult>;
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

  /** Human-attested SMTP acceptance only. This owner never claims or sends mail. */
  public async reconcileReceipt(key: string, input: ReceiptReconciliationRequest, actorPseudonym: string, firebaseProjectId: string): Promise<ReceiptReconciliationResult> {
    if (!/^[a-f0-9]{64}$/u.test(key) || !receiptReconciliationRequestSchema.safeParse(input).success || !boundedReference.safeParse(actorPseudonym).success) throw new Error("receipt_reconciliation_invalid_request");
    const scope = input.scope, map = this.map;
    const binding = map?.bindings.find(row => row.appId === scope.appId && row.store === scope.store && row.rcProductId === scope.rcProductId
      && productIdentifier(row) === scope.productIdentifier && row.basePlanId === scope.basePlanId);
    if (!map || !binding || firebaseProjectId !== scope.firebaseProjectId || this.db.databaseId !== scope.databaseId
      || map.projectId !== scope.revenueCatProjectId || map.environment !== scope.environment || map.version !== scope.mapVersion) throw new Error("receipt_reconciliation_scope_conflict");
    return this.db.runTransaction(async tx => {
      const fact = await tx.get(this.db.collection("revenueCatTransactions").doc(key));
      const owner = fact.get("ownerAccountId");
      if (!fact.exists || !isAccountId(owner) || fact.get("receiptId") !== input.receiptId || typeof fact.get("boundConfirmationId") !== "string"
        || !/^[A-Za-z0-9_-]{1,128}$/u.test(fact.get("boundConfirmationId"))) throw new Error("receipt_reconciliation_identity_conflict");
      const userRef = this.db.collection("users").doc(owner), receiptRef = userRef.collection("purchaseReceipts").doc(input.receiptId);
      const attemptRef = receiptRef.collection("deliveryAttempts").doc(input.deliveryClaimId);
      const confirmationRef = userRef.collection("purchaseConfirmations").doc(String(fact.get("boundConfirmationId")));
      const [user, receipt, attempt, confirmation] = await tx.getAll(userRef, receiptRef, attemptRef, confirmationRef);
      try { if (!user!.exists) throw new Error(); assertExpectedAuthorizationGeneration(user!.data()!, input.expectedAuthorizationGeneration); }
      catch { throw new Error("receipt_reconciliation_authority_conflict"); }
      if (user!.get("billingIdentityConflict") === true || fact.get("identityConflict") === true || fact.get("status") !== "bound"
        || !receipt!.exists || !attempt!.exists || !confirmation!.exists) throw new Error("receipt_reconciliation_identity_conflict");
      const expectedScope = { projectId: map.projectId, appId: scope.appId, environment: map.environment, store: scope.store,
        rcProductId: scope.rcProductId, productIdentifier: scope.productIdentifier, basePlanId: scope.basePlanId, mapVersion: map.version };
      if (Object.entries(expectedScope).some(([field, value]) => fact.get(field) !== value || receipt!.get(field) !== value)
        || typeof fact.get("transactionId") !== "string" || transactionKey({ projectId: map.projectId, appId: scope.appId, environment: scope.environment, store: scope.store }, fact.get("transactionId")) !== key
        || receipt!.get("userId") !== owner || receipt!.get("receiptId") !== input.receiptId || receipt!.get("transactionKey") !== key
        || receipt!.get("confirmationId") !== confirmation!.id || receipt!.get("transactionId") !== fact.get("transactionId") || receipt!.get("deliveryClaimId") !== input.deliveryClaimId) throw new Error("receipt_reconciliation_identity_conflict");
      const payload = attempt!.get("payload") as Record<string, unknown> | undefined;
      const payloadIdentity = { userId: owner, receiptId: input.receiptId, deliveryClaimId: input.deliveryClaimId,
        recipient: receipt!.get("recipient"), transactionId: receipt!.get("transactionId"), confirmationId: confirmation!.id,
        productIdentifier: scope.productIdentifier, storefrontPrice: receipt!.get("storefrontPrice"), locale: receipt!.get("locale"),
        termsVersion: receipt!.get("termsVersion"), immediateStartRequested: true, store: scope.store };
      if (!payload || Object.keys(payload).length !== Object.keys(payloadIdentity).length || Object.entries(payloadIdentity).some(([field, value]) => payload[field] !== value)
        || typeof payload.recipient !== "string" || !payload.recipient.trim() || typeof payload.storefrontPrice !== "string" || !payload.storefrontPrice.trim()
        || typeof payload.termsVersion !== "string" || !payload.termsVersion.trim() || !["en", "pl"].includes(String(payload.locale))
        || ["productIdentifier", "storefrontPrice", "locale", "termsVersion", "immediateStartRequested"].some(field => confirmation!.get(field) !== payload[field])) throw new Error("receipt_reconciliation_identity_conflict");
      // Proof is trusted operator attestation, not automatic verification of a hash/provider event.
      const acceptedMs = Date.parse(input.attestation.smtpAcceptedAt), createdAt = attempt!.get("createdAt");
      if (!(createdAt instanceof Timestamp) || acceptedMs < createdAt.toMillis() || acceptedMs > Date.now()) throw new Error("receipt_reconciliation_attestation_invalid");
      const operationFingerprint = digest(canonicalJson({ key, actorPseudonym, ...input, mode: "apply" }));
      const resolution = attempt!.get("resolution") as Record<string, unknown> | undefined;
      // A committed replay must be recognized before its own write invalidates the preview CAS.
      if (resolution !== undefined) {
        if (!resolution || typeof resolution !== "object" || typeof resolution.operationId !== "string" || typeof resolution.fingerprint !== "string") throw new Error("receipt_reconciliation_state_invalid");
        if (resolution.operationId === input.operationId) {
          if (resolution.fingerprint !== operationFingerprint) throw new Error("receipt_reconciliation_operation_conflict");
          if (receipt!.get("deliveryStatus") !== "sent" || attempt!.get("status") !== "sent") throw new Error("receipt_reconciliation_state_invalid");
          return { kind: "replayed" };
        }
      }
      if (receipt!.get("deliveryStatus") === "sent" && attempt!.get("status") === "sent") return { kind: "already_sent" };
      const lease = receipt!.get("deliveryLeaseUntil"), receiptStatus = receipt!.get("deliveryStatus"), attemptStatus = attempt!.get("status");
      if (!(receiptStatus === "unknown" && attemptStatus === "unknown")
        && !(receiptStatus === "sending" && lease instanceof Timestamp && lease.toMillis() <= Date.now() && attemptStatus === "pending")) throw new Error("receipt_reconciliation_state_invalid");
      if (resolution !== undefined) throw new Error("receipt_reconciliation_state_invalid");
      const snapshotFingerprint = digest(canonicalJson([user!, fact, receipt!, attempt!, confirmation!].map(doc => [doc.ref.path, doc.updateTime!.seconds, doc.updateTime!.nanoseconds])));
      if (input.mode === "preview") return { kind: "preview", snapshotFingerprint };
      if (input.expectedSnapshotFingerprint !== snapshotFingerprint) throw new Error("receipt_reconciliation_snapshot_conflict");
      tx.update(attemptRef, { status: "sent", resolution: { operationId: input.operationId, fingerprint: operationFingerprint, actorPseudonym,
        priorReceiptStatus: receiptStatus, priorAttemptStatus: attemptStatus, attestation: input.attestation,
        smtpAcceptedAt: input.attestation.smtpAcceptedAt, resolutionRecordedAt: FieldValue.serverTimestamp() } });
      tx.update(receiptRef, { deliveryStatus: "sent", deliveryLeaseUntil: null, updatedAt: FieldValue.serverTimestamp() });
      return { kind: "reconciled" };
    });
  }

  private receiptDelivery(receiptId: string, data: Record<string, unknown>): PurchaseReceiptDelivery {
    return Object.freeze({ userId: String(data.userId), receiptId, deliveryClaimId: String(data.deliveryClaimId), recipient: String(data.recipient), transactionId: String(data.transactionId), confirmationId: String(data.confirmationId), productIdentifier: String(data.productIdentifier), storefrontPrice: String(data.storefrontPrice), locale: data.locale === "pl" ? "pl" : "en", termsVersion: String(data.termsVersion), immediateStartRequested: true, store: data.store === "PLAY_STORE" ? "PLAY_STORE" : "APP_STORE" });
  }
}

function asReceipt(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
