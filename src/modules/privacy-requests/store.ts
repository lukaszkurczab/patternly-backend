import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { Timestamp, type Firestore, type Transaction } from "firebase-admin/firestore";
import { COLLECTIONS } from "../../infrastructure/firestore/paths.js";
import { asRecord, asTimestamp } from "../../infrastructure/firestore/values.js";
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
const RESPONSE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const AUDIT_TTL_MS = 3 * 365 * 24 * 60 * 60 * 1_000;
const PUBLIC_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1_000;
const PUBLIC_RATE_LIMIT_MAX = 5;
const LIST_LIMIT = 100;
const RESPONSE_CHUNK_CHARACTERS = 150_000;

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

export type PrivacyRequestDetails = PrivacyRequestListItem & Readonly<{
  narrative: string | null;
  reportSubmissionIds: readonly string[];
  reason: string | null;
  executionEvidence: string | null;
  responseAvailableUntil: string | null;
  subjectVerified: boolean;
  extensionNoticeStatus: "available_in_app" | "pending" | "delivered" | "failed" | null;
}>;

export type PrivacyRequestResponse = Readonly<{
  request: PrivacyRequestListItem;
  response: string | null;
  responseAvailableUntil: string | null;
  extensionReason: string | null;
  complaintInformationIncluded: boolean;
}>;

export interface PrivacyRequestEmailSender {
  send(input: Readonly<{ recipient: string; purpose: "verify" | "response" | "extension"; requestId: string; link: string; extensionReason?: string }>): Promise<void>;
}

export interface PrivacyRequestStore {
  createAccount(userId: string, right: PrivacyRequestRight, narrative?: string): Promise<PrivacyRequestListItem>;
  createPublic(input: Readonly<{ email: string; right: PrivacyRequestRight; narrative?: string; reportSubmissionIds: readonly string[]; rateLimitKey: string }>, origin: string, sender: PrivacyRequestEmailSender): Promise<void>;
  exchangePublicToken(requestId: string, token: string): Promise<Readonly<{ sessionToken: string }>>;
  listAccount(userId: string): Promise<readonly PrivacyRequestListItem[]>;
  readAccount(userId: string, requestId: string): Promise<PrivacyRequestResponse | null>;
  readPublic(requestId: string, sessionToken: string): Promise<PrivacyRequestResponse | null>;
  listAdmin(): Promise<readonly PrivacyRequestListItem[]>;
  readAdmin(requestId: string, actorId: string): Promise<PrivacyRequestDetails | null>;
  readExecutionContext(requestId: string): Promise<Readonly<{ channel: PrivacyRequestChannel; right: PrivacyRequestRight; status: PrivacyRequestStatus; revision: number; userId: string | null }> | null>;
  prepareExecutedResponse(requestId: string, actorId: string, expectedRevision: number, response: string, executionEvidence: string): Promise<PrivacyRequestDetails>;
  transitionAdmin(requestId: string, actorId: string, action: PrivacyRequestAdminAction, origin: string, sender: PrivacyRequestEmailSender | null): Promise<PrivacyRequestDetails>;
}

export class FirestorePrivacyRequestStore implements PrivacyRequestStore {
  private readonly key: Buffer;
  public constructor(private readonly db: Firestore, encryptionKeyBase64: string, private readonly auditHmacSecret: string) {
    this.key = Buffer.from(encryptionKeyBase64, "base64");
    if (this.key.length !== 32) throw new Error("privacy_response_key_invalid");
    if (Buffer.byteLength(auditHmacSecret, "utf8") < 32) throw new Error("privacy_audit_hmac_secret_invalid");
  }

