import { validateReviewDate } from "../retention/review.js";
import { readOperatorPage, type OperatorPageOptions } from "../retention/operatorPage.js";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { FieldValue, Timestamp, type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { asRecord, asTimestamp } from "../../infrastructure/firestore/values.js";
import { COLLECTIONS } from "../../infrastructure/firestore/paths.js";
import { assertExpectedAuthorizationGeneration } from "../auth/authorizationGeneration.js";
import { addUtcCalendarMonths } from "../../infrastructure/time/utcCalendar.js";
import { RETENTION_POLICY } from "../retention/policy.js";
import { legalEvidenceFields, LEGAL_REQUEST_STATUSES, complaintResponseDueAt, legalRequestKindSchema, retentionUntilFromClosure, type LegalRequestAdminAction, type LegalRequestKind, type LegalRequestStatus } from "./contracts.js";

export type LegalRequestItem = Readonly<{
  requestId: string;
  kind: LegalRequestKind;
  status: LegalRequestStatus;
  receivedAt: string;
  responseDueAt: string | null;
  answeredAt: string | null;
  retentionUntil: string | null;
  response: string | null;
  legalHold: boolean;
  legalHoldReviewBy: string | null;
  nextReviewAt?: string | null;
  reviewReason?: string | null;
  revision: number;
}>;
export type LegalRequestDetails = LegalRequestItem & Readonly<{ email: string | null; narrative: string | null; transactionId: string | null }>;
export type OperatorLegalRequestItem = Readonly<{
  requestId: string;
  kind: LegalRequestKind;
  status: LegalRequestStatus;
  receivedAt: string;
  responseDueAt: string | null;
  answeredAt: string | null;
  retentionUntil: string | null;
  legalHold: boolean;
  legalHoldReviewBy: string | null;
  nextReviewAt?: string | null;
  reviewReason?: string | null;
  revision: number;
}>;
export type LegalRequestOperatorQueue = Readonly<{ items: readonly OperatorLegalRequestItem[]; truncated: boolean; nextCursor: string | null }>;

export interface LegalRequestEmailSender {
  send(input: Readonly<{ recipient: string; purpose: "received" | "answered"; requestId: string; kind: LegalRequestKind; response?: string }>): Promise<void>;
}

/** Definite refusal of the active received notice, never inferred from ambiguous delivery. */
export class LegalRequestConfirmationRejectedError extends Error {
  constructor() { super("legal_request_confirmation_rejected"); }
}

type LegalRequestCreateInput = Readonly<{
  email: string;
  kind: LegalRequestKind;
  narrative?: string;
  transactionId?: string;
}> & (Readonly<{ userId: string; expectedAuthorizationGeneration: number }> | Readonly<{ userId: null; expectedAuthorizationGeneration?: never }>);

export interface LegalRequestStore {
  create(input: LegalRequestCreateInput, sender: LegalRequestEmailSender): Promise<LegalRequestItem>;
  listAccount(userId: string): Promise<readonly LegalRequestItem[]>;
  readAccount(userId: string, requestId: string): Promise<LegalRequestItem | null>;
  listAdmin(): Promise<readonly LegalRequestItem[]>;
  listOperatorQueue(actorId: string, options?: OperatorPageOptions): Promise<LegalRequestOperatorQueue>;
  readAdmin(requestId: string, actorId: string): Promise<LegalRequestDetails | null>;
  transitionAdmin(requestId: string, actorId: string, action: LegalRequestAdminAction, sender: LegalRequestEmailSender | null): Promise<LegalRequestItem>;
}

export class FirestoreLegalRequestStore implements LegalRequestStore {
  public constructor(private readonly db: Firestore, private readonly auditHmacSecret: string) {
    if (Buffer.byteLength(auditHmacSecret, "utf8") < 32) throw new Error("legal_request_audit_hmac_secret_invalid");
  }

  public async create(input: LegalRequestCreateInput, sender: LegalRequestEmailSender): Promise<LegalRequestItem> {
    const receivedAt = new Date();
    const requestId = `lr_${randomUUID()}`;
    const email = input.email.trim().toLowerCase();
    const responseDueAt = complaintResponseDueAt(receivedAt, input.kind);
    const record = {
      requestId, userId: input.userId, subjectKey: createHash("sha256").update(email).digest("hex"), email,
      kind: input.kind, narrative: input.narrative ?? null, transactionId: input.transactionId ?? null,
      status: "received", response: null, receivedAt: Timestamp.fromDate(receivedAt),
      responseDueAt: responseDueAt ? Timestamp.fromDate(responseDueAt) : null, answeredAt: null, closedAt: null,
      retentionUntil: null, expiresAt: null, legalHold: false, legalHoldReason: null,
      confirmationStatus: "pending", revision: 0, createdAt: Timestamp.fromDate(receivedAt), updatedAt: Timestamp.fromDate(receivedAt),
    };
    const requestRef = this.db.collection("legalRequests").doc(requestId);
    if (input.userId === null) {
      await this.claimPublicRateLimit(email, receivedAt);
      await requestRef.create(record);
    } else {
      await this.db.runTransaction(async (transaction) => {
        const user = await transaction.get(this.db.collection(COLLECTIONS.users).doc(input.userId));
        if (!user.exists) throw new Error("account_deleted");
        assertExpectedAuthorizationGeneration(asRecord(user.data(), "user"), input.expectedAuthorizationGeneration);
        transaction.create(requestRef, record);
      });
    }
    let outcome: "sent" | "failed" | "unknown" = "sent";
    try {
      await sender.send({ recipient: email, purpose: "received", requestId, kind: input.kind });
    } catch (error) {
      outcome = error instanceof LegalRequestConfirmationRejectedError ? "failed" : "unknown";
    }
    let confirmedSent = false;
    try {
      confirmedSent = await this.finalizeReceivedConfirmation(record, outcome);
    } catch {
      // An unconfirmed commit may already have recorded sent. One fresh fenced
      // readback preserves it, or marks a still-pending delivery uncertain.
      try { confirmedSent = await this.finalizeReceivedConfirmation(record, "unknown"); } catch { /* Remain unavailable when persistence cannot be confirmed. */ }
    }
    if (!confirmedSent) throw new Error("legal_request_email_unavailable");
    return this.read(requestId, record);
  }

  private async finalizeReceivedConfirmation(
    identity: Readonly<{ requestId: string; userId: string | null; email: string; kind: LegalRequestKind; createdAt: Timestamp; receivedAt: Timestamp }>,
    outcome: "sent" | "failed" | "unknown",
  ): Promise<boolean> {
    const ref = this.db.collection("legalRequests").doc(identity.requestId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return false;
      const current = snapshot.data()!;
      if (current.requestId !== identity.requestId || current.userId !== identity.userId
        || current.email !== identity.email || current.kind !== identity.kind
        || !(current.createdAt instanceof Timestamp) || !current.createdAt.isEqual(identity.createdAt)
        || !(current.receivedAt instanceof Timestamp) || !current.receivedAt.isEqual(identity.receivedAt)) return false;
      if (current.confirmationStatus === "sent") return current.confirmationSentAt instanceof Timestamp;
      if (current.confirmationStatus !== "pending" || current.confirmationSentAt !== undefined) return false;
      transaction.update(ref, {
        confirmationStatus: outcome,
        ...(outcome === "sent" ? { confirmationSentAt: FieldValue.serverTimestamp() } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return outcome === "sent";
    });
  }

  public async listAccount(userId: string): Promise<readonly LegalRequestItem[]> {
    const selected: QueryDocumentSnapshot[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.db.collection("legalRequests").where("userId", "==", userId).orderBy("receivedAt", "desc").limit(100);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const document of page.docs) if (this.isUnexpired(asRecord(document.data(), "legal_request"))) selected.push(document);
      if (selected.length >= 100 || page.empty || page.size < 100) break;
      cursor = page.docs.at(-1);
    }
    return Object.freeze(selected.slice(0, 100).map((document) => this.read(document.id, asRecord(document.data(), "legal_request"))));
  }

  public async readAccount(userId: string, requestId: string): Promise<LegalRequestItem | null> {
    const snapshot = await this.db.collection("legalRequests").doc(requestId).get();
    if (!snapshot.exists || snapshot.get("userId") !== userId || !this.isUnexpired(asRecord(snapshot.data(), "legal_request"))) return null;
    return this.read(requestId, asRecord(snapshot.data(), "legal_request"));
  }

  public async listAdmin(): Promise<readonly LegalRequestItem[]> {
    const selected: QueryDocumentSnapshot[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.db.collection("legalRequests").orderBy("receivedAt", "desc").limit(100);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const document of page.docs) if (this.isUnexpired(asRecord(document.data(), "legal_request"))) selected.push(document);
      if (selected.length >= 100 || page.empty || page.size < 100) break;
      cursor = page.docs.at(-1);
    }
    return Object.freeze(selected.slice(0, 100).map((document) => this.read(document.id, asRecord(document.data(), "legal_request"))));
  }

  public async listOperatorQueue(actorId: string, options?: OperatorPageOptions): Promise<LegalRequestOperatorQueue> {
    const page = await readOperatorPage(this.db.collection("legalRequests"), (data) => this.isUnexpired(data) && (!options?.dueOnly || this.reviewAt(data) !== null && Date.parse(this.reviewAt(data)!) <= Date.now()), options);
    const selected = page.documents;
    const truncated = page.truncated;
    const items = Object.freeze(selected.map((document) => this.toOperatorItem(document.id, asRecord(document.data(), "legal_request"))));
    if (selected.length > 0) {
      const occurredAt = Timestamp.now();
      await this.db.runTransaction(async (transaction) => {
        const fresh = await transaction.getAll(...selected.map((document) => document.ref));
        for (const document of fresh) this.assertEnums(asRecord(document.data(), "legal_request"));
        for (let index = 0; index < selected.length; index += 1) {
          const document = selected[index]!;
          const data = asRecord(fresh[index]?.data(), "legal_request");
          transaction.create(document.ref.collection("audit").doc(), {
            action: "operator_queue_read",
            actorPseudonym: this.actorPseudonym(actorId),
            occurredAt,
            expiresAt: data.expiresAt ?? null,
          });
        }
      });
    }
    return Object.freeze({
      items,
      truncated,
      nextCursor: page.nextCursor,
    });
  }

  public async readAdmin(requestId: string, actorId: string): Promise<LegalRequestDetails | null> {
    const ref = this.db.collection("legalRequests").doc(requestId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return null;
    const data = asRecord(snapshot.data(), "legal_request");
    if (!this.isUnexpired(data)) return null;
    this.assertEnums(data);
    const occurredAt = new Date();
    await this.db.runTransaction(async (transaction) => {
      const fresh = await transaction.get(ref);
      if (!fresh.exists) throw new Error("legal_request_not_found");
      const freshData = asRecord(fresh.data(), "legal_request");
      this.assertEnums(freshData);
      transaction.create(ref.collection("audit").doc(), { action: "details_read", actorPseudonym: this.actorPseudonym(actorId), occurredAt: Timestamp.fromDate(occurredAt), expiresAt: freshData.expiresAt ?? null });
    });
    return Object.freeze({ ...this.read(requestId, data), email: typeof data.email === "string" ? data.email : null, narrative: typeof data.narrative === "string" ? data.narrative : null, transactionId: typeof data.transactionId === "string" ? data.transactionId : null });
  }

  public async transitionAdmin(requestId: string, actorId: string, action: LegalRequestAdminAction, sender: LegalRequestEmailSender | null): Promise<LegalRequestItem> {
    if (action.action === "answer" && sender === null) throw new Error("legal_request_email_unavailable");
    const ref = this.db.collection("legalRequests").doc(requestId);
    let recipient = "";
    let kind: LegalRequestKind = "complaint";
    let response: string | undefined;
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("legal_request_not_found");
      const data = asRecord(snapshot.data(), "legal_request");
      this.assertEnums(data);
      if (Number(data.revision) !== action.expectedRevision) throw new Error("legal_request_revision_conflict");
      const status = data.status;
      const now = new Date();
      const actorPseudonym = this.actorPseudonym(actorId);
      const update: Record<string, unknown> = { revision: action.expectedRevision + 1, updatedAt: Timestamp.fromDate(now), lastActorPseudonym: actorPseudonym };
      if (action.action === "start_review") {
        if (status !== "received") throw new Error("legal_request_transition_invalid");
        update.status = "in_review";
      } else if (action.action === "answer") {
        if (status !== "received" && status !== "in_review") throw new Error("legal_request_transition_invalid");
        update.pendingResponse = action.response; update.answerDeliveryStatus = "pending";
        recipient = String(data.email); kind = data.kind; response = action.response;
      } else if (action.action === "close") {
        if (status !== "answered") throw new Error("legal_request_transition_invalid");
        const disposition = action.disposition;
        if (disposition.kind === "minimal_archive" && data.kind !== "data_recovery" && data.kind !== "suspension_appeal") throw new Error("legal_request_claim_disposition_required");
        if (data.legalHold === true) {
          const heldFields = Array.isArray(data.necessaryFields) ? data.necessaryFields : legalEvidenceFields.filter((field) => typeof data[field] === "string");
          if (disposition.kind !== "claim" || heldFields.some((field) => !disposition.necessaryFields.includes(field))) throw new Error("legal_request_held_evidence_required");
        }
        const retentionUntil = disposition.kind === "claim" ? new Date(disposition.retentionUntil) : retentionUntilFromClosure(now, RETENTION_POLICY.legalRequestMinimalArchiveMonths);
        if (retentionUntil <= now) throw new Error("legal_request_retention_date_invalid");
        update.status = "closed"; update.closedAt = Timestamp.fromDate(now); update.retentionUntil = Timestamp.fromDate(retentionUntil);
        update.retentionKind = disposition.kind;
        update.retentionReason = disposition.reason;
        update.retentionBasis = disposition.kind === "claim" ? disposition.basis : null;
        if (disposition.kind === "claim") {
          update.necessaryFields = disposition.necessaryFields;
          update.nextReviewAt = Timestamp.fromDate(addUtcCalendarMonths(now, RETENTION_POLICY.legalClaimReviewMonths));
          for (const field of legalEvidenceFields) if (!disposition.necessaryFields.includes(field)) update[field] = FieldValue.delete();
          if (!disposition.necessaryFields.includes("email")) update.subjectKey = FieldValue.delete();
        }
        if (disposition.kind === "minimal_archive") {
          update.subjectKey = FieldValue.delete(); update.email = FieldValue.delete(); update.narrative = FieldValue.delete(); update.transactionId = FieldValue.delete(); update.response = FieldValue.delete();
        }
        if (data.legalHold !== true) update.expiresAt = Timestamp.fromDate(retentionUntil);
      } else if (action.action === "review_retention") {
        if (status !== "closed") throw new Error("legal_request_review_unavailable");
        const nextReviewAt = validateReviewDate(action.nextReviewAt, now, RETENTION_POLICY.legalClaimReviewMonths);
        const retentionUntil = new Date(action.retentionUntil);
        if (retentionUntil <= now) throw new Error("legal_request_retention_date_invalid");
        if (action.dispute === "resolved_executed") {
          if (!data.legalHold || !action.finalResolutionAt || !action.executedAt) throw new Error("legal_request_dispute_resolution_required");
          const finalAt = new Date(action.finalResolutionAt); const executedAt = new Date(action.executedAt);
          if (finalAt > now || executedAt > now || executedAt < finalAt) throw new Error("legal_request_dispute_resolution_invalid");
          Object.assign(update, { legalHold: false, legalHoldReviewBy: null, disputeActive: false, disputeFinalAt: Timestamp.fromDate(finalAt), disputeExecutedAt: Timestamp.fromDate(executedAt) });
        }
        const held = action.dispute === "ongoing" || (data.legalHold === true || data.disputeActive === true) && action.dispute !== "resolved_executed";
        if (held) {
          const existingFields = Array.isArray(data.necessaryFields) ? data.necessaryFields : legalEvidenceFields.filter((field) => typeof data[field] === "string");
          if (existingFields.some((field) => !action.necessaryFields.includes(field))) throw new Error("legal_request_held_evidence_required");
          Object.assign(update, { legalHold: true, legalHoldReviewBy: nextReviewAt, ...(action.dispute === "ongoing" ? { disputeActive: true } : {}) });
        }
        for (const field of legalEvidenceFields) if (!action.necessaryFields.includes(field)) update[field] = FieldValue.delete();
        if (!action.necessaryFields.includes("email")) update.subjectKey = FieldValue.delete();
        Object.assign(update, { necessaryFields: action.necessaryFields, retentionKind: "claim", retentionUntil: Timestamp.fromDate(retentionUntil), retentionBasis: action.basis, retentionReason: action.reason, reviewReason: action.reason, retentionReviewedAt: Timestamp.fromDate(now), nextReviewAt, expiresAt: held ? null : Timestamp.fromDate(retentionUntil) });
      } else {
        if (!action.active && data.disputeActive === true) throw new Error("legal_request_dispute_resolution_required");
        update.legalHold = action.active; update.legalHoldReason = action.reason;
        if (action.active) {
          if (!action.reviewBy) throw new Error("legal_request_hold_review_invalid");
          const reviewBy = new Date(action.reviewBy);
          if (!Number.isFinite(reviewBy.getTime()) || reviewBy <= now || reviewBy > addUtcCalendarMonths(now, RETENTION_POLICY.disputeReviewMonths)) throw new Error("legal_request_hold_review_invalid");
          update.legalHoldReviewBy = Timestamp.fromDate(reviewBy);
        } else update.legalHoldReviewBy = null;
        update.expiresAt = action.active ? null : (data.retentionUntil ?? null);
      }
      transaction.set(ref, update, { merge: true });
      transaction.create(ref.collection("audit").doc(), { action: action.action, actorPseudonym, occurredAt: Timestamp.fromDate(now), expiresAt: update.expiresAt ?? data.expiresAt ?? null });
    });
    if (action.action === "answer" && response) {
      if (!sender) throw new Error("legal_request_email_unavailable");
      try {
        await sender.send({ recipient, purpose: "answered", requestId, kind, response });
        await this.db.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(ref);
          if (!snapshot.exists) throw new Error("legal_request_not_found");
          const data = asRecord(snapshot.data(), "legal_request");
          this.assertEnums(data);
          if (data.answerDeliveryStatus !== "pending" || data.pendingResponse !== response) throw new Error("legal_request_revision_conflict");
          const answeredAt = Timestamp.now();
          transaction.set(ref, { status: "answered", response, pendingResponse: FieldValue.delete(), answerDeliveryStatus: "sent", answerDeliveredAt: answeredAt, answeredAt, revision: Number(data.revision) + 1, updatedAt: answeredAt }, { merge: true });
          transaction.create(ref.collection("audit").doc(), { action: "answer_delivered", actorPseudonym: this.actorPseudonym(actorId), occurredAt: answeredAt, expiresAt: data.expiresAt ?? null });
        });
      } catch (error) {
        // A malformed stored enum is not an SMTP failure; do not overwrite the
        // record's delivery state or mask the safe data-integrity category.
        if (error instanceof Error && error.message === "legal_request_record_invalid") throw error;
        await this.db.runTransaction(async (transaction) => {
          const current = await transaction.get(ref);
          if (!current.exists) throw new Error("legal_request_not_found");
          this.assertEnums(asRecord(current.data(), "legal_request"));
          transaction.set(ref, { answerDeliveryStatus: "failed", pendingResponse: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        });
        throw new Error("legal_request_email_unavailable");
      }
    }
    if (action.action === "close" || action.action === "set_legal_hold" || action.action === "review_retention") await this.alignAuditExpiry(requestId);
    const snapshot = await ref.get();
    return this.read(requestId, asRecord(snapshot.data(), "legal_request"));
  }

  private actorPseudonym(actorId: string): string {
    return createHmac("sha256", this.auditHmacSecret).update(`legal-request-actor\0${actorId}`, "utf8").digest("base64url");
  }

  private reviewAt(data: Record<string, unknown>): string | null {
    const dates = [data.legalHold ? data.legalHoldReviewBy : null, data.nextReviewAt].filter((date): date is Timestamp => date instanceof Timestamp);
    if (dates.length) return new Date(Math.min(...dates.map((date) => date.toMillis()))).toISOString();
    // Historical claim clocks/necessity cannot be guessed; put them straight into the review queue.
    return data.legalHold || data.status === "closed" && data.retentionKind !== "minimal_archive"
      ? (data.closedAt instanceof Timestamp ? data.closedAt.toDate().toISOString() : new Date(0).toISOString()) : null;
  }

  private isUnexpired(data: Record<string, unknown>): boolean {
    return !data.expiresAt || asTimestamp(data.expiresAt, "legal_request_expiry").toMillis() > Date.now() || data.legalHold === true;
  }

  private async claimPublicRateLimit(email: string, at: Date): Promise<void> {
    const windowStartedAt = Math.floor(at.getTime() / 3_600_000) * 3_600_000;
    const key = createHmac("sha256", this.auditHmacSecret).update(`legal-request-public\0${email}\0${windowStartedAt}`, "utf8").digest("hex");
    const ref = this.db.collection("legalRequestRateLimits").doc(key);
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const count = snapshot.exists ? Number(snapshot.get("count")) : 0;
      if (!Number.isSafeInteger(count) || count >= 5) throw new Error("legal_request_rate_limited");
      transaction.set(ref, { count: count + 1, expiresAt: Timestamp.fromMillis(windowStartedAt + 3_600_000), updatedAt: Timestamp.fromDate(at) }, { merge: true });
    });
  }

  private async alignAuditExpiry(requestId: string): Promise<void> {
    const ref = this.db.collection("legalRequests").doc(requestId);
    await this.db.runTransaction(async (transaction) => {
      const [request, audit] = await Promise.all([transaction.get(ref), transaction.get(ref.collection("audit"))]);
      if (!request.exists) return;
      const data = asRecord(request.data(), "legal_request");
      this.assertEnums(data);
      const expiresAt = data.expiresAt ?? null;
      for (const document of audit.docs) transaction.set(document.ref, { expiresAt }, { merge: true });
    });
  }

  private read(requestId: string, data: Record<string, unknown>): LegalRequestItem {
    this.assertEnums(data);
    return Object.freeze({
      requestId, kind: data.kind, status: data.status,
      receivedAt: asTimestamp(data.receivedAt, "legal_request_received_at").toDate().toISOString(),
      responseDueAt: data.responseDueAt ? asTimestamp(data.responseDueAt, "legal_request_response_due_at").toDate().toISOString() : null,
      answeredAt: data.answeredAt ? asTimestamp(data.answeredAt, "legal_request_answered_at").toDate().toISOString() : null,
      retentionUntil: data.retentionUntil ? asTimestamp(data.retentionUntil, "legal_request_retention_until").toDate().toISOString() : null,
      response: typeof data.response === "string" ? data.response : null,
      legalHold: data.legalHold === true,
      legalHoldReviewBy: data.legalHoldReviewBy ? asTimestamp(data.legalHoldReviewBy, "legal_hold_review_by").toDate().toISOString() : null,
      nextReviewAt: this.reviewAt(data),
      reviewReason: typeof data.reviewReason === "string" ? data.reviewReason : typeof data.retentionReason === "string" ? data.retentionReason : null,
      revision: Number(data.revision),
    });
  }

  private toOperatorItem(requestId: string, data: Record<string, unknown>): OperatorLegalRequestItem {
    this.assertEnums(data);
    return Object.freeze({
      requestId,
      kind: data.kind,
      status: data.status,
      receivedAt: asTimestamp(data.receivedAt, "legal_request_received_at").toDate().toISOString(),
      responseDueAt: data.responseDueAt ? asTimestamp(data.responseDueAt, "legal_request_response_due_at").toDate().toISOString() : null,
      answeredAt: data.answeredAt ? asTimestamp(data.answeredAt, "legal_request_answered_at").toDate().toISOString() : null,
      retentionUntil: data.retentionUntil ? asTimestamp(data.retentionUntil, "legal_request_retention_until").toDate().toISOString() : null,
      legalHold: data.legalHold === true,
      legalHoldReviewBy: data.legalHoldReviewBy ? asTimestamp(data.legalHoldReviewBy, "legal_hold_review_by").toDate().toISOString() : null,
      nextReviewAt: this.reviewAt(data),
      reviewReason: typeof data.reviewReason === "string" ? data.reviewReason : typeof data.retentionReason === "string" ? data.retentionReason : null,
      revision: Number(data.revision),
    });
  }

  private assertEnums(data: Record<string, unknown>): asserts data is Record<string, unknown> & { kind: LegalRequestKind; status: LegalRequestStatus } {
    if (!legalRequestKindSchema.safeParse(data.kind).success || !LEGAL_REQUEST_STATUSES.some((status) => status === data.status)) {
      throw new Error("legal_request_record_invalid");
    }
  }
}
