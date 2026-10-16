import { readOperatorPage, type OperatorPageOptions } from "../retention/operatorPage.js";
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { COLLECTIONS } from "../../infrastructure/firestore/paths.js";
import { asIsoString, asRecord, asTimestamp, now } from "../../infrastructure/firestore/values.js";
import { assertExpectedAuthorizationGeneration } from "../auth/authorizationGeneration.js";
import { RETENTION_POLICY } from "../retention/policy.js";
import { projectContentReportContext, type ContentReportStatus, type ContentReportStore, type ContentReportView, type CreateContentReport, type OperatorContentReportDetail, type OperatorContentReportItem } from "./contracts.js";

const REPORT_RETENTION_DAYS = RETENTION_POLICY.contentReportDays;

function toView(row: Record<string, unknown>): ContentReportView {
  if (typeof row.id !== "string" || typeof row.clientSubmissionId !== "string" || typeof row.trackId !== "string" || typeof row.contentVersion !== "string" || typeof row.itemId !== "string" || typeof row.reason !== "string" || typeof row.description !== "string" || typeof row.status !== "string" || typeof row.context !== "object" || row.context === null || Array.isArray(row.context)) throw new Error("content_report_record_invalid");
  const hasAccountLink = typeof row.accountId === "string";
  const hasContactLink = typeof row.contactEmail === "string";
  const linkage = hasAccountLink && hasContactLink ? "account_and_contact" : hasAccountLink ? "account" : hasContactLink ? "contact" : "unlinked";
  if (!["open", "in_review", "resolved", "closed"].includes(row.status)) throw new Error("content_report_status_invalid");
  const context = projectContentReportContext(row.context);
  return Object.freeze({
    id: row.id,
    clientSubmissionId: row.clientSubmissionId,
    trackId: row.trackId,
    contentVersion: row.contentVersion,
    itemId: row.itemId,
    reason: row.reason as CreateContentReport["reason"],
    description: row.description,
    context,
    linkage,
    status: row.status as ContentReportView["status"],
    createdAt: asIsoString(row.createdAt, "content_report_created_at"),
    updatedAt: asIsoString(row.updatedAt, "content_report_updated_at"),
  });
}

export class FirestoreContentReportStore implements ContentReportStore {
  public constructor(private readonly db: Firestore, private readonly options: Readonly<{ rateLimitHashSecret: string; rateLimitMax: number; rateLimitWindowSeconds: number }>) {}

  public async create(userId: string | undefined, expectedAuthorizationGeneration: number | undefined, input: CreateContentReport, context: Readonly<{ rateLimitKey: string }>): Promise<Readonly<{ report: ContentReportView; duplicate: boolean }>> {
    const reportRef = this.db.collection(COLLECTIONS.contentReports).doc(input.clientSubmissionId);
    const rateLimitRef = this.db.collection(COLLECTIONS.rateLimitBuckets).doc(this.rateLimitDocumentId(context.rateLimitKey));
    const reportId = randomUUID();
    const createdAt = now();
    const report = await this.db.runTransaction(async (transaction) => {
      if (userId !== undefined) {
        const user = await transaction.get(this.db.collection(COLLECTIONS.users).doc(userId));
        if (!user.exists) throw new Error("account_deleted");
        assertExpectedAuthorizationGeneration(asRecord(user.data(), "user"), expectedAuthorizationGeneration);
      }
      const [existingSnapshot, bucketSnapshot] = await transaction.getAll(reportRef, rateLimitRef);
      if (existingSnapshot?.exists) return { report: toView(asRecord(existingSnapshot.data(), "content_report")), duplicate: true };
      const bucket = bucketSnapshot?.exists ? asRecord(bucketSnapshot.data(), "report_rate_limit") : null;
      const bucketStart = bucket?.windowStartedAt instanceof Timestamp ? bucket.windowStartedAt : null;
      const bucketCount = typeof bucket?.count === "number" ? bucket.count : 0;
      const windowMillis = this.options.rateLimitWindowSeconds * 1_000;
      const withinWindow = bucketStart !== null && createdAt.toMillis() - bucketStart.toMillis() < windowMillis;
      if (withinWindow && bucketCount >= this.options.rateLimitMax) throw new Error("report_rate_limited");
      const nextCount = withinWindow ? bucketCount + 1 : 1;
      const nextWindowStart = withinWindow ? bucketStart : createdAt;
      const expiryMillis = createdAt.toMillis() + REPORT_RETENTION_DAYS * 86_400_000;
      transaction.set(rateLimitRef, { windowStartedAt: nextWindowStart, count: nextCount, expiresAt: Timestamp.fromMillis(createdAt.toMillis() + windowMillis) });
      transaction.create(reportRef, {
        id: reportId,
        clientSubmissionId: input.clientSubmissionId,
        trackId: input.trackId,
        contentVersion: input.contentVersion,
        itemId: input.itemId,
        reason: input.reason,
        description: input.description,
        context: input.context,
        status: "open",
        createdAt,
        updatedAt: createdAt,
        expiresAt: Timestamp.fromMillis(expiryMillis),
      });
      return { report: toView({ ...input, id: reportId, status: "open", createdAt, updatedAt: createdAt }), duplicate: false };
    });
    return Object.freeze(report);
  }

