import { createHash, createHmac, randomUUID } from "node:crypto";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { asRecord, asTimestamp } from "../../infrastructure/firestore/values.js";
import { complaintResponseDueAt, retentionUntilFromClosure, type LegalRequestAdminAction, type LegalRequestKind, type LegalRequestStatus } from "./contracts.js";

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
  revision: number;
}>;
export type LegalRequestDetails = LegalRequestItem & Readonly<{ email: string; narrative: string | null; transactionId: string | null }>;

export interface LegalRequestEmailSender {
  send(input: Readonly<{ recipient: string; purpose: "received" | "answered"; requestId: string; kind: LegalRequestKind; response?: string }>): Promise<void>;
}

export interface LegalRequestStore {
  create(input: Readonly<{ userId: string | null; email: string; kind: LegalRequestKind; narrative?: string; transactionId?: string }>, sender: LegalRequestEmailSender): Promise<LegalRequestItem>;
  listAccount(userId: string): Promise<readonly LegalRequestItem[]>;
  readAccount(userId: string, requestId: string): Promise<LegalRequestItem | null>;
  listAdmin(): Promise<readonly LegalRequestItem[]>;
  readAdmin(requestId: string, actorId: string): Promise<LegalRequestDetails | null>;
  transitionAdmin(requestId: string, actorId: string, action: LegalRequestAdminAction, sender: LegalRequestEmailSender): Promise<LegalRequestItem>;
}

export class FirestoreLegalRequestStore implements LegalRequestStore {
  public constructor(private readonly db: Firestore, private readonly auditHmacSecret: string) {
    if (Buffer.byteLength(auditHmacSecret, "utf8") < 32) throw new Error("legal_request_audit_hmac_secret_invalid");
  }

  public async create(input: Readonly<{ userId: string | null; email: string; kind: LegalRequestKind; narrative?: string; transactionId?: string }>, sender: LegalRequestEmailSender): Promise<LegalRequestItem> {
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
    if (input.userId === null) await this.claimPublicRateLimit(email, receivedAt);
    await this.db.collection("legalRequests").doc(requestId).create(record);
    try {
      await sender.send({ recipient: email, purpose: "received", requestId, kind: input.kind });
      await this.db.collection("legalRequests").doc(requestId).set({ confirmationStatus: "sent", confirmationSentAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    } catch {
      await this.db.collection("legalRequests").doc(requestId).set({ confirmationStatus: "failed", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      throw new Error("legal_request_email_unavailable");
    }
    return this.read(requestId, record);
  }

  public async listAccount(userId: string): Promise<readonly LegalRequestItem[]> {
    const snapshot = await this.db.collection("legalRequests").where("userId", "==", userId).limit(100).get();
    return Object.freeze(snapshot.docs.map((document) => this.read(document.id, asRecord(document.data(), "legal_request"))).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)));
  }

  public async readAccount(userId: string, requestId: string): Promise<LegalRequestItem | null> {
    const snapshot = await this.db.collection("legalRequests").doc(requestId).get();
    if (!snapshot.exists || snapshot.get("userId") !== userId) return null;
    return this.read(requestId, asRecord(snapshot.data(), "legal_request"));
  }

  public async listAdmin(): Promise<readonly LegalRequestItem[]> {
    const snapshot = await this.db.collection("legalRequests").limit(100).get();
    return Object.freeze(snapshot.docs.map((document) => this.read(document.id, asRecord(document.data(), "legal_request"))).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)));
  }

