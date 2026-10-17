import { createHash } from "node:crypto";
import { Timestamp, type Firestore, type Transaction } from "firebase-admin/firestore";
import { assertExpectedAuthorizationGeneration, activeAuthorizationGeneration } from "../auth/authorizationGeneration.js";
import { productIdentifier, type PremiumMap, type StoreBinding } from "../../config/premiumMap.js";

export const PURCHASE_WINDOW_MS = 15 * 60_000;
export const RESOLUTION_WINDOW_MS = 30 * 86_400_000;
export const PURCHASE_PAYLOAD_MS = 90 * 86_400_000;
export const isAccountId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id);
export const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export type PurchaseStore = "APP_STORE" | "PLAY_STORE";
export type PurchaseScope = Readonly<{ projectId: string; appId: string; environment: "SANDBOX" | "PRODUCTION"; productId: string; store?: "APP_STORE" }>;
export type PurchaseConfirmation = Readonly<{ confirmationId: string; termsVersion: string; productIdentifier: string; storefrontPrice: string; locale: "en" | "pl"; store?: PurchaseStore }>;
type BillingMap = PremiumMap;
export type PurchaseScopeInput = PurchaseScope | BillingMap | null;
type ScopeInput = PurchaseScopeInput;
type BoundPurchaseScope = Readonly<{ projectId: string; appId: string; environment: "SANDBOX" | "PRODUCTION"; productId: string; store: PurchaseStore; rcProductId: string; storeProductId: string; basePlanId: string | null; mapVersion: string | null }>;
export function transactionKey(scope: PurchaseScope | Pick<BoundPurchaseScope, "projectId" | "appId" | "environment" | "store">, transactionId: string): string {
  return digest(JSON.stringify([scope.projectId, scope.appId, scope.store ?? "APP_STORE", scope.environment, transactionId]));
}
function isMap(value: ScopeInput): value is BillingMap { return value !== null && "bindings" in value; }
function logicalProduct(value: ScopeInput): string {
  if (isMap(value)) return "com.lkurczab.patternly.premium.monthly";
  return value?.productId ?? "com.lkurczab.patternly.premium.monthly";
}
function bindingScope(map: BillingMap, binding: StoreBinding): BoundPurchaseScope {
  return { projectId: map.projectId, appId: binding.appId, environment: map.environment, productId: binding.rcProductId, store: binding.store, rcProductId: binding.rcProductId, storeProductId: productIdentifier(binding), basePlanId: binding.basePlanId, mapVersion: map.version };
}
function scopeFromAttempt(data: Record<string, unknown>): BoundPurchaseScope {
  const store = data.store === "PLAY_STORE" ? "PLAY_STORE" : "APP_STORE";
  const productId = typeof data.productId === "string" ? data.productId : "";
  return { projectId: String(data.projectId ?? ""), appId: String(data.appId ?? ""), environment: data.environment === "PRODUCTION" ? "PRODUCTION" : "SANDBOX", productId, store, rcProductId: String(data.rcProductId ?? productId), storeProductId: String(data.storeProductId ?? data.productIdentifier ?? productId), basePlanId: typeof data.basePlanId === "string" ? data.basePlanId : null, mapVersion: typeof data.mapVersion === "string" ? data.mapVersion : null };
}
export function activeAccount(data: Record<string, unknown> | undefined): boolean {
  try { if (!data) return false; activeAuthorizationGeneration(data); return true; } catch { return false; }
}
const ms = (value: unknown): number => value instanceof Timestamp ? value.toMillis() : Number.NaN;
const terminal = new Set(["bound", "cancelled", "closed_unresolved", "expired_unresolved"]);
const publicAttempt = (id: string, data: Record<string, unknown>, now: number) => ({
  attemptId: id, outcome: terminal.has(String(data.outcome)) ? String(data.outcome) : now >= ms(data.resolveBy) ? "expired_unresolved" : now >= ms(data.startExpiresAt) ? "reconciliation_required" : String(data.outcome),
  acceptedAt: new Date(ms(data.acceptedAt)).toISOString(), startExpiresAt: new Date(ms(data.startExpiresAt)).toISOString(),
  initiatedAt: Number.isFinite(ms(data.initiatedAt)) ? new Date(ms(data.initiatedAt)).toISOString() : null,
  transactionKey: typeof data.boundTransactionKey === "string" ? data.boundTransactionKey : typeof data.candidateTransactionKey === "string" ? data.candidateTransactionKey : null,
  resolutionReason: typeof data.resolutionReason === "string" ? data.resolutionReason : null,
});

