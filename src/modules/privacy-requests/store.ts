import { archiveIsLive, nextWorkingReviewAt } from "../retention/review.js";
import { readOperatorPage, type OperatorPageOptions } from "../retention/operatorPage.js";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { Timestamp, type Firestore, type QueryDocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import { COLLECTIONS } from "../../infrastructure/firestore/paths.js";
import { asRecord, asTimestamp } from "../../infrastructure/firestore/values.js";
import { assertExpectedAuthorizationGeneration } from "../auth/authorizationGeneration.js";
import { addUtcCalendarMonths } from "../../infrastructure/time/utcCalendar.js";
import { RETENTION_POLICY } from "../retention/policy.js";
import {
  initialPrivacyRequestDeadline,
  transitionPrivacyRequest,
  type PrivacyRequestAdminAction,
  type PrivacyRequestChannel,
  type PrivacyRequestOutcome,
  type PrivacyRequestRight,
  type PrivacyRequestSnapshot,
  type PrivacyRequestStatus,
} from "./contracts.js";

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1_000;
const SESSION_TTL_MS = 15 * 60 * 1_000;
const RESPONSE_TTL_MS = RETENTION_POLICY.privacyRequestSecretRetentionDays * 24 * 60 * 60 * 1_000;
const AUDIT_RETENTION_MONTHS = RETENTION_POLICY.privacyRequestArchiveMonths;
const PUBLIC_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1_000;
const PUBLIC_RATE_LIMIT_MAX = 5;
const LIST_LIMIT = 100;
const RESPONSE_CHUNK_CHARACTERS = 150_000;

function defaultUnverifiedReviewAt(data: Record<string, unknown>): Date | null {
  if (data.channel !== "public" || data.subjectVerifiedAt || !["received", "identity_verification_required"].includes(String(data.status))) return null;
  const receivedAt = asTimestamp(data.receivedAt, "privacy_received_at").toMillis();
  const deadlineAt = asTimestamp(data.deadlineAt, "privacy_deadline").toMillis();
  return new Date(Math.min(deadlineAt, receivedAt + 30 * 24 * 60 * 60 * 1_000));
}

type EncryptedValue = Readonly<{ ciphertext: string; iv: string; tag: string }>;

export type PrivacyRequestListItem = Readonly<{
  requestId: string;
  right: PrivacyRequestRight;
  channel: PrivacyRequestChannel;
  status: PrivacyRequestStatus;
  outcome: PrivacyRequestOutcome | null;
  receivedAt: string;
  deadlineAt: string;
  deliveredAt: string | null;
  extendedAt: string | null;
  revision: number;
}>;

export type PrivacyRequestOperatorQueue = Readonly<{
  items: readonly (PrivacyRequestListItem & Readonly<{ nextReviewAt: string | null; reviewReason: string | null }>)[];
  truncated: boolean;
  nextCursor: string | null;
}>;

export type PrivacyRequestDetails = PrivacyRequestListItem & Readonly<{
  narrative: string | null;
  reportSubmissionIds: readonly string[];
  reason: string | null;
  executionEvidence: string | null;
  responseAvailableUntil: string | null;
  subjectVerified: boolean;
  extensionNoticeStatus: "available_in_app" | "pending" | "delivered" | "failed" | null;
  nextReviewAt: string | null;
  reviewReason: string | null;
}>;

export type PrivacyRequestResponse = Readonly<{
  request: PrivacyRequestListItem;
  response: string | null;
  responseAvailableUntil: string | null;
  extensionReason: string | null;
  complaintInformationIncluded: boolean;
}>;

export interface PrivacyRequestEmailSender {
  send(input: Readonly<{ recipient: string; purpose: "verify" | "response" | "extension"; requestId: string; code: string; extensionReason?: string }>): Promise<void>;
}

export interface PrivacyRequestStore {
  createAccount(userId: string, expectedAuthorizationGeneration: number, right: PrivacyRequestRight, narrative?: string): Promise<PrivacyRequestListItem>;
  createGuest(input: Readonly<{ clientRequestId: string; email: string; right: PrivacyRequestRight; narrative?: string; reportSubmissionIds: readonly string[]; rateLimitKey: string }>, sender: PrivacyRequestEmailSender): Promise<string>;
  resendGuestCode(requestId: string, email: string, rateLimitKey: string, sender: PrivacyRequestEmailSender): Promise<void>;
  exchangeGuestCode(code: string, rateLimitKey: string): Promise<Readonly<{ requestId: string; sessionToken: string }>>;
  listAccount(userId: string): Promise<readonly PrivacyRequestListItem[]>;
  readAccount(userId: string, expectedAuthorizationGeneration: number, requestId: string): Promise<PrivacyRequestResponse | null>;
  readGuest(requestId: string, sessionToken: string): Promise<PrivacyRequestResponse | null>;
  listAdmin(): Promise<readonly PrivacyRequestListItem[]>;
  listOperatorQueue(actorId: string, options?: OperatorPageOptions): Promise<PrivacyRequestOperatorQueue>;
  readAdmin(requestId: string, actorId: string): Promise<PrivacyRequestDetails | null>;
  readExecutionContext(requestId: string): Promise<Readonly<{ channel: PrivacyRequestChannel; right: PrivacyRequestRight; status: PrivacyRequestStatus; revision: number; userId: string | null }> | null>;
  prepareExecutedResponse(requestId: string, actorId: string, expectedRevision: number, response: string, executionEvidence: string): Promise<PrivacyRequestDetails>;
  transitionAdmin(requestId: string, actorId: string, action: PrivacyRequestAdminAction, sender: PrivacyRequestEmailSender | null, operatorBlockPublicEmail?: boolean): Promise<PrivacyRequestDetails>;
}

export class FirestorePrivacyRequestStore implements PrivacyRequestStore {
  private readonly key: Buffer;
  public constructor(private readonly db: Firestore, encryptionKeyBase64: string, private readonly auditHmacSecret: string) {
    this.key = Buffer.from(encryptionKeyBase64, "base64");
    if (this.key.length !== 32) throw new Error("privacy_response_key_invalid");
    if (Buffer.byteLength(auditHmacSecret, "utf8") < 32) throw new Error("privacy_audit_hmac_secret_invalid");
  }

  public async createAccount(userId: string, expectedAuthorizationGeneration: number, right: PrivacyRequestRight, narrative?: string): Promise<PrivacyRequestListItem> {
    const receivedAt = new Date();
    const requestId = `pr_${randomUUID()}`;
    const record = this.initialRecord(requestId, "account", right, receivedAt, this.subjectPseudonym(`account:${userId}`), userId);
    await this.db.runTransaction(async (transaction) => {
      const user = await transaction.get(this.db.collection(COLLECTIONS.users).doc(userId));
      if (!user.exists) throw new Error("account_deleted");
      assertExpectedAuthorizationGeneration(asRecord(user.data(), "user"), expectedAuthorizationGeneration);
      transaction.create(this.requestRef(requestId), record);
      transaction.create(this.secretRef(requestId), { payload: this.encrypt(JSON.stringify({ narrative: narrative ?? null, reportSubmissionIds: [] })) });
      this.audit(transaction, requestId, "subject", "received", "request_received", receivedAt);
    });
    return this.toListItem(requestId, record);
  }

  public async createGuest(input: Readonly<{ clientRequestId: string; email: string; right: PrivacyRequestRight; narrative?: string; reportSubmissionIds: readonly string[]; rateLimitKey: string }>, sender: PrivacyRequestEmailSender): Promise<string> {
    const email = input.email.trim().toLowerCase();
    const now = new Date();
    const fingerprint = this.subjectPseudonym(JSON.stringify({ email, right: input.right, narrative: input.narrative ?? null, reportSubmissionIds: input.reportSubmissionIds }));
    const idempotencyRef = this.db.collection(COLLECTIONS.privacyRequestIdempotency).doc(input.clientRequestId);
    const prior = await idempotencyRef.get();
    if (prior.exists) {
      const data = asRecord(prior.data(), "privacy_request_idempotency");
      if (data.fingerprint !== fingerprint || typeof data.requestId !== "string") throw new Error("privacy_request_idempotency_conflict");
      return data.requestId;
    }
    await Promise.all([this.consumePublicRateLimit(`guest-create-email:${email}`, now), this.consumePublicRateLimit(`guest-create-ip:${input.rateLimitKey}`, now)]);
    const result = await this.db.runTransaction(async (transaction) => {
      const existing = await transaction.get(idempotencyRef);
      if (existing.exists) {
        const data = asRecord(existing.data(), "privacy_request_idempotency");
        if (data.fingerprint !== fingerprint || typeof data.requestId !== "string") throw new Error("privacy_request_idempotency_conflict");
        return { requestId: data.requestId, created: false };
      }
      const id = `pr_${randomUUID()}`;
      const record = this.initialRecord(id, "public", input.right, now, this.subjectPseudonym(`email:${email}`), null);
      transaction.create(this.requestRef(id), { ...record, status: "identity_verification_required" });
      transaction.create(this.secretRef(id), { payload: this.encrypt(JSON.stringify({ email, narrative: input.narrative ?? null, reportSubmissionIds: [...input.reportSubmissionIds] })) });
      transaction.create(idempotencyRef, { requestId: id, fingerprint, expiresAt: Timestamp.fromDate(addUtcCalendarMonths(now, AUDIT_RETENTION_MONTHS)) });
      this.audit(transaction, id, "subject", "received", "public_request_received", now);
      this.audit(transaction, id, "system", "identity_verification_required", "email_possession_verification_required", now);
      return { requestId: id, created: true };
    });
    if (result.created) await this.issueGuestCode(result.requestId, email, sender, false);
    return result.requestId;
  }

  public async resendGuestCode(requestId: string, emailInput: string, rateLimitKey: string, sender: PrivacyRequestEmailSender): Promise<void> {
    const email = emailInput.trim().toLowerCase();
    const now = new Date();
    await Promise.all([
      this.consumePublicRateLimit(`guest-resend-email:${email}`, now),
      this.consumePublicRateLimit(`guest-resend-ip:${rateLimitKey}`, now),
      this.consumePublicRateLimit(`guest-resend-request:${requestId}`, now),
    ]);
    await this.issueGuestCode(requestId, email, sender, true);
  }

  public async exchangeGuestCode(code: string, rateLimitKey: string): Promise<Readonly<{ requestId: string; sessionToken: string }>> {
    const divider = code.indexOf(".");
    const requestId = code.slice(0, divider);
    const token = code.slice(divider + 1);
    const now = new Date();
    await Promise.all([
      this.consumePublicRateLimit(`guest-verify-ip:${rateLimitKey}`, now),
      this.consumePublicRateLimit(`guest-verify-request:${requestId}`, now),
    ]);
    const result = await this.exchangeCodeToken(requestId, token);
    return Object.freeze({ requestId, sessionToken: result.sessionToken });
  }

  private async issueGuestCode(requestId: string, email: string, sender: PrivacyRequestEmailSender, allowVerified: boolean): Promise<void> {
    const token = randomBytes(32).toString("base64url");
    const attemptId = randomUUID();
    const staged = await this.db.runTransaction(async (transaction) => {
      const [requestSnapshot, secretSnapshot] = await transaction.getAll(this.requestRef(requestId), this.secretRef(requestId));
      if (!requestSnapshot?.exists || !secretSnapshot?.exists) return false;
      const data = asRecord(requestSnapshot.data(), "privacy_request");
      if (data.channel !== "public" || (!allowVerified && data.emailPossessionVerifiedAt)) return false;
      const secret = secretSnapshot.exists ? asRecord(secretSnapshot.data(), "privacy_request_secret") : {};
      const decrypted = JSON.parse(this.decrypt(asRecord(secret.payload, "privacy_request_secret_payload"))) as { email?: unknown };
      if (decrypted.email !== email) return false;
      const now = new Date();
      transaction.set(this.requestRef(requestId), { verificationTokenHash: this.hash(`app-code:${token}`), verificationExpiresAt: Timestamp.fromMillis(now.getTime() + VERIFICATION_TTL_MS), deliveryAttemptId: attemptId, deliveryFailure: "pending", deliveryAttemptedAt: Timestamp.fromDate(now), deliveryFailureAt: null, updatedAt: Timestamp.fromDate(now) }, { merge: true });
      return true;
    });
    if (!staged) return;
    try {
      await sender.send({ recipient: email, purpose: "verify", requestId, code: `${requestId}.${token}` });
      await this.finishGuestDeliveryAttempt(requestId, attemptId, null);
    } catch {
      await this.finishGuestDeliveryAttempt(requestId, attemptId, "verification_email_failed");
    }
  }

  private async finishGuestDeliveryAttempt(requestId: string, attemptId: string, failure: string | null): Promise<void> {
    await this.db.runTransaction(async (transaction) => {
      const ref = this.requestRef(requestId);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || asRecord(snapshot.data(), "privacy_request").deliveryAttemptId !== attemptId) return;
      transaction.set(ref, { deliveryFailure: failure, updatedAt: Timestamp.now() }, { merge: true });
    });
  }

  private async exchangeCodeToken(requestId: string, token: string): Promise<Readonly<{ sessionToken: string }>> {
    const sessionToken = randomBytes(32).toString("base64url");
    await this.db.runTransaction(async (transaction) => {
      const ref = this.requestRef(requestId);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("privacy_request_token_invalid");
      const data = asRecord(snapshot.data(), "privacy_request");
      const tokenHash = typeof data.verificationTokenHash === "string" ? data.verificationTokenHash : "";
      const expiresAt = asTimestamp(data.verificationExpiresAt, "privacy_verification_expiry").toMillis();
      if (!tokenHash || tokenHash !== this.hash(`app-code:${token}`) || expiresAt <= Date.now()) throw new Error("privacy_request_token_invalid");
      const now = new Date();
      const nextStatus = data.status === "identity_verification_required" ? "received" : data.status;
      transaction.set(ref, {
        status: nextStatus,
        verificationTokenHash: null,
        verificationExpiresAt: null,
        publicSessionHash: this.hash(sessionToken),
        publicSessionExpiresAt: Timestamp.fromMillis(now.getTime() + SESSION_TTL_MS),
        emailPossessionVerifiedAt: Timestamp.fromDate(now),
        revision: Number(data.revision) + 1,
        updatedAt: Timestamp.fromDate(now),
      }, { merge: true });
      this.audit(transaction, requestId, "subject", "email_possession_verified", "email_possession_verified", now);
    });
    return Object.freeze({ sessionToken });
  }

  public async listAccount(userId: string): Promise<readonly PrivacyRequestListItem[]> {
    const selected: QueryDocumentSnapshot[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.db.collection(COLLECTIONS.privacyRequests).where("userId", "==", userId).orderBy("receivedAt", "desc").limit(LIST_LIMIT);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const document of page.docs) if (this.isUnexpired(asRecord(document.data(), "privacy_request"))) selected.push(document);
      if (selected.length >= LIST_LIMIT || page.empty || page.size < LIST_LIMIT) break;
      cursor = page.docs.at(-1);
    }
    return Object.freeze(selected.slice(0, LIST_LIMIT).map((document) => this.toListItem(document.id, asRecord(document.data(), "privacy_request"))));
  }

  public async readAccount(userId: string, expectedAuthorizationGeneration: number, requestId: string): Promise<PrivacyRequestResponse | null> {
    const snapshot = await this.requestRef(requestId).get();
    if (!snapshot.exists) return null;
    const data = asRecord(snapshot.data(), "privacy_request");
    if (data.userId !== userId || data.channel !== "account" || !this.isUnexpired(data)) return null;
    const response = await this.responseFor(requestId, data);
    if (response.response !== null) {
      await this.recordReadAudit(requestId, this.subjectPseudonym(`account:${userId}`), { userId, expectedAuthorizationGeneration });
    } else {
      await this.db.runTransaction(async (transaction) => {
        const user = await transaction.get(this.db.collection(COLLECTIONS.users).doc(userId));
        if (!user.exists) throw new Error("account_deleted");
        assertExpectedAuthorizationGeneration(asRecord(user.data(), "user"), expectedAuthorizationGeneration);
      }, { readOnly: true });
    }
    return response;
  }

  public async readGuest(requestId: string, sessionToken: string): Promise<PrivacyRequestResponse | null> {
    const snapshot = await this.requestRef(requestId).get();
    if (!snapshot.exists) return null;
    const data = asRecord(snapshot.data(), "privacy_request");
    const hash = typeof data.publicSessionHash === "string" ? data.publicSessionHash : "";
    const expiry = data.publicSessionExpiresAt ? asTimestamp(data.publicSessionExpiresAt, "privacy_session_expiry").toMillis() : 0;
    if (!hash || hash !== this.hash(sessionToken) || expiry <= Date.now() || data.channel !== "public") return null;
    const response = await this.responseFor(requestId, data);
    if (response.response !== null) await this.recordReadAudit(requestId, "subject");
    return response;
  }

  public async listAdmin(): Promise<readonly PrivacyRequestListItem[]> {
    const selected: QueryDocumentSnapshot[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.db.collection(COLLECTIONS.privacyRequests).orderBy("deadlineAt", "asc").limit(LIST_LIMIT);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const document of page.docs) if (this.isUnexpired(asRecord(document.data(), "privacy_request"))) selected.push(document);
      if (selected.length >= LIST_LIMIT || page.empty || page.size < LIST_LIMIT) break;
      cursor = page.docs.at(-1);
    }
    return Object.freeze(selected.slice(0, LIST_LIMIT).map((document) => this.toListItem(document.id, asRecord(document.data(), "privacy_request"))));
  }

  public async listOperatorQueue(actorId: string, options?: OperatorPageOptions): Promise<PrivacyRequestOperatorQueue> {
    const page = await readOperatorPage(this.db.collection(COLLECTIONS.privacyRequests), (data) => this.isUnexpired(data) && (!options?.dueOnly || this.reviewAt(data) !== null && Date.parse(this.reviewAt(data)!) <= Date.now()), options);
    const selected = page.documents;
    const truncated = page.truncated;
    const occurredAt = new Date();
    if (selected.length > 0) {
      await this.db.runTransaction(async (transaction) => {
        for (const document of selected) {
          this.audit(transaction, document.id, this.actorPseudonym(actorId), "operator_queue_read", "operator_queue_read", occurredAt, this.auditExpiry(asRecord(document.data(), "privacy_request")));
        }
      });
    }
    return Object.freeze({
      items: Object.freeze(selected.map((document) => this.toOperatorQueueItem(document.id, asRecord(document.data(), "privacy_request")))),
      truncated,
      nextCursor: page.nextCursor,
    });
  }

  public async readAdmin(requestId: string, actorId: string): Promise<PrivacyRequestDetails | null> {
    const [requestSnapshot, secretSnapshot] = await Promise.all([this.requestRef(requestId).get(), this.secretRef(requestId).get()]);
    if (!requestSnapshot.exists) return null;
    const data = asRecord(requestSnapshot.data(), "privacy_request");
    if (!this.isUnexpired(data) || !secretSnapshot.exists && !data.closedAt) return null;
    const now = new Date();
    await this.db.runTransaction(async (transaction) => this.audit(transaction, requestId, this.actorPseudonym(actorId), "details_read", "operator_details_read", now, this.auditExpiry(data)));
    const secret = secretSnapshot.exists ? asRecord(secretSnapshot.data(), "privacy_request_secret") : {};
    const secretActive = secretSnapshot.exists && this.secretIsLive(secret, data);
    const decrypted = secretActive ? JSON.parse(this.decrypt(asRecord(secret.payload, "privacy_request_secret_payload"))) as { narrative?: unknown; reportSubmissionIds?: unknown } : {};
    const extensionReason = secretActive ? this.decryptOptional(secret.extensionReason) : null;
    return Object.freeze({
      ...this.toListItem(requestId, data),
      narrative: typeof decrypted.narrative === "string" ? decrypted.narrative : null,
      reportSubmissionIds: Object.freeze(Array.isArray(decrypted.reportSubmissionIds) ? decrypted.reportSubmissionIds.filter((value): value is string => typeof value === "string") : []),
      reason: typeof data.reason === "string" ? data.reason : extensionReason,
      executionEvidence: typeof data.executionEvidence === "string" ? data.executionEvidence : null,
      responseAvailableUntil: data.responseExpiresAt ? asTimestamp(data.responseExpiresAt, "privacy_response_expiry").toDate().toISOString() : null,
      subjectVerified: data.channel === "account" || Boolean(data.subjectVerifiedAt),
      extensionNoticeStatus: data.extensionNoticeStatus === "available_in_app" || data.extensionNoticeStatus === "pending" || data.extensionNoticeStatus === "delivered" || data.extensionNoticeStatus === "failed" ? data.extensionNoticeStatus : null,
      nextReviewAt: this.reviewAt(data),
      reviewReason: this.reviewReason(data),
    });
  }

  private toOperatorQueueItem(requestId: string, data: Record<string, unknown>): PrivacyRequestOperatorQueue["items"][number] {
    return Object.freeze({
      ...this.toListItem(requestId, data),
      nextReviewAt: this.reviewAt(data),
      reviewReason: this.reviewReason(data),
    });
  }

  public async readExecutionContext(requestId: string): Promise<Readonly<{ channel: PrivacyRequestChannel; right: PrivacyRequestRight; status: PrivacyRequestStatus; revision: number; userId: string | null }> | null> {
    const snapshot = await this.requestRef(requestId).get();
    if (!snapshot.exists) return null;
    const data = asRecord(snapshot.data(), "privacy_request");
    return Object.freeze({ channel: data.channel as PrivacyRequestChannel, right: data.right as PrivacyRequestRight, status: data.status as PrivacyRequestStatus, revision: Number(data.revision), userId: typeof data.userId === "string" ? data.userId : null });
  }

  public async prepareExecutedResponse(requestId: string, actorId: string, expectedRevision: number, response: string, executionEvidence: string): Promise<PrivacyRequestDetails> {
    await this.db.runTransaction(async (transaction) => {
      const ref = this.requestRef(requestId);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("privacy_request_not_found");
      const data = asRecord(snapshot.data(), "privacy_request");
      if (Number(data.revision) !== expectedRevision) throw new Error("privacy_request_revision_conflict");
      if (data.status !== "in_review" || data.channel !== "account" || (data.right !== "access" && data.right !== "portability") || typeof data.userId !== "string") throw new Error("privacy_request_executor_unavailable");
      const now = new Date();
      transaction.set(ref, { status: "response_ready", outcome: "fulfilled", responsePreparedAt: Timestamp.fromDate(now), complaintInformationIncluded: true, executionEvidence, revision: expectedRevision + 1, updatedAt: Timestamp.fromDate(now) }, { merge: true });
      this.writeResponseArtifact(transaction, requestId, response, now);
      this.audit(transaction, requestId, this.actorPseudonym(actorId), "execute_export", "system_export_completed", now);
    });
    const details = await this.readAdmin(requestId, actorId);
    if (!details) throw new Error("privacy_request_not_found");
    return details;
  }

  public async transitionAdmin(requestId: string, actorId: string, action: PrivacyRequestAdminAction, sender: PrivacyRequestEmailSender | null, operatorBlockPublicEmail = false): Promise<PrivacyRequestDetails> {
    const operatorEmailAction = action.action === "extend" || action.action === "deliver" || action.action === "retry_extension_notice";
    if (action.action === "execute_export") throw new Error("privacy_request_executor_required");
    if (action.action === "retry_extension_notice") {
      await this.notifyPublicExtension(requestId, actorId, action.expectedRevision, sender, operatorBlockPublicEmail);
      const retried = await this.readAdmin(requestId, actorId);
      if (!retried) throw new Error("privacy_request_not_found");
      return retried;
    }
    if (action.action === "deliver") {
      const current = await this.requestRef(requestId).get();
      if (!current.exists) throw new Error("privacy_request_not_found");
      if (asRecord(current.data(), "privacy_request").channel === "public") return this.deliverPublic(requestId, actorId, action.expectedRevision, sender, operatorBlockPublicEmail);
    }
    await this.db.runTransaction(async (transaction) => {
      const ref = this.requestRef(requestId);
      const [snapshot, secretSnapshot] = action.action === "extend"
        ? await transaction.getAll(ref, this.secretRef(requestId))
        : [await transaction.get(ref), null];
      if (!snapshot.exists) throw new Error("privacy_request_not_found");
      if (action.action === "extend" && !secretSnapshot?.exists) throw new Error("privacy_request_not_found");
      const data = asRecord(snapshot.data(), "privacy_request");
      const now = new Date();
      const specialUpdate: Record<string, unknown> = {};
      if (action.action === "close_unverified") {
        if (data.channel !== "public" || data.subjectVerifiedAt || data.emailPossessionVerifiedAt || !["received", "identity_verification_required"].includes(String(data.status))) throw new Error("privacy_request_unverified_close_invalid");
        const archiveExpiry = addUtcCalendarMonths(now, AUDIT_RETENTION_MONTHS);
        Object.assign(specialUpdate, { status: "closed", closedAt: Timestamp.fromDate(now), expiresAt: Timestamp.fromDate(archiveExpiry), unverifiedDisposition: "not_verified", reason: action.reason, verificationTokenHash: null, verificationExpiresAt: null, publicSessionHash: null, publicSessionExpiresAt: null, deliveryAttemptId: null });
        transaction.set(this.secretRef(requestId), { expiresAt: Timestamp.fromMillis(now.getTime() + RESPONSE_TTL_MS) }, { merge: true });
      }
      if (action.action === "record_review") {
        if (["closed", "fulfilled", "partially_fulfilled", "refused"].includes(String(data.status))) throw new Error("privacy_request_review_unavailable");
        const nextReviewAt = new Date(action.nextReviewAt);
        if (!Number.isFinite(nextReviewAt.getTime()) || nextReviewAt <= now || nextReviewAt.getTime() > now.getTime() + 30 * 24 * 60 * 60 * 1_000) throw new Error("privacy_request_review_date_invalid");
        specialUpdate.nextReviewAt = Timestamp.fromDate(nextReviewAt);
        specialUpdate.reviewReason = action.reason;
        specialUpdate.deliveryReviewAcknowledgedAt = Timestamp.fromDate(now);
      }
      if (operatorBlockPublicEmail && operatorEmailAction && data.channel === "public") throw new Error("privacy_request_operator_action_unavailable");
      if (action.action === "extend" && data.channel === "public" && !sender) throw new Error("privacy_email_unavailable");
      if (Number(data.revision) !== action.expectedRevision) throw new Error("privacy_request_revision_conflict");
      if (action.action === "start_review" && data.channel === "public" && !data.subjectVerifiedAt) throw new Error("privacy_request_subject_unverified");
      if (action.action === "verify_subject" && (data.channel !== "public" || !data.emailPossessionVerifiedAt)) throw new Error("privacy_request_subject_unverified");
      if (action.action === "prepare_response" && action.outcome !== "refused") throw new Error("privacy_request_executor_required");
      const current = this.toTransitionSnapshot(data);
      const next = action.action === "record_review" ? current : action.action === "close_unverified"
        ? Object.freeze({ ...current, status: "closed" as const, closedAt: now })
        : transitionPrivacyRequest(current, action, now);
      const update: Record<string, unknown> = {
        ...specialUpdate,
        status: next.status,
        outcome: next.outcome,
        deadlineAt: Timestamp.fromDate(next.deadlineAt),
        extendedAt: next.extendedAt ? Timestamp.fromDate(next.extendedAt) : null,
        responsePreparedAt: next.responsePreparedAt ? Timestamp.fromDate(next.responsePreparedAt) : null,
        deliveredAt: next.deliveredAt ? Timestamp.fromDate(next.deliveredAt) : null,
        closedAt: next.closedAt ? Timestamp.fromDate(next.closedAt) : null,
        revision: action.expectedRevision + 1,
        updatedAt: Timestamp.fromDate(now),
      };
      if (action.action === "require_verification" || action.action === "verify_subject") update.reason = action.reason;
      if (action.action === "verify_subject") update.subjectVerifiedAt = Timestamp.fromDate(now);
      if (action.action === "extend") {
        update.extensionNoticeLocale = action.noticeLocale;
        update.extensionNoticeStatus = data.channel === "account" ? "available_in_app" : "pending";
        transaction.set(this.secretRef(requestId), { extensionReason: this.encrypt(action.reason) }, { merge: true });
      }
      if (action.action === "prepare_response") {
        update.reason = action.reason;
        update.executionEvidence = "operator_refusal_decision";
        update.complaintInformationIncluded = true;
        this.writeResponseArtifact(transaction, requestId, action.response, now);
      }
      if (action.action === "deliver") {
        const responseExpiresAt = new Date(now.getTime() + RESPONSE_TTL_MS);
        update.responseExpiresAt = Timestamp.fromDate(responseExpiresAt);
        await this.setChunkExpiry(transaction, requestId, responseExpiresAt);
        transaction.set(this.responseRef(requestId), { expiresAt: Timestamp.fromDate(responseExpiresAt) }, { merge: true });
      }
      if (action.action === "close") {
        const archiveExpiry = addUtcCalendarMonths(now, AUDIT_RETENTION_MONTHS);
        update.expiresAt = Timestamp.fromDate(archiveExpiry);
        update.verificationTokenHash = null;
        update.verificationExpiresAt = null;
        update.publicSessionHash = null;
        update.publicSessionExpiresAt = null;
        update.deliveryAttemptId = null;
        transaction.set(this.secretRef(requestId), { expiresAt: Timestamp.fromMillis(now.getTime() + RESPONSE_TTL_MS) }, { merge: true });
      }
      transaction.set(ref, update, { merge: true });
      this.audit(transaction, requestId, this.actorPseudonym(actorId), action.action, action.action === "prepare_response" ? "operator_refusal_decision" : action.action === "record_review" || action.action === "close_unverified" ? action.reason : "state_transition", now);
    });
    if (action.action === "extend") {
      const current = await this.requestRef(requestId).get();
      if (current.exists && asRecord(current.data(), "privacy_request").channel === "public") await this.notifyPublicExtension(requestId, actorId, action.expectedRevision + 1, sender, operatorBlockPublicEmail);
    }
    if (action.action === "close" || action.action === "close_unverified") await this.alignAuditRetentionWithClosure(requestId);
    const details = await this.readAdmin(requestId, actorId);
    if (!details) throw new Error("privacy_request_not_found");
    return details;
  }

  private async deliverPublic(requestId: string, actorId: string, expectedRevision: number, sender: PrivacyRequestEmailSender | null, operatorBlockPublicEmail = false): Promise<PrivacyRequestDetails> {
    if (!sender) throw new Error("privacy_email_unavailable");
    const token = randomBytes(32).toString("base64url");
    const attemptId = randomUUID();
    let email = "";
    await this.db.runTransaction(async (transaction) => {
      const [requestSnapshot, secretSnapshot] = await transaction.getAll(this.requestRef(requestId), this.secretRef(requestId));
      if (!requestSnapshot?.exists || !secretSnapshot?.exists) throw new Error("privacy_request_not_found");
      const data = asRecord(requestSnapshot.data(), "privacy_request");
      if (data.channel !== "public") throw new Error("privacy_request_transition_invalid");
      if (operatorBlockPublicEmail) throw new Error("privacy_request_operator_action_unavailable");
      if (Number(data.revision) !== expectedRevision) throw new Error("privacy_request_revision_conflict");
      transitionPrivacyRequest(this.toTransitionSnapshot(data), { action: "deliver", expectedRevision }, new Date());
      const secret = secretSnapshot.exists ? asRecord(secretSnapshot.data(), "privacy_request_secret") : {};
      const decrypted = JSON.parse(this.decrypt(asRecord(secret.payload, "privacy_request_secret_payload"))) as { email?: unknown };
      if (typeof decrypted.email !== "string") throw new Error("privacy_request_invalid");
      email = decrypted.email;
      const now = new Date();
      transaction.set(this.requestRef(requestId), {
        deliveryAttemptId: attemptId,
        deliveryFailure: null,
        deliveryAttemptedAt: Timestamp.fromDate(now), deliveryFailureAt: null,
        verificationTokenHash: this.hash(`app-code:${token}`),
        verificationExpiresAt: Timestamp.fromMillis(now.getTime() + VERIFICATION_TTL_MS),
        revision: expectedRevision + 1,
        updatedAt: Timestamp.fromDate(now),
      }, { merge: true });
      this.audit(transaction, requestId, this.actorPseudonym(actorId), "delivery_staged", "response_delivery_staged", now);
    });
    try {
      await sender.send({ recipient: email, purpose: "response", requestId, code: `${requestId}.${token}` });
    } catch {
      await this.requestRef(requestId).set({ deliveryFailure: "response_email_failed", deliveryFailureAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true });
      throw new Error("privacy_email_unavailable");
    }
    await this.db.runTransaction(async (transaction) => {
      const ref = this.requestRef(requestId);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("privacy_request_not_found");
      const data = asRecord(snapshot.data(), "privacy_request");
      if (data.deliveryAttemptId !== attemptId || Number(data.revision) !== expectedRevision + 1) throw new Error("privacy_request_revision_conflict");
      const now = new Date();
      const next = transitionPrivacyRequest(this.toTransitionSnapshot(data), { action: "deliver", expectedRevision: expectedRevision + 1 }, now);
      const responseExpiresAt = new Date(now.getTime() + RESPONSE_TTL_MS);
      await this.setChunkExpiry(transaction, requestId, responseExpiresAt);
      transaction.set(ref, { status: next.status, deliveredAt: Timestamp.fromDate(now), responseExpiresAt: Timestamp.fromDate(responseExpiresAt), deliveryAttemptId: null, deliveryFailure: null, revision: expectedRevision + 2, updatedAt: Timestamp.fromDate(now) }, { merge: true });
      transaction.set(this.responseRef(requestId), { expiresAt: Timestamp.fromDate(responseExpiresAt) }, { merge: true });
      this.audit(transaction, requestId, this.actorPseudonym(actorId), "deliver", "response_delivered", now);
    });
    const details = await this.readAdmin(requestId, actorId);
    if (!details) throw new Error("privacy_request_not_found");
    return details;
  }

  private async notifyPublicExtension(requestId: string, actorId: string, expectedRevision: number, sender: PrivacyRequestEmailSender | null, operatorBlockPublicEmail = false): Promise<void> {
    if (!sender) throw new Error("privacy_email_unavailable");
    const token = randomBytes(32).toString("base64url");
    let email = "";
    let extensionReason = "";
    const now = new Date();
    await this.db.runTransaction(async (transaction) => {
      const [requestSnapshot, secretSnapshot] = await transaction.getAll(this.requestRef(requestId), this.secretRef(requestId));
      if (!requestSnapshot?.exists || !secretSnapshot?.exists) throw new Error("privacy_request_not_found");
      const requestData = asRecord(requestSnapshot.data(), "privacy_request");
      if (requestData.channel !== "public") throw new Error("privacy_request_transition_invalid");
      if (operatorBlockPublicEmail) throw new Error("privacy_request_operator_action_unavailable");
      if (Number(requestData.revision) !== expectedRevision) throw new Error("privacy_request_revision_conflict");
      if (!requestData.extendedAt || (requestData.extensionNoticeStatus !== "pending" && requestData.extensionNoticeStatus !== "failed")) throw new Error("privacy_request_transition_invalid");
      const secret = secretSnapshot.exists ? asRecord(secretSnapshot.data(), "privacy_request_secret") : {};
      const decrypted = JSON.parse(this.decrypt(asRecord(secret.payload, "privacy_request_secret_payload"))) as { email?: unknown };
      extensionReason = this.decryptOptional(secret.extensionReason) ?? "";
      if (typeof decrypted.email !== "string" || !extensionReason) throw new Error("privacy_request_invalid");
      email = decrypted.email;
      transaction.set(this.requestRef(requestId), { verificationTokenHash: this.hash(`app-code:${token}`), verificationExpiresAt: Timestamp.fromMillis(now.getTime() + VERIFICATION_TTL_MS), extensionNoticeAttemptedAt: Timestamp.fromDate(now), extensionNoticeStatus: "pending", extensionNoticeFailureAt: null }, { merge: true });
    });
    try {
      await sender.send({ recipient: email, purpose: "extension", requestId, code: `${requestId}.${token}`, extensionReason });
    } catch {
      await this.requestRef(requestId).set({ extensionNoticeStatus: "failed", extensionNoticeFailureAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true });
      throw new Error("privacy_email_unavailable");
    }
    await this.db.runTransaction(async (transaction) => {
      transaction.set(this.requestRef(requestId), { extensionNoticeStatus: "delivered", extensionNoticeDeliveredAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true });
      this.audit(transaction, requestId, this.actorPseudonym(actorId), "extension_notice", "extension_notice_delivered", new Date());
    });
  }

  private initialRecord(requestId: string, channel: PrivacyRequestChannel, right: PrivacyRequestRight, receivedAt: Date, subjectPseudonym: string, userId: string | null) {
    return {
      requestId, channel, right, userId, subjectPseudonym, status: "received", outcome: null,
      receivedAt: Timestamp.fromDate(receivedAt), deadlineAt: Timestamp.fromDate(initialPrivacyRequestDeadline(receivedAt)),
      extendedAt: null, responsePreparedAt: null, responseExpiresAt: null, deliveredAt: null, closedAt: null,
      revision: 0, createdAt: Timestamp.fromDate(receivedAt), updatedAt: Timestamp.fromDate(receivedAt),
    };
  }

  private toTransitionSnapshot(data: Record<string, unknown>): PrivacyRequestSnapshot {
    return Object.freeze({
      status: data.status as PrivacyRequestStatus,
      outcome: (data.outcome ?? null) as PrivacyRequestOutcome | null,
      deadlineAt: asTimestamp(data.deadlineAt, "privacy_deadline").toDate(),
      extendedAt: data.extendedAt ? asTimestamp(data.extendedAt, "privacy_extended_at").toDate() : null,
      responsePreparedAt: data.responsePreparedAt ? asTimestamp(data.responsePreparedAt, "privacy_response_prepared_at").toDate() : null,
      deliveredAt: data.deliveredAt ? asTimestamp(data.deliveredAt, "privacy_delivered_at").toDate() : null,
      closedAt: data.closedAt ? asTimestamp(data.closedAt, "privacy_closed_at").toDate() : null,
    });
  }

  private toListItem(requestId: string, data: Record<string, unknown>): PrivacyRequestListItem {
    return Object.freeze({
      requestId,
      right: data.right as PrivacyRequestRight,
      channel: data.channel as PrivacyRequestChannel,
      status: data.status as PrivacyRequestStatus,
      outcome: (data.outcome ?? null) as PrivacyRequestOutcome | null,
      receivedAt: asTimestamp(data.receivedAt, "privacy_received_at").toDate().toISOString(),
      deadlineAt: asTimestamp(data.deadlineAt, "privacy_deadline").toDate().toISOString(),
      deliveredAt: data.deliveredAt ? asTimestamp(data.deliveredAt, "privacy_delivered_at").toDate().toISOString() : null,
      extendedAt: data.extendedAt ? asTimestamp(data.extendedAt, "privacy_extended_at").toDate().toISOString() : null,
      revision: Number(data.revision),
    });
  }

  private async responseFor(requestId: string, data: Record<string, unknown>): Promise<PrivacyRequestResponse> {
    let response: string | null = null;
    let responseAvailableUntil: string | null = null;
    let extensionReason: string | null = null;
    if (data.extendedAt) {
      const secret = await this.secretRef(requestId).get();
      if (secret.exists && this.secretIsLive(asRecord(secret.data(), "privacy_request_secret"), data)) extensionReason = this.decryptOptional(asRecord(secret.data(), "privacy_request_secret").extensionReason);
    }
    if (data.deliveredAt && data.responseExpiresAt && ["fulfilled", "partially_fulfilled", "refused", "closed"].includes(String(data.status))) {
      const expiry = asTimestamp(data.responseExpiresAt, "privacy_response_expiry");
      responseAvailableUntil = expiry.toDate().toISOString();
      if (expiry.toMillis() > Date.now()) {
        const artifact = await this.responseRef(requestId).get();
        if (artifact.exists) {
          const metadata = asRecord(artifact.data(), "privacy_response_artifact");
          const chunkCount = Number(metadata.chunkCount);
          if (Number.isSafeInteger(chunkCount) && chunkCount > 0 && chunkCount <= 100) {
            const chunks = await Promise.all(Array.from({ length: chunkCount }, (_, index) => this.responseChunkRef(requestId, index).get()));
            if (chunks.every((chunk) => chunk.exists)) response = chunks.map((chunk) => this.decrypt(asRecord(asRecord(chunk.data(), "privacy_response_chunk").payload, "privacy_response_payload"))).join("");
          }
        }
      }
    }
    return Object.freeze({ request: this.toListItem(requestId, data), response, responseAvailableUntil, extensionReason, complaintInformationIncluded: data.complaintInformationIncluded === true });
  }

  private decryptOptional(value: unknown): string | null {
    if (!value || typeof value !== "object") return null;
    try {
      return this.decrypt(asRecord(value, "privacy_request_encrypted_value"));
    } catch {
      return null;
    }
  }

  private async consumePublicRateLimit(subject: string, now: Date): Promise<void> {
    const key = this.subjectPseudonym(`privacy-intake:${subject}`);
    const ref = this.db.collection(COLLECTIONS.privacyRequestRateLimits).doc(key);
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const data = snapshot.exists ? asRecord(snapshot.data(), "privacy_rate_limit") : {};
      const startedAt = data.windowStartedAt ? asTimestamp(data.windowStartedAt, "privacy_rate_limit_start").toMillis() : 0;
      const inWindow = now.getTime() - startedAt < PUBLIC_RATE_LIMIT_WINDOW_MS;
      const count = inWindow ? Number(data.count) + 1 : 1;
      if (count > PUBLIC_RATE_LIMIT_MAX) throw new Error("privacy_request_rate_limited");
      transaction.set(ref, { count, windowStartedAt: Timestamp.fromMillis(inWindow ? startedAt : now.getTime()), expiresAt: Timestamp.fromMillis((inWindow ? startedAt : now.getTime()) + PUBLIC_RATE_LIMIT_WINDOW_MS), updatedAt: Timestamp.fromDate(now) }, { merge: true });
    });
  }

  private async recordReadAudit(requestId: string, actor: string, authorization?: Readonly<{ userId: string; expectedAuthorizationGeneration: number }>): Promise<void> {
    const at = new Date();
    await this.db.runTransaction(async (transaction) => {
      if (authorization !== undefined) {
        const user = await transaction.get(this.db.collection(COLLECTIONS.users).doc(authorization.userId));
        if (!user.exists) throw new Error("account_deleted");
        assertExpectedAuthorizationGeneration(asRecord(user.data(), "user"), authorization.expectedAuthorizationGeneration);
      }
      const request = await transaction.get(this.requestRef(requestId));
      if (!request.exists || !this.isUnexpired(asRecord(request.data(), "privacy_request"))) throw new Error("privacy_request_not_found");
      this.audit(transaction, requestId, actor, "response_read", "response_artifact_read", at, this.auditExpiry(asRecord(request.data(), "privacy_request")));
    });
  }

  private async alignAuditRetentionWithClosure(requestId: string): Promise<void> {
    const snapshot = await this.requestRef(requestId).collection(COLLECTIONS.privacyRequestAudit).get();
    if (snapshot.empty) return;
    const request = await this.requestRef(requestId).get();
    if (!request.exists) return;
    const closedAt = asRecord(request.data(), "privacy_request").closedAt;
    const expiresAt = closedAt ? Timestamp.fromDate(addUtcCalendarMonths(asTimestamp(closedAt, "privacy_closed_at").toDate(), AUDIT_RETENTION_MONTHS)) : null;
    const batch = this.db.batch();
    for (const document of snapshot.docs) batch.set(document.ref, { expiresAt }, { merge: true });
    await batch.commit();
  }

  private isUnexpired(data: Record<string, unknown>): boolean {
    return archiveIsLive(data, AUDIT_RETENTION_MONTHS);
  }

  private auditExpiry(data: Record<string, unknown>): Timestamp | null {
    return data.closedAt instanceof Timestamp ? Timestamp.fromDate(addUtcCalendarMonths(data.closedAt.toDate(), AUDIT_RETENTION_MONTHS)) : null;
  }

  private secretIsLive(secret: Record<string, unknown>, data: Record<string, unknown>): boolean {
    const expiry = secret.expiresAt instanceof Timestamp ? secret.expiresAt.toMillis() : Number.POSITIVE_INFINITY;
    const cap = data.closedAt instanceof Timestamp ? data.closedAt.toMillis() + RESPONSE_TTL_MS : Number.POSITIVE_INFINITY;
    return Math.min(expiry, cap) > Date.now();
  }

  private reviewAt(data: Record<string, unknown>): string | null {
    if (data.status === "closed") return null;
    const dates: number[] = [];
    if (data.nextReviewAt instanceof Timestamp) dates.push(data.nextReviewAt.toMillis());
    const unverified = data.nextReviewAt instanceof Timestamp ? null : defaultUnverifiedReviewAt(data); if (unverified) dates.push(unverified.getTime());
    const delivery = this.deliveryReviewAt(data); if (delivery) dates.push(delivery.getTime());
    return dates.length ? new Date(Math.min(...dates)).toISOString() : null;
  }

  private deliveryReviewAt(data: Record<string, unknown>): Date | null {
    if (data.status === "closed") return null;
    const attempts: unknown[] = [];
    if (["failed", "unknown", "pending"].includes(String(data.extensionNoticeStatus))) attempts.push(data.extensionNoticeFailureAt ?? data.extensionNoticeAttemptedAt ?? data.updatedAt ?? data.receivedAt);
    if (typeof data.deliveryFailure === "string" || typeof data.deliveryAttemptId === "string" || ["failed", "unknown", "pending"].includes(String(data.deliveryStatus))) attempts.push(data.deliveryFailureAt ?? data.deliveryAttemptedAt ?? data.updatedAt ?? data.receivedAt);
    const pending = attempts.filter((at): at is Timestamp => at instanceof Timestamp && (!(data.deliveryReviewAcknowledgedAt instanceof Timestamp) || data.deliveryReviewAcknowledgedAt.toMillis() < at.toMillis()));
    return pending.length ? nextWorkingReviewAt(new Date(Math.min(...pending.map((at) => at.toMillis())))) : null;
  }

  private reviewReason(data: Record<string, unknown>): string | null {
    return this.deliveryReviewAt(data) ? "delivery_outcome_requires_inspection" : typeof data.reviewReason === "string" ? data.reviewReason : !data.subjectVerifiedAt && data.channel === "public" ? "identity_verification_pending" : null;
  }

  private audit(transaction: Transaction, requestId: string, actor: string, event: string, reasonCode: string, at: Date, expiresAt: Timestamp | null = null): void {
    transaction.create(this.requestRef(requestId).collection(COLLECTIONS.privacyRequestAudit).doc(), {
      event, actorPseudonym: actor, reasonCode, occurredAt: Timestamp.fromDate(at), expiresAt,
    });
  }

  private writeResponseArtifact(transaction: Transaction, requestId: string, value: string, createdAt: Date): void {
    const chunks: string[] = [];
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(value.length, offset + RESPONSE_CHUNK_CHARACTERS);
      if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "")) end -= 1;
      chunks.push(value.slice(offset, end));
      offset = end;
    }
    transaction.set(this.responseRef(requestId), { chunkCount: chunks.length, createdAt: Timestamp.fromDate(createdAt) });
    chunks.forEach((chunk, index) => transaction.set(this.responseChunkRef(requestId, index), { requestId, index, payload: this.encrypt(chunk), createdAt: Timestamp.fromDate(createdAt) }));
  }

  private async setChunkExpiry(transaction: Transaction, requestId: string, expiresAt: Date): Promise<void> {
    const metadata = await transaction.get(this.responseRef(requestId));
    if (!metadata.exists) throw new Error("privacy_response_artifact_missing");
    const chunkCount = Number(asRecord(metadata.data(), "privacy_response_artifact").chunkCount);
    if (!Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > 100) throw new Error("privacy_response_artifact_invalid");
    for (let index = 0; index < chunkCount; index += 1) transaction.set(this.responseChunkRef(requestId, index), { expiresAt: Timestamp.fromDate(expiresAt) }, { merge: true });
  }

  private encrypt(value: string): EncryptedValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Object.freeze({ ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") });
  }

  private decrypt(value: Record<string, unknown>): string {
    if (typeof value.ciphertext !== "string" || typeof value.iv !== "string" || typeof value.tag !== "string") throw new Error("privacy_encrypted_value_invalid");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(value.iv, "base64"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }

  private hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
  private subjectPseudonym(value: string): string { return createHmac("sha256", this.auditHmacSecret).update(value, "utf8").digest("hex"); }
  private actorPseudonym(value: string): string { return this.subjectPseudonym(`actor:${value}`); }
  private requestRef(requestId: string) { return this.db.collection(COLLECTIONS.privacyRequests).doc(requestId); }
  private secretRef(requestId: string) { return this.db.collection(COLLECTIONS.privacyRequestSecrets).doc(requestId); }
  private responseRef(requestId: string) { return this.db.collection(COLLECTIONS.privacyResponseArtifacts).doc(requestId); }
  private responseChunkRef(requestId: string, index: number) { return this.db.collection(COLLECTIONS.privacyResponseChunks).doc(`${requestId}_${String(index).padStart(3, "0")}`); }
}