  public async readAdmin(requestId: string, actorId: string): Promise<LegalRequestDetails | null> {
    const ref = this.db.collection("legalRequests").doc(requestId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return null;
    const data = asRecord(snapshot.data(), "legal_request");
    const occurredAt = new Date();
    await ref.collection("audit").doc().create({ action: "details_read", actorPseudonym: this.actorPseudonym(actorId), occurredAt: Timestamp.fromDate(occurredAt), expiresAt: data.expiresAt ?? null });
    return Object.freeze({ ...this.read(requestId, data), email: String(data.email), narrative: typeof data.narrative === "string" ? data.narrative : null, transactionId: typeof data.transactionId === "string" ? data.transactionId : null });
  }

  public async transitionAdmin(requestId: string, actorId: string, action: LegalRequestAdminAction, sender: LegalRequestEmailSender): Promise<LegalRequestItem> {
    const ref = this.db.collection("legalRequests").doc(requestId);
    let recipient = "";
    let kind: LegalRequestKind = "complaint";
    let response: string | undefined;
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("legal_request_not_found");
      const data = asRecord(snapshot.data(), "legal_request");
      if (Number(data.revision) !== action.expectedRevision) throw new Error("legal_request_revision_conflict");
      const status = data.status as LegalRequestStatus;
      const now = new Date();
      const actorPseudonym = this.actorPseudonym(actorId);
      const update: Record<string, unknown> = { revision: action.expectedRevision + 1, updatedAt: Timestamp.fromDate(now), lastActorPseudonym: actorPseudonym };
      if (action.action === "start_review") {
        if (status !== "received") throw new Error("legal_request_transition_invalid");
        update.status = "in_review";
      } else if (action.action === "answer") {
        if (status !== "received" && status !== "in_review") throw new Error("legal_request_transition_invalid");
        update.pendingResponse = action.response; update.answerDeliveryStatus = "pending";
        recipient = String(data.email); kind = data.kind as LegalRequestKind; response = action.response;
      } else if (action.action === "close") {
        if (status !== "answered") throw new Error("legal_request_transition_invalid");
        const retentionUntil = retentionUntilFromClosure(now);
        update.status = "closed"; update.closedAt = Timestamp.fromDate(now); update.retentionUntil = Timestamp.fromDate(retentionUntil);
        if (data.legalHold !== true) update.expiresAt = Timestamp.fromDate(retentionUntil);
      } else {
        update.legalHold = action.active; update.legalHoldReason = action.reason;
        update.expiresAt = action.active ? null : (data.retentionUntil ?? null);
      }
      transaction.set(ref, update, { merge: true });
      transaction.create(ref.collection("audit").doc(), { action: action.action, actorPseudonym, occurredAt: Timestamp.fromDate(now), expiresAt: update.expiresAt ?? data.expiresAt ?? null });
    });
    if (action.action === "answer" && response) {
      try {
        await sender.send({ recipient, purpose: "answered", requestId, kind, response });
        await this.db.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(ref);
          if (!snapshot.exists) throw new Error("legal_request_not_found");
          const data = asRecord(snapshot.data(), "legal_request");
          if (data.answerDeliveryStatus !== "pending" || data.pendingResponse !== response) throw new Error("legal_request_revision_conflict");
          const answeredAt = Timestamp.now();
          transaction.set(ref, { status: "answered", response, pendingResponse: FieldValue.delete(), answerDeliveryStatus: "sent", answerDeliveredAt: answeredAt, answeredAt, revision: Number(data.revision) + 1, updatedAt: answeredAt }, { merge: true });
          transaction.create(ref.collection("audit").doc(), { action: "answer_delivered", actorPseudonym: this.actorPseudonym(actorId), occurredAt: answeredAt, expiresAt: data.expiresAt ?? null });
        });
      } catch {
        await ref.set({ answerDeliveryStatus: "failed", pendingResponse: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        throw new Error("legal_request_email_unavailable");
      }
    }
    if (action.action === "close" || action.action === "set_legal_hold") await this.alignAuditExpiry(requestId);
    const snapshot = await ref.get();
    return this.read(requestId, asRecord(snapshot.data(), "legal_request"));
  }

  private actorPseudonym(actorId: string): string {
    return createHmac("sha256", this.auditHmacSecret).update(`legal-request-actor\0${actorId}`, "utf8").digest("base64url");
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
    const [request, audit] = await Promise.all([ref.get(), ref.collection("audit").get()]);
    if (!request.exists) return;
    const expiresAt = request.get("expiresAt") ?? null;
    const batch = this.db.batch();
    for (const document of audit.docs) batch.set(document.ref, { expiresAt }, { merge: true });
    await batch.commit();
  }

  private read(requestId: string, data: Record<string, unknown>): LegalRequestItem {
    return Object.freeze({
      requestId, kind: data.kind as LegalRequestKind, status: data.status as LegalRequestStatus,
      receivedAt: asTimestamp(data.receivedAt, "legal_request_received_at").toDate().toISOString(),
      responseDueAt: data.responseDueAt ? asTimestamp(data.responseDueAt, "legal_request_response_due_at").toDate().toISOString() : null,
      answeredAt: data.answeredAt ? asTimestamp(data.answeredAt, "legal_request_answered_at").toDate().toISOString() : null,
      retentionUntil: data.retentionUntil ? asTimestamp(data.retentionUntil, "legal_request_retention_until").toDate().toISOString() : null,
      response: typeof data.response === "string" ? data.response : null,
      legalHold: data.legalHold === true,
      revision: Number(data.revision),
    });
  }
}