  public async createAccount(userId: string, right: PrivacyRequestRight, narrative?: string): Promise<PrivacyRequestListItem> {
    const receivedAt = new Date();
    const requestId = `pr_${randomUUID()}`;
    const record = this.initialRecord(requestId, "account", right, receivedAt, this.subjectPseudonym(`account:${userId}`), userId);
    await this.db.runTransaction(async (transaction) => {
      transaction.create(this.requestRef(requestId), record);
      transaction.create(this.secretRef(requestId), { payload: this.encrypt(JSON.stringify({ narrative: narrative ?? null, reportSubmissionIds: [] })), expiresAt: Timestamp.fromMillis(receivedAt.getTime() + AUDIT_TTL_MS) });
      this.audit(transaction, requestId, "subject", "received", "request_received", receivedAt);
    });
    return this.toListItem(requestId, record);
  }

  public async createPublic(input: Readonly<{ email: string; right: PrivacyRequestRight; narrative?: string; reportSubmissionIds: readonly string[]; rateLimitKey: string }>, origin: string, sender: PrivacyRequestEmailSender): Promise<void> {
    const email = input.email.trim().toLowerCase();
    const receivedAt = new Date();
    await Promise.all([this.consumePublicRateLimit(`email:${email}`, receivedAt), this.consumePublicRateLimit(`client:${input.rateLimitKey}`, receivedAt)]);
    const requestId = `pr_${randomUUID()}`;
    const token = randomBytes(32).toString("base64url");
    const record = this.initialRecord(requestId, "public", input.right, receivedAt, this.subjectPseudonym(`email:${email}`), null);
    const secretPayload = { email, narrative: input.narrative ?? null, reportSubmissionIds: [...input.reportSubmissionIds] };
    await this.db.runTransaction(async (transaction) => {
      transaction.create(this.requestRef(requestId), { ...record, status: "identity_verification_required", verificationTokenHash: this.hash(token), verificationExpiresAt: Timestamp.fromMillis(receivedAt.getTime() + VERIFICATION_TTL_MS) });
      transaction.create(this.secretRef(requestId), { payload: this.encrypt(JSON.stringify(secretPayload)), expiresAt: Timestamp.fromMillis(receivedAt.getTime() + AUDIT_TTL_MS) });
      this.audit(transaction, requestId, "subject", "received", "public_request_received", receivedAt);
      this.audit(transaction, requestId, "system", "identity_verification_required", "email_possession_verification_required", receivedAt);
    });
    const link = `${origin.replace(/\/$/u, "")}/privacy-request/${encodeURIComponent(requestId)}#token=${encodeURIComponent(token)}`;
    try {
      await sender.send({ recipient: email, purpose: "verify", requestId, link });
    } catch {
      await this.requestRef(requestId).set({ deliveryFailure: "verification_email_failed", updatedAt: Timestamp.now() }, { merge: true });
      throw new Error("privacy_email_unavailable");
    }
  }

