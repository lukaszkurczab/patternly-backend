import { createHash, randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { COLLECTIONS } from "../../infrastructure/firestore/paths.js";
import { asIsoString, asRecord, asTimestamp, now } from "../../infrastructure/firestore/values.js";
import { projectContentReportContext, type ContentReportStatus, type ContentReportStore, type ContentReportView, type CreateContentReport } from "./contracts.js";

const REPORT_RETENTION_DAYS = 30;
const IDENTIFIABLE_RETENTION_DAYS = 180;

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

  public async create(userId: string | undefined, input: CreateContentReport, context: Readonly<{ rateLimitKey: string }>): Promise<Readonly<{ report: ContentReportView; duplicate: boolean }>> {
    if (input.linkAccount && !userId) throw new Error("account_link_requires_authentication");
    const reportRef = this.db.collection(COLLECTIONS.contentReports).doc(input.clientSubmissionId);
    const rateLimitRef = this.db.collection(COLLECTIONS.rateLimitBuckets).doc(this.rateLimitDocumentId(context.rateLimitKey));
    const reportId = randomUUID();
    const createdAt = now();
    const report = await this.db.runTransaction(async (transaction) => {
      if (userId !== undefined) {
        const user = await transaction.get(this.db.collection(COLLECTIONS.users).doc(userId));
        if (!user.exists || asRecord(user.data(), "user").deletedAt !== undefined) throw new Error("account_deleted");
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
      const hasAccountLink = input.linkAccount && userId !== undefined;
      const hasContactLink = input.contactEmail !== undefined;
      const expiryMillis = createdAt.toMillis() + (hasAccountLink || hasContactLink ? IDENTIFIABLE_RETENTION_DAYS : REPORT_RETENTION_DAYS) * 86_400_000;
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
        ...(hasAccountLink ? { accountId: userId } : {}),
        ...(hasContactLink ? { contactEmail: input.contactEmail } : {}),
      });
      return { report: toView({ ...input, id: reportId, status: "open", createdAt, updatedAt: createdAt, ...(hasAccountLink ? { accountId: userId } : {}), ...(hasContactLink ? { contactEmail: input.contactEmail } : {}) }), duplicate: false };
    });
    return Object.freeze(report);
  }

  public async listQueue(): Promise<readonly ContentReportView[]> {
    const rows = await this.db.collection(COLLECTIONS.contentReports).where("status", "in", ["open", "in_review", "resolved"]).get();
    return Object.freeze(rows.docs.map((row) => toView(asRecord(row.data(), "content_report"))).sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  }

  public async transitionStatus(clientSubmissionId: string, actorId: string, nextStatus: ContentReportStatus): Promise<Readonly<{ report: ContentReportView; duplicate: boolean }>> {
    const reportRef = this.db.collection(COLLECTIONS.contentReports).doc(clientSubmissionId);
    const auditRef = reportRef.collection(COLLECTIONS.contentReportAudit).doc(randomUUID());
    const changedAt = now();
    return Object.freeze(await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reportRef);
      if (!snapshot.exists) throw new Error("content_report_not_found");
      const row = asRecord(snapshot.data(), "content_report");
      const current = toView(row);
      const expiresAt = asTimestamp(row.expiresAt, "content_report_expiry");
      if (current.status === nextStatus) return { report: current, duplicate: true };
      if (!isAllowedTransition(current.status, nextStatus)) throw new Error("content_report_transition_invalid");
      transaction.update(reportRef, { status: nextStatus, updatedAt: changedAt });
      transaction.create(auditRef, { id: auditRef.id, fromStatus: current.status, toStatus: nextStatus, actorId, changedAt, expiresAt });
      return { report: toView({ ...row, status: nextStatus, updatedAt: changedAt }), duplicate: false };
    }));
  }

  public async unlinkAccount(userId: string): Promise<void> {
    const reports = await this.db.collection(COLLECTIONS.contentReports).where("accountId", "==", userId).get();
    if (reports.empty) return;
    const batchSize = 450;
    for (let offset = 0; offset < reports.docs.length; offset += batchSize) {
      const batch = this.db.batch();
      const updatedAt = now();
      for (const report of reports.docs.slice(offset, offset + batchSize)) batch.update(report.ref, { accountId: FieldValue.delete(), contactEmail: FieldValue.delete(), updatedAt });
      await batch.commit();
    }
  }

  private rateLimitDocumentId(rateLimitKey: string): string {
    return createHash("sha256").update(`${this.options.rateLimitHashSecret}:${rateLimitKey}`, "utf8").digest("hex");
  }
}

function isAllowedTransition(current: ContentReportStatus, next: ContentReportStatus): boolean {
  return (current === "open" && next === "in_review") || (current === "in_review" && next === "resolved") || (current === "resolved" && next === "closed");
}
