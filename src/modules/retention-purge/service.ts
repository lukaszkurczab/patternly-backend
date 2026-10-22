import { FieldPath, Timestamp, type DocumentReference, type DocumentSnapshot, type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { COLLECTIONS, progressDocumentId } from "../../infrastructure/firestore/paths.js";
import { ADOPTION_TRANSFER_TTL_MS } from "../users/adoptionTransfer.js";
import { syncableRecordTypeSchema } from "../progress/contracts.js";

export type RetentionPurgeOptions = Readonly<{ execute?: boolean; pageSize?: number; maxDeletes?: number; now?: Date }>;
export type RetentionPurgeResult = Readonly<{
  dryRun: boolean; execute: boolean; complete: boolean;
  parents: Readonly<{ examined: number; eligible: number; attempted: number; confirmed: number }>;
  audits: Readonly<{ examined: number; orphanEligible: number; attempted: number; confirmed: number; ignored: number }>;
  purchases: Readonly<{ examined: number; eligible: number; attempted: number; confirmed: number }>;
  adoptions: Readonly<{ examined: number; eligible: number; claimed: number; recordsDeleted: number; confirmed: number }>;
  remainingDue: boolean; unresolved: number;
}>;
export type RetentionPurgeHooks = Readonly<{ afterPrimaryScan?: () => Promise<void> | void }>;

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1_000;
const DEFAULT_MAX_DELETES = 100;
const MAX_DELETES = 1_000;

/** Explicit bounded cleanup; active progress and immutable purchase evidence are retained. */
export class RetentionPurgeService {
  public constructor(private readonly db: Firestore, private readonly hooks: RetentionPurgeHooks = {}) {}

  public async run(options: RetentionPurgeOptions = {}): Promise<RetentionPurgeResult> {
    const execute = options.execute === true;
    const pageSize = normalizedPageSize(options.pageSize);
    const maxDeletes = normalizedMaxDeletes(options.maxDeletes);
    const nowMillis = (options.now ?? new Date()).getTime();
    const parents = { examined: 0, eligible: 0, attempted: 0, confirmed: 0 };
    const purchases = { examined: 0, eligible: 0, attempted: 0, confirmed: 0 };
    const audits = { examined: 0, orphanEligible: 0, attempted: 0, confirmed: 0, ignored: 0 };
    const adoptions = { examined: 0, eligible: 0, claimed: 0, recordsDeleted: 0, confirmed: 0 };
    let unresolved = 0;
    let deletesAttempted = 0;

    // Querying expiry would hide legacy documents where expiry is missing. The
    // document-id cursor is stable even as due parent documents are removed.
    let parentCursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.db.collection(COLLECTIONS.contentReports).orderBy(FieldPath.documentId()).limit(pageSize);
      if (parentCursor !== undefined) query = query.startAfter(parentCursor);
      const snapshot = await query.get();
      if (snapshot.empty) break;
      for (const document of snapshot.docs) {
        parents.examined += 1;
        const expiry = expiryMillis(document);
        if (expiry === null) { unresolved += 1; continue; }
        if (expiry > nowMillis) continue;
        parents.eligible += 1;
        if (!execute || deletesAttempted >= maxDeletes) continue;
        deletesAttempted += 1;
        parents.attempted += 1;
        await this.db.recursiveDelete(document.ref);
        if (!(await document.ref.get()).exists) parents.confirmed += 1;
        else unresolved += 1;
      }
      parentCursor = snapshot.docs.at(-1);
      if (snapshot.size < pageSize) break;
    }

    // Same deterministic, full scan for the shared audit collection group.
    let auditCursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.db.collectionGroup(COLLECTIONS.contentReportAudit).orderBy(FieldPath.documentId()).limit(pageSize);
      if (auditCursor !== undefined) query = query.startAfter(auditCursor);
      const snapshot = await query.get();
      if (snapshot.empty) break;
      for (const document of snapshot.docs) {
        const classification = classifyAuditPath(document.ref);
        if (classification === "protected") { audits.ignored += 1; continue; }
        if (classification !== "content_report") { unresolved += 1; continue; }
        audits.examined += 1;
        const expiry = expiryMillis(document);
        if (expiry === null) { unresolved += 1; continue; }
        if (expiry > nowMillis) continue;
        const parent = document.ref.parent.parent;
        if (parent === null) { unresolved += 1; continue; }
        if ((await parent.get()).exists) continue; // parent purge / TTL owns this child.
        audits.orphanEligible += 1;
        if (!execute || deletesAttempted >= maxDeletes) continue;
        const deleted = await this.deleteExactOrphanInTransaction(document.ref, nowMillis);
        if (!deleted) continue;
        deletesAttempted += 1;
        audits.attempted += 1;
        if (!(await document.ref.get()).exists) audits.confirmed += 1;
        else unresolved += 1;
      }
      auditCursor = snapshot.docs.at(-1);
      if (snapshot.size < pageSize) break;
    }

    // Billing payload compaction never releases a purchase lock or deletes immutable consent/receipt evidence.
    for (const collection of ["purchaseAttempts", "revenueCatTransactions", "revenueCatEvents", "resolutions"]) {
      let cursor: QueryDocumentSnapshot | undefined;
      for (;;) {
        let query = this.db.collectionGroup(collection).orderBy(FieldPath.documentId()).limit(pageSize);
        if (cursor) query = query.startAfter(cursor);
        const rows = await query.get();
        for (const row of rows.docs) {
          const until = row.get("payloadUntil");
          const resolveBy = row.get("resolveBy");
          const expire = ["purchaseAttempts", "revenueCatTransactions"].includes(collection) && resolveBy instanceof Timestamp && resolveBy.toMillis() <= nowMillis && !["bound", "cancelled", "closed_unresolved", "expired_unresolved"].includes(String(row.get(collection === "purchaseAttempts" ? "outcome" : "status")));
          const compact = until instanceof Timestamp && until.toMillis() <= nowMillis && row.get("compacted") !== true;
          if (!expire && !compact) continue;
          purchases.examined += 1; purchases.eligible += 1;
          if (!execute || deletesAttempted >= maxDeletes) continue;
          deletesAttempted += 1; purchases.attempted += 1;
          await this.db.runTransaction(async tx => {
            const fresh = await tx.get(row.ref);
            if (!fresh.exists) return;
            const data = fresh.data()!;
            const freshExpire = ["purchaseAttempts", "revenueCatTransactions"].includes(collection) && data.resolveBy instanceof Timestamp && data.resolveBy.toMillis() <= nowMillis && !["bound", "cancelled", "closed_unresolved", "expired_unresolved"].includes(String(data[collection === "purchaseAttempts" ? "outcome" : "status"]));
            const freshCompact = data.payloadUntil instanceof Timestamp && data.payloadUntil.toMillis() <= nowMillis && data.compacted !== true;
            if (freshExpire) data[collection === "purchaseAttempts" ? "outcome" : "status"] = "expired_unresolved";
            if (freshCompact) {
              const keep = collection === "purchaseAttempts" ? ["ownerAccountId", "confirmationId", "acceptedAt", "startExpiresAt", "initiatedAt", "resolveBy", "outcome", "resolutionReason", "boundTransactionKey", "candidateTransactionKey"] : collection === "revenueCatTransactions" ? ["ownerAccountId", "attemptId", "resolveBy", "projectId", "appId", "store", "environment", "productId", "purchasedAtMs", "boundConfirmationId", "receiptId", "identityConflict", "status", "resolutionReason", "revision", "createdAt"] : collection === "revenueCatEvents" ? ["eventId", "fingerprint", "outcome", "resolutionReason", "createdAt"] : ["fingerprint", "action", "createdAt"];
              tx.set(row.ref, { ...Object.fromEntries(keep.filter(key => data[key] !== undefined).map(key => [key, data[key]])), compacted: true });
            } else if (freshExpire) tx.update(row.ref, { [collection === "purchaseAttempts" ? "outcome" : "status"]: "expired_unresolved" });
          });
          purchases.confirmed += 1;
        }
        cursor = rows.docs.at(-1);
        if (rows.size < pageSize) break;
      }
    }
    // Full document-ID scan avoids starving expired suffixes behind active/fresh parents.
    let generationCursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.db.collectionGroup("progressGenerations").orderBy(FieldPath.documentId()).limit(pageSize);
      if (generationCursor) query = query.startAfter(generationCursor);
      const rows = await query.get();
      for (const row of rows.docs) {
        adoptions.examined += 1;
        const metadata = generationMetadataRef(this.db, row.ref);
        const inspection = inspectGeneration(row, metadata ? await metadata.get() : undefined, nowMillis);
        if (inspection.kind === "unresolved") { unresolved += 1; continue; }
        if (inspection.kind !== "due") continue;
        adoptions.eligible += 1;
        if (!execute) continue;
        while (deletesAttempted < maxDeletes) {
          const result = await this.purgeGenerationPage(row.ref, inspection.identity, nowMillis, Math.min(pageSize, maxDeletes - deletesAttempted, 200));
          deletesAttempted += result.actions;
          adoptions.claimed += result.claimed;
          adoptions.recordsDeleted += result.records;
          adoptions.confirmed += result.deleted;
          if (result.unresolved) unresolved += 1;
          if (result.actions === 0 || result.deleted > 0 || result.unresolved) break;
        }
      }
      generationCursor = rows.docs.at(-1);
      if (rows.size < pageSize) break;
    }
    await this.hooks.afterPrimaryScan?.();
    const postcheck = await this.observeDueAtCutoff(nowMillis, pageSize);
    let duePurchase = false;
    for (const collection of ["purchaseAttempts", "revenueCatTransactions", "revenueCatEvents", "resolutions"]) {
      let cursor: QueryDocumentSnapshot | undefined;
      for (;;) {
        let query = this.db.collectionGroup(collection).orderBy(FieldPath.documentId()).limit(pageSize);
        if (cursor) query = query.startAfter(cursor);
        const rows = await query.get();
        duePurchase ||= rows.docs.some(row => {
          const until = row.get("payloadUntil"), resolveBy = row.get("resolveBy");
          const status = row.get(collection === "purchaseAttempts" ? "outcome" : "status");
          return (until instanceof Timestamp && until.toMillis() <= nowMillis && row.get("compacted") !== true) || (["purchaseAttempts", "revenueCatTransactions"].includes(collection) && resolveBy instanceof Timestamp && resolveBy.toMillis() <= nowMillis && !["bound", "cancelled", "closed_unresolved", "expired_unresolved"].includes(String(status)));
        });
        cursor = rows.docs.at(-1);
        if (rows.size < pageSize) break;
      }
    }
    const eligible = parents.eligible + audits.orphanEligible + purchases.eligible;
    const adoptionPostcheck = await this.observeAdoptionDue(nowMillis, pageSize);
    if (adoptionPostcheck.unresolved && unresolved === 0) unresolved += 1;
    const remainingDue = (!execute ? eligible > 0 : deletesAttempted < eligible) || postcheck.dueParent || postcheck.dueOrphan || duePurchase || adoptionPostcheck.due;
    return Object.freeze({ dryRun: !execute, execute, complete: !remainingDue && unresolved === 0, parents: Object.freeze(parents), audits: Object.freeze(audits), purchases: Object.freeze(purchases), adoptions: Object.freeze(adoptions), remainingDue, unresolved });
  }

  private async purgeGenerationPage(reference: DocumentReference, identity: GenerationIdentity, cutoff: number, budget: number): Promise<GenerationPageResult> {
    const none = { actions: 0, claimed: 0, records: 0, deleted: 0, unresolved: false };
    // Known writers only use records. Never delete a parent over unknown children.
    const collections = await reference.listCollections();
    if (collections.some(collection => collection.id !== "records")) return { ...none, unresolved: true };
    return this.db.runTransaction(async transaction => {
      const metadataRef = generationMetadataRef(this.db, reference);
      if (!metadataRef) return { ...none, unresolved: true };
      const [parent, metadata] = await transaction.getAll(reference, metadataRef);
      if (!parent?.exists) return none; // Another cleaner already completed this exact parent.
      const inspection = inspectGeneration(parent, metadata, cutoff);
      if (inspection.kind === "unresolved") return { ...none, unresolved: true };
      if (inspection.kind !== "due") return none;
      if (!sameGenerationIdentity(identity, inspection.identity)) return { ...none, unresolved: true };
      if (parent.get("state") === "building") {
        transaction.update(reference, { state: "purging" });
        return { ...none, actions: 1, claimed: 1 };
      }
      const children = await transaction.get(reference.collection("records").orderBy(FieldPath.documentId()).limit(budget));
      if (children.empty) {
        // A collection surviving an empty direct query may contain descendants
        // under missing record documents. Preserve their only cleanup fence.
        if (collections.some(collection => collection.id === "records")) return { ...none, unresolved: true };
        transaction.delete(reference);
        return { ...none, actions: 1, deleted: 1 };
      }
      // A single unproven child preserves the page and retained fence for inspection.
      if (children.docs.some(child => !ownedGenerationRecord(child, identity))) return { ...none, unresolved: true };
      if ((await Promise.all(children.docs.map(child => child.ref.listCollections()))).some(collections => collections.length > 0)) return { ...none, unresolved: true };
      for (const child of children.docs) transaction.delete(child.ref);
      return { ...none, actions: children.size, records: children.size };
    });
  }

  private async observeAdoptionDue(cutoff: number, pageSize: number): Promise<Readonly<{ due: boolean; unresolved: boolean }>> {
    let cursor: QueryDocumentSnapshot | undefined;
    let due = false;
    let unresolved = false;
    for (;;) {
      let query = this.db.collectionGroup("progressGenerations").orderBy(FieldPath.documentId()).limit(pageSize);
      if (cursor) query = query.startAfter(cursor);
      const rows = await query.get();
      for (const row of rows.docs) {
        const metadata = generationMetadataRef(this.db, row.ref);
        const inspection = inspectGeneration(row, metadata ? await metadata.get() : undefined, cutoff);
        due ||= inspection.kind === "due" || inspection.kind === "held";
        unresolved ||= inspection.kind === "unresolved";
      }
      cursor = rows.docs.at(-1);
      if (rows.size < pageSize) break;
    }
    return { due, unresolved };
  }

  private async deleteExactOrphanInTransaction(reference: DocumentReference, nowMillis: number): Promise<boolean> {
    return this.db.runTransaction(async (transaction) => {
      // Re-read every mutable precondition inside one transaction. A newly
      // created parent invalidates the transaction and prevents direct delete.
      const audit = await transaction.get(reference);
      const expiry = audit.exists ? expiryMillis(audit) : null;
      if (!audit.exists || classifyAuditPath(reference) !== "content_report" || expiry === null || expiry > nowMillis) return false;
      const parent = reference.parent.parent;
      if (parent === null) return false;
      if ((await transaction.get(parent)).exists) return false;
      transaction.delete(reference);
      return true;
    });
  }

  private async observeDueAtCutoff(nowMillis: number, pageSize: number): Promise<Readonly<{ dueParent: boolean; dueOrphan: boolean }>> {
    const cutoff = Timestamp.fromMillis(nowMillis);
    let parentCursor: QueryDocumentSnapshot | undefined;
    let dueParent = false;
    for (;;) {
      let query = this.db.collection(COLLECTIONS.contentReports).where("expiresAt", "<=", cutoff).orderBy("expiresAt").limit(pageSize);
      if (parentCursor !== undefined) query = query.startAfter(parentCursor);
      const snapshot = await query.get();
      if (snapshot.empty) break;
      dueParent = true;
      parentCursor = snapshot.docs.at(-1);
      if (snapshot.size < pageSize) break;
    }

    let auditCursor: QueryDocumentSnapshot | undefined;
    let dueOrphan = false;
    for (;;) {
      let query = this.db.collectionGroup(COLLECTIONS.contentReportAudit).orderBy(FieldPath.documentId()).limit(pageSize);
      if (auditCursor !== undefined) query = query.startAfter(auditCursor);
      const snapshot = await query.get();
      if (snapshot.empty) break;
      for (const audit of snapshot.docs) {
        if (classifyAuditPath(audit.ref) !== "content_report") continue;
        const expiry = expiryMillis(audit);
        if (expiry === null || expiry > nowMillis) continue;
        const parent = audit.ref.parent.parent;
        if (parent !== null && !(await parent.get()).exists) dueOrphan = true;
      }
      auditCursor = snapshot.docs.at(-1);
      if (snapshot.size < pageSize) break;
    }
    return Object.freeze({ dueParent, dueOrphan });
  }
}

function normalizedPageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) throw new Error("retention_purge_page_size_invalid");
  return value;
}

function normalizedMaxDeletes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_DELETES;
  if (!Number.isInteger(value) || value < 1 || value > MAX_DELETES) throw new Error("retention_purge_max_deletes_invalid");
  return value;
}

function expiryMillis(document: DocumentSnapshot): number | null {
  const value = document.get("expiresAt");
  return value instanceof Timestamp && Number.isFinite(value.toMillis()) ? value.toMillis() : null;
}

function classifyAuditPath(reference: DocumentReference): "content_report" | "protected" | "unknown" {
  const segments = reference.path.split("/");
  if (segments.length === 4 && segments[0] === COLLECTIONS.contentReports && segments[2] === COLLECTIONS.contentReportAudit) return "content_report";
  if (segments.length === 4 && (segments[0] === COLLECTIONS.privacyRequests || segments[0] === COLLECTIONS.securityIncidents) && segments[2] === COLLECTIONS.contentReportAudit) return "protected";
  return "unknown";
}

type GenerationIdentity = Readonly<{ userId: string; generation: number; sourceSessionId: string; createdAt: number; expiresAt: number }>;
type GenerationPageResult = Readonly<{ actions: number; claimed: number; records: number; deleted: number; unresolved: boolean }>;
type GenerationInspection = Readonly<{ kind: "skip" | "held" | "unresolved" }> | Readonly<{ kind: "due"; identity: GenerationIdentity }>;