  public async exchangePublicToken(requestId: string, token: string): Promise<Readonly<{ sessionToken: string }>> {
    const sessionToken = randomBytes(32).toString("base64url");
    await this.db.runTransaction(async (transaction) => {
      const ref = this.requestRef(requestId);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("privacy_request_token_invalid");
      const data = asRecord(snapshot.data(), "privacy_request");
      const tokenHash = typeof data.verificationTokenHash === "string" ? data.verificationTokenHash : "";
      const expiresAt = asTimestamp(data.verificationExpiresAt, "privacy_verification_expiry").toMillis();
      if (!tokenHash || tokenHash !== this.hash(token) || expiresAt <= Date.now()) throw new Error("privacy_request_token_invalid");
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
    const snapshot = await this.db.collection(COLLECTIONS.privacyRequests).where("userId", "==", userId).orderBy("receivedAt", "desc").limit(LIST_LIMIT).get();
    return Object.freeze(snapshot.docs.map((document) => this.toListItem(document.id, asRecord(document.data(), "privacy_request"))));
  }

  public async readAccount(userId: string, requestId: string): Promise<PrivacyRequestResponse | null> {
    const snapshot = await this.requestRef(requestId).get();
    if (!snapshot.exists) return null;
    const data = asRecord(snapshot.data(), "privacy_request");
    if (data.userId !== userId || data.channel !== "account") return null;
    const response = await this.responseFor(requestId, data);
    if (response.response !== null) await this.recordReadAudit(requestId, this.subjectPseudonym(`account:${userId}`));
    return response;
  }

  public async readPublic(requestId: string, sessionToken: string): Promise<PrivacyRequestResponse | null> {
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
    const snapshot = await this.db.collection(COLLECTIONS.privacyRequests).orderBy("deadlineAt", "asc").limit(LIST_LIMIT).get();
    return Object.freeze(snapshot.docs.map((document) => this.toListItem(document.id, asRecord(document.data(), "privacy_request"))));
  }

  public async readAdmin(requestId: string, actorId: string): Promise<PrivacyRequestDetails | null> {
    const [requestSnapshot, secretSnapshot] = await Promise.all([this.requestRef(requestId).get(), this.secretRef(requestId).get()]);
    if (!requestSnapshot.exists || !secretSnapshot.exists) return null;
    const now = new Date();
    await this.db.runTransaction(async (transaction) => this.audit(transaction, requestId, this.actorPseudonym(actorId), "details_read", "operator_details_read", now));
    const data = asRecord(requestSnapshot.data(), "privacy_request");
    const secret = asRecord(secretSnapshot.data(), "privacy_request_secret");
    const decrypted = JSON.parse(this.decrypt(asRecord(secret.payload, "privacy_request_secret_payload"))) as { narrative?: unknown; reportSubmissionIds?: unknown };
    const extensionReason = this.decryptOptional(secret.extensionReason);
    return Object.freeze({
      ...this.toListItem(requestId, data),
      narrative: typeof decrypted.narrative === "string" ? decrypted.narrative : null,
      reportSubmissionIds: Object.freeze(Array.isArray(decrypted.reportSubmissionIds) ? decrypted.reportSubmissionIds.filter((value): value is string => typeof value === "string") : []),
      reason: typeof data.reason === "string" ? data.reason : extensionReason,
      executionEvidence: typeof data.executionEvidence === "string" ? data.executionEvidence : null,
      responseAvailableUntil: data.responseExpiresAt ? asTimestamp(data.responseExpiresAt, "privacy_response_expiry").toDate().toISOString() : null,
      subjectVerified: data.channel === "account" || Boolean(data.subjectVerifiedAt),
      extensionNoticeStatus: data.extensionNoticeStatus === "available_in_app" || data.extensionNoticeStatus === "pending" || data.extensionNoticeStatus === "delivered" || data.extensionNoticeStatus === "failed" ? data.extensionNoticeStatus : null,
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

  public async transitionAdmin(requestId: string, actorId: string, action: PrivacyRequestAdminAction, origin: string, sender: PrivacyRequestEmailSender | null): Promise<PrivacyRequestDetails> {
    if (action.action === "execute_export") throw new Error("privacy_request_executor_required");
    if (action.action === "retry_extension_notice") {
      await this.notifyPublicExtension(requestId, actorId, action.expectedRevision, origin, sender);
      const retried = await this.readAdmin(requestId, actorId);
      if (!retried) throw new Error("privacy_request_not_found");
      return retried;
    }
    if (action.action === "deliver") {
      const current = await this.requestRef(requestId).get();
      if (!current.exists) throw new Error("privacy_request_not_found");
      if (asRecord(current.data(), "privacy_request").channel === "public") return this.deliverPublic(requestId, actorId, action.expectedRevision, origin, sender);
    }
    await this.db.runTransaction(async (transaction) => {
      const ref = this.requestRef(requestId);
      const [snapshot, secretSnapshot] = action.action === "extend"
        ? await transaction.getAll(ref, this.secretRef(requestId))
        : [await transaction.get(ref), null];
      if (!snapshot.exists) throw new Error("privacy_request_not_found");
      if (action.action === "extend" && !secretSnapshot?.exists) throw new Error("privacy_request_not_found");
      const data = asRecord(snapshot.data(), "privacy_request");
      if (Number(data.revision) !== action.expectedRevision) throw new Error("privacy_request_revision_conflict");
      if (action.action === "start_review" && data.channel === "public" && !data.subjectVerifiedAt) throw new Error("privacy_request_subject_unverified");
      if (action.action === "verify_subject" && (data.channel !== "public" || !data.emailPossessionVerifiedAt)) throw new Error("privacy_request_subject_unverified");
      if (action.action === "prepare_response" && action.outcome !== "refused") throw new Error("privacy_request_executor_required");
      const current = this.toTransitionSnapshot(data);
      const now = new Date();
      const next = transitionPrivacyRequest(current, action, now);
      const update: Record<string, unknown> = {
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
        update.expiresAt = Timestamp.fromMillis(now.getTime() + AUDIT_TTL_MS);
        update.verificationTokenHash = null;
        update.verificationExpiresAt = null;
        update.publicSessionHash = null;
        update.publicSessionExpiresAt = null;
        update.deliveryAttemptId = null;
        transaction.set(this.secretRef(requestId), { expiresAt: Timestamp.fromMillis(now.getTime() + RESPONSE_TTL_MS) }, { merge: true });
      }
      transaction.set(ref, update, { merge: true });
      this.audit(transaction, requestId, this.actorPseudonym(actorId), action.action, action.action === "prepare_response" ? "operator_refusal_decision" : "state_transition", now);
    });
    if (action.action === "extend") {
      const current = await this.requestRef(requestId).get();
      if (current.exists && asRecord(current.data(), "privacy_request").channel === "public") await this.notifyPublicExtension(requestId, actorId, action.expectedRevision + 1, origin, sender);
    }
    if (action.action === "close") await this.alignAuditRetentionWithClosure(requestId);
    const details = await this.readAdmin(requestId, actorId);
    if (!details) throw new Error("privacy_request_not_found");
    return details;
  }

  private async deliverPublic(requestId: string, actorId: string, expectedRevision: number, origin: string, sender: PrivacyRequestEmailSender | null): Promise<PrivacyRequestDetails> {
    if (!sender || !origin) throw new Error("privacy_email_unavailable");
    const token = randomBytes(32).toString("base64url");
    const attemptId = randomUUID();
    let email = "";
    await this.db.runTransaction(async (transaction) => {
      const [requestSnapshot, secretSnapshot] = await transaction.getAll(this.requestRef(requestId), this.secretRef(requestId));
      if (!requestSnapshot?.exists || !secretSnapshot?.exists) throw new Error("privacy_request_not_found");
      const data = asRecord(requestSnapshot.data(), "privacy_request");
      if (Number(data.revision) !== expectedRevision) throw new Error("privacy_request_revision_conflict");
      transitionPrivacyRequest(this.toTransitionSnapshot(data), { action: "deliver", expectedRevision }, new Date());
      const secret = asRecord(secretSnapshot.data(), "privacy_request_secret");
      const decrypted = JSON.parse(this.decrypt(asRecord(secret.payload, "privacy_request_secret_payload"))) as { email?: unknown };
      if (typeof decrypted.email !== "string") throw new Error("privacy_request_invalid");
      email = decrypted.email;
      const now = new Date();
      transaction.set(this.requestRef(requestId), {
        deliveryAttemptId: attemptId,
        deliveryFailure: null,
        verificationTokenHash: this.hash(token),
        verificationExpiresAt: Timestamp.fromMillis(now.getTime() + VERIFICATION_TTL_MS),
        revision: expectedRevision + 1,
        updatedAt: Timestamp.fromDate(now),
      }, { merge: true });
      this.audit(transaction, requestId, this.actorPseudonym(actorId), "delivery_staged", "response_delivery_staged", now);
    });
    const link = `${origin.replace(/\/$/u, "")}/privacy-request/${encodeURIComponent(requestId)}#token=${encodeURIComponent(token)}`;
    try {
      await sender.send({ recipient: email, purpose: "response", requestId, link });
    } catch {
      await this.requestRef(requestId).set({ deliveryFailure: "response_email_failed", updatedAt: Timestamp.now() }, { merge: true });
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

  private async notifyPublicExtension(requestId: string, actorId: string, expectedRevision: number, origin: string, sender: PrivacyRequestEmailSender | null): Promise<void> {
    if (!sender || !origin) throw new Error("privacy_email_unavailable");
    const token = randomBytes(32).toString("base64url");
    const [requestSnapshot, secretSnapshot] = await Promise.all([this.requestRef(requestId).get(), this.secretRef(requestId).get()]);
    if (!requestSnapshot.exists || !secretSnapshot.exists) throw new Error("privacy_request_not_found");
    const requestData = asRecord(requestSnapshot.data(), "privacy_request");
    if (Number(requestData.revision) !== expectedRevision) throw new Error("privacy_request_revision_conflict");
    if (!requestData.extendedAt || (requestData.extensionNoticeStatus !== "pending" && requestData.extensionNoticeStatus !== "failed")) throw new Error("privacy_request_transition_invalid");
    const secret = asRecord(secretSnapshot.data(), "privacy_request_secret");
    const decrypted = JSON.parse(this.decrypt(asRecord(secret.payload, "privacy_request_secret_payload"))) as { email?: unknown };
    const extensionReason = this.decryptOptional(secret.extensionReason);
    if (typeof decrypted.email !== "string") throw new Error("privacy_request_invalid");
    if (!extensionReason) throw new Error("privacy_request_invalid");
    const now = new Date();
    await this.requestRef(requestId).set({ verificationTokenHash: this.hash(token), verificationExpiresAt: Timestamp.fromMillis(now.getTime() + VERIFICATION_TTL_MS), extensionNoticeAttemptedAt: Timestamp.fromDate(now), extensionNoticeStatus: "pending" }, { merge: true });
    const link = `${origin.replace(/\/$/u, "")}/privacy-request/${encodeURIComponent(requestId)}#token=${encodeURIComponent(token)}`;
    try {
      await sender.send({ recipient: decrypted.email, purpose: "extension", requestId, link, extensionReason });
    } catch {
      await this.requestRef(requestId).set({ extensionNoticeStatus: "failed", updatedAt: Timestamp.now() }, { merge: true });
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
      if (secret.exists) extensionReason = this.decryptOptional(asRecord(secret.data(), "privacy_request_secret").extensionReason);
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
    const key = this.hash(`privacy-intake:${subject}`);
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

  private async recordReadAudit(requestId: string, actor: string): Promise<void> {
    const at = new Date();
    await this.db.runTransaction(async (transaction) => this.audit(transaction, requestId, actor, "response_read", "response_artifact_read", at));
  }

  private async alignAuditRetentionWithClosure(requestId: string): Promise<void> {
    const snapshot = await this.requestRef(requestId).collection(COLLECTIONS.privacyRequestAudit).get();
    if (snapshot.empty) return;
    const expiresAt = Timestamp.fromMillis(Date.now() + AUDIT_TTL_MS);
    const batch = this.db.batch();
    for (const document of snapshot.docs) batch.set(document.ref, { expiresAt }, { merge: true });
    await batch.commit();
  }

  private audit(transaction: Transaction, requestId: string, actor: string, event: string, reasonCode: string, at: Date): void {
    transaction.create(this.requestRef(requestId).collection(COLLECTIONS.privacyRequestAudit).doc(), {
      event, actorPseudonym: actor, reasonCode, occurredAt: Timestamp.fromDate(at), expiresAt: Timestamp.fromMillis(at.getTime() + AUDIT_TTL_MS),
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