  public async listQueue(): Promise<readonly ContentReportView[]> {
    const rows = await this.db.collection(COLLECTIONS.contentReports).where("status", "in", ["open", "in_review", "resolved"]).get();
    return Object.freeze(rows.docs.filter((row) => !isExpired(asRecord(row.data(), "content_report"))).map((row) => toView(asRecord(row.data(), "content_report"))).sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  }

  public async listOperatorQueue(actorId: string, options?: OperatorPageOptions): Promise<Readonly<{ items: readonly OperatorContentReportItem[]; truncated: boolean; nextCursor: string | null }>> {
    const page = await readOperatorPage(this.db.collection(COLLECTIONS.contentReports), (data) => !isExpired(data) && (!options?.dueOnly || data.status !== "closed"), options);
    const selected = page.documents;
    const truncated = page.truncated;
    const at = now();
    if (selected.length > 0) {
      const batch = this.db.batch();
      for (const document of selected) {
        const data = asRecord(document.data(), "content_report");
        batch.create(document.ref.collection(COLLECTIONS.contentReportAudit).doc(randomUUID()), {
          event: "operator_queue_read",
          actorPseudonym: this.actorPseudonym(actorId),
          occurredAt: at,
          ...(data.expiresAt === undefined ? {} : { expiresAt: data.expiresAt }),
        });
      }
      await batch.commit();
    }
    return Object.freeze({
      items: Object.freeze(selected.map((document) => this.toOperatorItem(toView(asRecord(document.data(), "content_report"))))),
      truncated,
      nextCursor: page.nextCursor,
    });
  }

  public async readOperator(clientSubmissionId: string, actorId: string): Promise<OperatorContentReportDetail | null> {
    const ref = this.db.collection(COLLECTIONS.contentReports).doc(clientSubmissionId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return null;
    const data = asRecord(snapshot.data(), "content_report");
    if (isExpired(data)) return null;
    const report = toView(data);
    await ref.collection(COLLECTIONS.contentReportAudit).doc(randomUUID()).create({
      event: "operator_details_read",
      actorPseudonym: this.actorPseudonym(actorId),
      occurredAt: now(),
      ...(data.expiresAt === undefined ? {} : { expiresAt: data.expiresAt }),
    });
    return this.toOperatorDetail(report);
  }

  public async transitionStatus(clientSubmissionId: string, actorId: string, nextStatus: ContentReportStatus, expectedStatus?: ContentReportStatus): Promise<Readonly<{ report: ContentReportView; duplicate: boolean }>> {
    const reportRef = this.db.collection(COLLECTIONS.contentReports).doc(clientSubmissionId);
    const auditRef = reportRef.collection(COLLECTIONS.contentReportAudit).doc(randomUUID());
    const changedAt = now();
    return Object.freeze(await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reportRef);
      if (!snapshot.exists) throw new Error("content_report_not_found");
      const row = asRecord(snapshot.data(), "content_report");
      if (isExpired(row)) throw new Error("content_report_expired");
      const current = toView(row);
      const expiresAt = asTimestamp(row.expiresAt, "content_report_expiry");
      if (expectedStatus !== undefined && current.status !== expectedStatus) throw new Error("content_report_status_conflict");
      if (current.status === nextStatus) return { report: current, duplicate: true };
      if (!isAllowedTransition(current.status, nextStatus)) throw new Error("content_report_transition_invalid");
      transaction.update(reportRef, { status: nextStatus, updatedAt: changedAt });
      transaction.create(auditRef, { id: auditRef.id, fromStatus: current.status, toStatus: nextStatus, actorPseudonym: this.actorPseudonym(actorId), changedAt, expiresAt });
      return { report: toView({ ...row, status: nextStatus, updatedAt: changedAt }), duplicate: false };
    }));
  }

  private rateLimitDocumentId(rateLimitKey: string): string {
    return createHash("sha256").update(`${this.options.rateLimitHashSecret}:${rateLimitKey}`, "utf8").digest("hex");
  }

  private actorPseudonym(actorId: string): string {
    return createHmac("sha256", this.options.rateLimitHashSecret).update(`content-report-actor\0${actorId}`, "utf8").digest("base64url");
  }

  private toOperatorItem(report: ContentReportView): OperatorContentReportItem {
    return Object.freeze({
      clientSubmissionId: report.clientSubmissionId,
      trackId: report.trackId,
      contentVersion: report.contentVersion,
      itemId: report.itemId,
      reason: report.reason,
      status: report.status,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
    });
  }

  private toOperatorDetail(report: ContentReportView): OperatorContentReportDetail {
    return Object.freeze({
      clientSubmissionId: report.clientSubmissionId,
      trackId: report.trackId,
      contentVersion: report.contentVersion,
      itemId: report.itemId,
      reason: report.reason,
      description: report.description,
      context: report.context,
      linkage: report.linkage,
      status: report.status,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
    });
  }
}

function isAllowedTransition(current: ContentReportStatus, next: ContentReportStatus): boolean {
  return (current === "open" && next === "in_review") || (current === "in_review" && next === "resolved") || (current === "resolved" && next === "closed");
}

function isExpired(row: Record<string, unknown>): boolean {
  const providerExpiry = row.expiresAt instanceof Timestamp ? row.expiresAt.toMillis() : Number.POSITIVE_INFINITY;
  const createdAt = row.createdAt instanceof Timestamp ? row.createdAt.toMillis() : Number.NaN;
  const policyExpiry = Number.isFinite(createdAt) ? createdAt + REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1_000 : Number.POSITIVE_INFINITY;
  return Math.min(providerExpiry, policyExpiry) <= Date.now();
}