function generationMetadataRef(db: Firestore, reference: DocumentReference): DocumentReference | null {
  const parts = reference.path.split("/");
  if (parts.length !== 4 || parts[0] !== COLLECTIONS.users || parts[2] !== "progressGenerations") return null;
  return db.collection(COLLECTIONS.users).doc(parts[1]!).collection("syncMetadata").doc("account");
}

function inspectGeneration(parent: DocumentSnapshot, metadata: DocumentSnapshot | undefined, cutoff: number): GenerationInspection {
  const parts = parent.ref.path.split("/");
  const data = parent.data();
  const account = metadata?.data();
  if (!parent.exists || parts.length !== 4 || parts[0] !== COLLECTIONS.users || parts[2] !== "progressGenerations"
    || !/^[1-9]\d*$/u.test(parts[3]!) || !data || data.userId !== parts[1] || data.generation !== Number(parts[3])
    || !Number.isSafeInteger(data.generation) || typeof data.sourceSessionId !== "string" || data.sourceSessionId.length < 1 || data.sourceSessionId.length > 128
    || !(data.createdAt instanceof Timestamp) || !metadata?.exists || !account) return { kind: "unresolved" };
  // Missing fields mean zero only in an existing metadata document with a proven allocation counter.
  const active = account.generation === undefined ? 0 : account.generation;
  if (!Number.isSafeInteger(active) || active < 0 || (account.activeGeneration !== undefined && account.activeGeneration !== active)
    || !Number.isSafeInteger(account.adoptionGenerationCounter) || account.adoptionGenerationCounter < Math.max(active, data.generation)
    || (account.accountRevision !== undefined && (!Number.isSafeInteger(account.accountRevision) || account.accountRevision < 0))) return { kind: "unresolved" };
  if (active === data.generation || data.state === "active") return { kind: "skip" };
  if (data.state !== "building" && data.state !== "purging") return { kind: "unresolved" };
  if (!(data.expiresAt instanceof Timestamp) || data.expiresAt.toMillis() !== data.createdAt.toMillis() + ADOPTION_TRANSFER_TTL_MS) return { kind: "unresolved" };
  if (data.expiresAt.toMillis() > cutoff) return { kind: "skip" };
  const leaseFields = ["adoptionPromotionSessionId", "adoptionPromotionTargetGeneration", "adoptionPromotionSourceGeneration", "adoptionPromotionSourceRevision", "adoptionPromotionLeaseExpiresAt"];
  if (leaseFields.some(field => account[field] !== undefined)) {
    if (typeof account.adoptionPromotionSessionId !== "string" || account.adoptionPromotionSessionId.length === 0
      || !Number.isSafeInteger(account.adoptionPromotionTargetGeneration) || account.adoptionPromotionTargetGeneration <= 0
      || !Number.isSafeInteger(account.adoptionPromotionSourceGeneration) || account.adoptionPromotionSourceGeneration < 0
      || !Number.isSafeInteger(account.adoptionPromotionSourceRevision) || account.adoptionPromotionSourceRevision < 0
      || !(account.adoptionPromotionLeaseExpiresAt instanceof Timestamp)) return { kind: "unresolved" };
    if (account.adoptionPromotionTargetGeneration === data.generation) {
      if (account.adoptionPromotionSessionId !== data.sourceSessionId) return { kind: "unresolved" };
      if (account.adoptionPromotionLeaseExpiresAt.toMillis() > cutoff) return { kind: "held" };
    }
  }
  return { kind: "due", identity: { userId: data.userId, generation: data.generation, sourceSessionId: data.sourceSessionId, createdAt: data.createdAt.toMillis(), expiresAt: data.expiresAt.toMillis() } };
}

function sameGenerationIdentity(left: GenerationIdentity, right: GenerationIdentity): boolean {
  return left.userId === right.userId && left.generation === right.generation && left.sourceSessionId === right.sourceSessionId && left.createdAt === right.createdAt && left.expiresAt === right.expiresAt;
}

function ownedGenerationRecord(record: QueryDocumentSnapshot, identity: GenerationIdentity): boolean {
  const row = record.data();
  const type = syncableRecordTypeSchema.safeParse(row.recordType);
  if (row.generation !== identity.generation || row.sourceSessionId !== identity.sourceSessionId || (row.kind !== "node" && row.kind !== "item")
    || !type.success || typeof row.trackId !== "string" || row.trackId.length === 0 || typeof row.targetId !== "string" || row.targetId.length === 0) return false;
  return record.id === progressDocumentId({ kind: row.kind, recordType: type.data, trackId: row.trackId, targetId: row.targetId });
}