/** One resolver for SDK candidates, trusted observations and operational resolution. */
export class FirestorePurchaseCorrelation {
  constructor(private readonly db: Firestore, private readonly scope: ScopeInput, private readonly clock: () => number = Date.now) {}
  private configured(): Exclude<ScopeInput, null> { if (!this.scope) throw new Error("revenuecat_not_configured"); return this.scope; }
  private purchaseScope(product: string, store: PurchaseStore = "APP_STORE"): BoundPurchaseScope {
    const configured = this.configured();
    if (isMap(configured)) {
      const binding = configured.bindings.find(row => row.store === store && productIdentifier(row) === product);
      if (!binding) throw new Error("purchase_product_invalid");
      return bindingScope(configured, binding);
    }
    if (store !== "APP_STORE" || configured.productId !== product) throw new Error("purchase_product_invalid");
    return { projectId: configured.projectId, appId: configured.appId, environment: configured.environment, productId: configured.productId, store: "APP_STORE", rcProductId: configured.productId, storeProductId: configured.productId, basePlanId: null, mapVersion: null };
  }
  private expectedBinding(data: Record<string, unknown>): BoundPurchaseScope | null {
    const configured = this.configured();
    if (!isMap(configured)) {
      const binding = this.purchaseScope(configured.productId, "APP_STORE");
      return data.projectId === binding.projectId && data.appId === binding.appId && data.environment === binding.environment && (data.store ?? "APP_STORE") === "APP_STORE" && (data.productId ?? data.productIdentifier) === binding.productId ? binding : null;
    }
    const store = data.store === "PLAY_STORE" ? "PLAY_STORE" : "APP_STORE";
    const binding = configured.bindings.find(row => row.store === store && row.appId === data.appId
      && (data.rcProductId === row.rcProductId || (data.mapVersion == null && store === "APP_STORE"))
      && productIdentifier(row) === (data.storeProductId ?? data.productIdentifier ?? data.productId));
    if (!binding || data.projectId !== configured.projectId || data.environment !== configured.environment
      || (data.mapVersion != null && data.mapVersion !== configured.version) || (data.basePlanId ?? null) !== binding.basePlanId) return null;
    return bindingScope(configured, binding);
  }
  private async migrateLegacy(userId: string, generation: number): Promise<boolean> {
    const lockId = digest(logicalProduct(this.configured())), userRef = this.db.collection("users").doc(userId);
    return this.db.runTransaction(async tx => {
      const [user, legacy] = await tx.getAll(userRef, userRef.collection("purchaseAttempts").doc("active"));
      assertExpectedAuthorizationGeneration(user!.data() ?? { authorizationState: "deleted" }, generation);
      if (!legacy!.exists || legacy!.get("consumedAt") != null || legacy!.get("resolvedAt") != null) return false;
      const id = legacy!.get("confirmationId");
      if (typeof id !== "string" || !isAccountId(id)) throw new Error("purchase_legacy_reconciliation_required");
      const attemptRef = userRef.collection("purchaseAttempts").doc(id);
      const caseRef = this.db.collection("revenueCatTransactions").doc(`attempt-${digest(JSON.stringify([userId, id]))}`);
      const lockRef = userRef.collection("purchaseLocks").doc(lockId);
      const [confirmation, attempt, pendingCase, lock] = await tx.getAll(userRef.collection("purchaseConfirmations").doc(id), attemptRef, caseRef, lockRef);
      const acceptedAt = confirmation!.get("acceptedAt") instanceof Timestamp ? confirmation!.get("acceptedAt") as Timestamp : legacy!.get("createdAt") instanceof Timestamp ? legacy!.get("createdAt") as Timestamp : Timestamp.fromMillis(0);
      const startExpiresAt = Timestamp.fromMillis(acceptedAt.toMillis() + PURCHASE_WINDOW_MS), resolveBy = Timestamp.fromMillis(acceptedAt.toMillis() + RESOLUTION_WINDOW_MS), payloadUntil = Timestamp.fromMillis(acceptedAt.toMillis() + PURCHASE_PAYLOAD_MS);
      if (!attempt!.exists) tx.create(attemptRef, { ownerAccountId: userId, confirmationId: id, legacy: true, acceptedAt, startExpiresAt, initiatedAt: null, resolveBy, payloadUntil, outcome: this.clock() >= resolveBy.toMillis() ? "expired_unresolved" : "reconciliation_required", resolutionReason: "legacy_exact_binding_unavailable", boundTransactionKey: null, candidateTransactionKey: null });
      if (!pendingCase!.exists) tx.create(caseRef, { ownerAccountId: userId, attemptId: id, resolveBy, status: "reconciliation_required", resolutionReason: "legacy_exact_binding_unavailable", revision: 0, createdAt: acceptedAt, payloadUntil });
      if (!lock!.exists) tx.create(lockRef, { attemptId: id });
      return true;
    });
  }
  async record(userId: string, generation: number, input: PurchaseConfirmation) {
    const scope = this.purchaseScope(input.productIdentifier, input.store ?? "APP_STORE");
    const normalizedInput = { ...input, store: scope.store };
    if (await this.migrateLegacy(userId, generation)) throw new Error("purchase_attempt_active");
    const userRef = this.db.collection("users").doc(userId);
    const confirmationRef = userRef.collection("purchaseConfirmations").doc(input.confirmationId);
    const attemptRef = userRef.collection("purchaseAttempts").doc(input.confirmationId);
    const lockRef = userRef.collection("purchaseLocks").doc(digest(logicalProduct(this.configured())));
    const now = this.clock();
    const acceptedAt = Timestamp.fromMillis(now), startExpiresAt = Timestamp.fromMillis(now + PURCHASE_WINDOW_MS);
    return this.db.runTransaction(async tx => {
      const [user, confirmation, lock, legacy] = await tx.getAll(userRef, confirmationRef, lockRef, userRef.collection("purchaseAttempts").doc("active"));
      assertExpectedAuthorizationGeneration(user!.data() ?? { authorizationState: "deleted" }, generation);
      if (confirmation!.exists) {
        if (!Object.entries(normalizedInput).every(([key, value]) => (key === "store" && value === "APP_STORE" && confirmation!.get(key) === undefined) || confirmation!.get(key) === value)) throw new Error("purchase_confirmation_conflict");
        return { confirmationId: input.confirmationId, acceptedAt: new Date(ms(confirmation!.get("acceptedAt"))).toISOString(), attemptExpiresAt: new Date(ms(confirmation!.get("attemptExpiresAt"))).toISOString() };
      }
      if (user!.get("acceptedTermsVersion") !== input.termsVersion) throw new Error("legal_acceptance_required");
      if (user!.get("billingIdentityConflict") === true) throw new Error("identity_reconciliation_required");
      // Legacy active records are never used for binding. Keep their unresolved fence until explicitly handled.
      if (lock!.exists || (legacy!.exists && legacy!.get("consumedAt") == null && legacy!.get("resolvedAt") == null)) throw new Error("purchase_attempt_active");
      tx.create(confirmationRef, { ...normalizedInput, billingPeriod: "P1M", autoRenews: true, trialOffered: false, immediateStartRequested: true, acceptedAt, attemptExpiresAt: startExpiresAt });
      tx.create(attemptRef, { ownerAccountId: userId, confirmationId: input.confirmationId, generation, ...scope, productIdentifier: input.productIdentifier, acceptedAt, startExpiresAt, initiatedAt: null, outcome: "accepted", candidateTransactionKey: null, boundTransactionKey: null, resolutionReason: null, resolveBy: Timestamp.fromMillis(now + RESOLUTION_WINDOW_MS), payloadUntil: Timestamp.fromMillis(now + PURCHASE_PAYLOAD_MS) });
      tx.create(lockRef, { attemptId: input.confirmationId });
      return { confirmationId: input.confirmationId, acceptedAt: acceptedAt.toDate().toISOString(), attemptExpiresAt: startExpiresAt.toDate().toISOString() };
    });
  }
  async command(userId: string, generation: number, id: string, action: "claim" | "candidate" | "pending" | "cancelled", candidate?: string) {
    const userRef = this.db.collection("users").doc(userId), attemptRef = userRef.collection("purchaseAttempts").doc(id);
    const now = this.clock();
    const result = await this.db.runTransaction(async tx => {
      const [user, attempt] = await tx.getAll(userRef, attemptRef);
      assertExpectedAuthorizationGeneration(user!.data() ?? { authorizationState: "deleted" }, generation);
      if (!attempt!.exists || attempt!.get("ownerAccountId") !== userId) throw new Error("purchase_attempt_not_found");
      const data = attempt!.data()!;
      const scope = scopeFromAttempt(data);
      if (data.legacy === true) throw new Error("purchase_legacy_reconciliation_required");
      if (data.compacted === true && action !== "pending") throw new Error("purchase_attempt_closed");
      if (action === "claim") {
        // A replay cannot authorize another SDK effect, even before start expiry.
        if (data.initiatedAt != null) return { dispatchAllowed: false, ...publicAttempt(id, data, now) };
        if (now >= ms(data.startExpiresAt) || terminal.has(String(data.outcome))) throw new Error("purchase_attempt_expired");
        if (user!.get("billingIdentityConflict") === true) throw new Error("identity_reconciliation_required");
        const updated = { ...data, initiatedAt: Timestamp.fromMillis(now), outcome: "initiated" };
        tx.update(attemptRef, { initiatedAt: updated.initiatedAt, outcome: updated.outcome });
        return { dispatchAllowed: true, ...publicAttempt(id, updated, now) };
      }
      if (data.initiatedAt == null) throw new Error("purchase_attempt_not_initiated");
      if (action === "cancelled") {
        if (data.outcome === "cancelled") return { dispatchAllowed: false, ...publicAttempt(id, data, now) };
        if (data.candidateTransactionKey != null || data.boundTransactionKey != null || terminal.has(String(data.outcome))) throw new Error("purchase_attempt_closed");
        tx.update(attemptRef, { outcome: "cancelled", resolutionReason: "sdk_confirmed_cancel_or_reject" });
        tx.delete(userRef.collection("purchaseLocks").doc(digest(logicalProduct(this.configured()))));
        return { dispatchAllowed: false, ...publicAttempt(id, { ...data, outcome: "cancelled", resolutionReason: "sdk_confirmed_cancel_or_reject" }, now) };
      }
      if (action === "candidate") {
        if (!candidate) throw new Error("purchase_candidate_invalid");
        const key = transactionKey(scope, candidate);
        if (data.candidateTransactionKey !== null && data.candidateTransactionKey !== key) throw new Error("purchase_candidate_conflict");
        if (terminal.has(String(data.outcome)) && data.outcome !== "bound") throw new Error("purchase_attempt_closed");
        tx.update(attemptRef, { candidateTransactionKey: key });
        return { dispatchAllowed: false, ...publicAttempt(id, { ...data, candidateTransactionKey: key }, now) };
      }
      if (!terminal.has(String(data.outcome))) tx.update(attemptRef, { outcome: now >= ms(data.resolveBy) ? "expired_unresolved" : now >= ms(data.startExpiresAt) ? "reconciliation_required" : "pending" });
      return { dispatchAllowed: false, ...publicAttempt(id, data, now) };
    });
    if (action === "candidate" && candidate) {
      const attempt = await attemptRef.get();
      const scope = scopeFromAttempt(attempt.data() ?? {});
      await this.resolve(transactionKey(scope, candidate));
    }
    return { ...result, ...(await this.status(userId, generation, id)) };
  }
  async status(userId: string, generation: number, id: string) {
    const ref = this.db.collection("users").doc(userId);
    return this.db.runTransaction(async tx => {
      const [user, attempt] = await tx.getAll(ref, ref.collection("purchaseAttempts").doc(id));
      assertExpectedAuthorizationGeneration(user!.data() ?? { authorizationState: "deleted" }, generation);
      if (!attempt!.exists || attempt!.get("ownerAccountId") !== userId) throw new Error("purchase_attempt_not_found");
      const item = publicAttempt(id, attempt!.data()!, this.clock());
      const caseRef = this.db.collection("revenueCatTransactions").doc(`attempt-${digest(JSON.stringify([userId, id]))}`);
      const pendingCase = await tx.get(caseRef);
      if (["reconciliation_required", "expired_unresolved"].includes(item.outcome) && attempt!.get("candidateTransactionKey") == null && !pendingCase.exists) tx.create(caseRef, { ownerAccountId: userId, attemptId: id, status: "reconciliation_required", resolutionReason: "missing_exact_binding", revision: 0, resolveBy: attempt!.get("resolveBy"), createdAt: attempt!.get("acceptedAt"), payloadUntil: attempt!.get("payloadUntil") });
      if (item.outcome !== attempt!.get("outcome")) tx.update(attempt!.ref, { outcome: item.outcome });
      return item;
    });
  }
  async cases(userId: string, generation: number) {
    const user = await this.db.collection("users").doc(userId).get();
    assertExpectedAuthorizationGeneration(user.data() ?? { authorizationState: "deleted" }, generation);
    const rows = await this.db.collection("revenueCatTransactions").where("ownerAccountId", "==", userId).limit(101).get();
    return { items: rows.docs.slice(0, 100).map(doc => this.caseView(doc.id, doc.data())), truncated: rows.size > 100 };
  }
  caseView(key: string, data: Record<string, unknown>) {
    return { transactionKey: key, revision: Number(data.revision ?? 0), status: data.boundConfirmationId == null && data.status !== "closed_unresolved" && this.clock() >= ms(data.resolveBy) ? "expired_unresolved" : String(data.status), resolutionReason: typeof data.resolutionReason === "string" ? data.resolutionReason : null, confirmationId: typeof data.boundConfirmationId === "string" ? data.boundConfirmationId : null, receiptId: typeof data.receiptId === "string" ? data.receiptId : null };
  }
  async resolveCase(key: string, input: Readonly<{ operationId: string; expectedRevision: number; attemptId: string; action: "bind" | "close_unresolved"; evidenceReference: string; releaseLock: boolean; evidence?: Readonly<{ transactionId: string; initiatedAt: string; source: "original_operation_provider_verified" }> | undefined }>, actor: string) {
    const lockId = digest(logicalProduct(this.configured()));
    const ref = this.db.collection("revenueCatTransactions").doc(key), auditRef = ref.collection("resolutions").doc(input.operationId);
    const fingerprint = digest(JSON.stringify([input, actor]));
    await this.db.runTransaction(async tx => {
      const [fact, audit] = await tx.getAll(ref, auditRef);
      if (audit!.exists) { if (audit!.get("fingerprint") !== fingerprint) throw new Error("purchase_resolution_conflict"); return; }
      if (!fact!.exists || !isAccountId(fact!.get("ownerAccountId"))) throw new Error("purchase_case_not_found");
      const data = fact!.data()!;
      if (data.identityConflict === true) throw new Error("purchase_identity_resolution_unavailable");
      const userRef = this.db.collection("users").doc(String(data.ownerAccountId));
      const [user, attempt, lock, legacy] = await tx.getAll(userRef, userRef.collection("purchaseAttempts").doc(input.attemptId), userRef.collection("purchaseLocks").doc(lockId), userRef.collection("purchaseAttempts").doc("active"));
      if (!activeAccount(user!.data()) || !attempt!.exists || attempt!.get("ownerAccountId") !== data.ownerAccountId) throw new Error("purchase_case_not_found");
      if ((data.attemptId !== undefined && data.attemptId !== input.attemptId) || Number(data.revision) !== input.expectedRevision || data.boundConfirmationId != null || data.status === "closed_unresolved" || (data.compacted === true && input.action === "bind")) throw new Error("purchase_resolution_conflict");
      if (input.action === "bind") {
        // The authorized operator attests exact original-operation/provider evidence. A date/SKU guess is not evidence.
        if (!input.evidence || input.evidence.source !== "original_operation_provider_verified" || input.evidence.transactionId !== data.transactionId || Date.parse(input.evidence.initiatedAt) !== ms(attempt!.get("initiatedAt"))) throw new Error("purchase_evidence_required");
        if (this.clock() >= ms(attempt!.get("resolveBy")) || terminal.has(String(attempt!.get("outcome")))) throw new Error("purchase_attempt_expired");
        await this.resolveInTransaction(tx, key, { attemptId: input.attemptId, actor, evidenceReference: input.evidenceReference });
      } else {
        if (attempt!.get("boundTransactionKey") != null) throw new Error("purchase_resolution_conflict");
        tx.update(attempt!.ref, { outcome: "closed_unresolved", resolutionReason: "operator_close_unresolved" });
        tx.update(ref, { status: "closed_unresolved", resolutionReason: "operator_close_unresolved", revision: Number(data.revision) + 1, operatorResolution: this.clock() >= ms(attempt!.get("acceptedAt")) + PURCHASE_PAYLOAD_MS ? { operationId: input.operationId } : { actor, evidenceReference: input.evidenceReference, attemptId: input.attemptId } });
        if (input.releaseLock && lock!.get("attemptId") === input.attemptId) tx.delete(lock!.ref);
        if (input.releaseLock && legacy!.get("confirmationId") === input.attemptId) tx.update(legacy!.ref, { resolvedAt: Timestamp.fromMillis(this.clock()), outcome: "closed_unresolved" });
      }
      const payloadUntil = Timestamp.fromMillis(ms(attempt!.get("acceptedAt")) + PURCHASE_PAYLOAD_MS);
      tx.create(auditRef, this.clock() >= payloadUntil.toMillis() ? { fingerprint, action: input.action, createdAt: Timestamp.fromMillis(this.clock()), compacted: true } : { fingerprint, actor, ...input, createdAt: Timestamp.fromMillis(this.clock()), payloadUntil });
    });
    const fact = await ref.get();
    return this.caseView(key, fact.data()!);
  }
  async resolve(key: string): Promise<void> {
    await this.db.runTransaction(async tx => { await this.resolveInTransaction(tx, key); });
  }
  private async resolveInTransaction(tx: Transaction, key: string, manual?: Readonly<{ attemptId: string; actor: string; evidenceReference: string }>): Promise<void> {
    const now = this.clock();
    const ref = this.db.collection("revenueCatTransactions").doc(key), fact = await tx.get(ref);
    if (!fact.exists || fact.get("boundConfirmationId") != null || fact.get("status") === "closed_unresolved" || fact.get("compacted") === true) return;
    const data = fact.data()!, owner = data.ownerAccountId;
    if (typeof owner !== "string") return;
    const userRef = this.db.collection("users").doc(owner), user = await tx.get(userRef);
    if (!activeAccount(user.data())) return;
    const history = await tx.get(userRef.collection("purchaseAttempts"));
    const matches = history.docs.filter(doc => doc.id !== "active" && (manual ? doc.id === manual.attemptId : doc.get("candidateTransactionKey") === key));
    let reason = "missing_exact_binding";
    const attempt = matches.length === 1 ? matches[0]! : null;
    if (matches.length > 1) reason = "conflicting_attempt";
    else if (attempt) {
      const a = attempt.data();
      const binding = this.expectedBinding(data);
      const legacyAppleBinding = binding?.store === "APP_STORE" && data.mapVersion == null && a.mapVersion == null;
      const validScope = binding !== null && a.projectId === binding.projectId && a.appId === binding.appId && a.environment === binding.environment
        && (a.store ?? "APP_STORE") === binding.store && (legacyAppleBinding || (a.rcProductId ?? a.productId) === binding.rcProductId)
        && (a.storeProductId ?? a.productIdentifier) === binding.storeProductId && (a.basePlanId ?? null) === binding.basePlanId
        && (legacyAppleBinding || (data.rcProductId ?? data.productId) === binding.rcProductId) && (data.storeProductId ?? data.productIdentifier ?? data.productId) === binding.storeProductId
        && a.ownerAccountId === owner && transactionKey(binding, String(data.transactionId ?? "")) === key;
      if (!validScope || data.identityConflict === true || user.get("billingIdentityConflict") === true) reason = "identity_conflict";
      else if (a.candidateTransactionKey != null && a.candidateTransactionKey !== key) reason = "conflicting_attempt";
      else if (a.boundTransactionKey != null || terminal.has(String(a.outcome)) || now >= ms(a.resolveBy)) reason = "expired_unresolved";
      else if (!manual && history.docs.some(other => other.id !== attempt.id && other.id !== "active" && other.get("boundTransactionKey") == null && Number.isFinite(ms(other.get("initiatedAt"))) && ms(other.get("acceptedAt")) <= ms(a.acceptedAt) && (other.get("candidateTransactionKey") == null || other.get("candidateTransactionKey") === key))) reason = "conflicting_attempt";
      else if (!(ms(a.acceptedAt) <= ms(a.initiatedAt) && ms(a.initiatedAt) < ms(a.startExpiresAt) && ms(a.initiatedAt) <= Number(data.purchasedAtMs) && (manual || Number(data.purchasedAtMs) < ms(a.startExpiresAt)))) reason = "outside_confirmation_window";
      else {
        const confirmation = await tx.get(userRef.collection("purchaseConfirmations").doc(attempt.id));
        const receiptId = binding!.store === "APP_STORE" ? digest(String(data.transactionId)) : `play-${key}`; // Preserve Apple M10 namespace; namespace new Play receipts by store.
        const receiptRef = userRef.collection("purchaseReceipts").doc(receiptId), receipt = await tx.get(receiptRef);
        if (!confirmation.exists || confirmation.get("productIdentifier") !== data.productIdentifier || confirmation.get("immediateStartRequested") !== true) reason = "missing_confirmation_evidence";
        else if (receipt.exists && (receipt.get("confirmationId") !== attempt.id || receipt.get("transactionId") !== data.transactionId
          || receipt.get("userId") !== owner || receipt.get("transactionKey") !== key || (receipt.get("store") ?? "APP_STORE") !== binding!.store
          || (receipt.get("productIdentifier") !== data.productIdentifier))) reason = "legacy_receipt_conflict";
        else if (typeof user.get("contactEmail") !== "string" || user.get("contactEmailVerified") !== true) reason = "receipt_contact_required";
        else {
          if (!receipt.exists) tx.create(receiptRef, { userId: owner, receiptId, transactionKey: key, store: binding!.store, projectId: binding!.projectId, appId: binding!.appId, environment: binding!.environment, rcProductId: binding!.rcProductId, basePlanId: binding!.basePlanId, mapVersion: binding!.mapVersion, recipient: user.get("contactEmail"), transactionId: data.transactionId, confirmationId: attempt.id, productIdentifier: data.productIdentifier, storefrontPrice: confirmation.get("storefrontPrice"), locale: confirmation.get("locale"), termsVersion: confirmation.get("termsVersion"), immediateStartRequested: true, deliveryStatus: "ready", createdAt: Timestamp.fromMillis(now), updatedAt: Timestamp.fromMillis(now) });
          tx.update(attempt.ref, { boundTransactionKey: key, consumedAt: Timestamp.fromMillis(now), outcome: "bound", resolutionReason: null });
          tx.update(ref, { boundConfirmationId: attempt.id, receiptId, status: "bound", resolutionReason: null, revision: Number(data.revision ?? 0) + 1, ...(manual ? { operatorResolution: manual } : {}) });
          tx.delete(userRef.collection("purchaseLocks").doc(digest(logicalProduct(this.configured()))));
          return;
        }
      }
    }
    if (data.identityConflict === true || user.get("billingIdentityConflict") === true) reason = "identity_conflict";
    if (data.resolutionReason !== reason || data.status !== "reconciliation_required") tx.update(ref, { ...(attempt ? { attemptId: attempt.id, resolveBy: attempt.get("resolveBy") } : {}), status: attempt && now >= ms(attempt.get("resolveBy")) ? "expired_unresolved" : "reconciliation_required", resolutionReason: reason, revision: Number(data.revision ?? 0) + 1 });
    if (attempt && !terminal.has(String(attempt.get("outcome")))) tx.update(attempt.ref, { outcome: now >= ms(attempt.get("resolveBy")) ? "expired_unresolved" : "reconciliation_required", resolutionReason: reason });
  }
}
