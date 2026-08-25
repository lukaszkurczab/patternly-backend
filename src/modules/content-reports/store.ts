import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import { contentReports } from "../../infrastructure/database/schema.js";
import type { ContentReportStore, ContentReportView, CreateContentReport } from "./contracts.js";

const toView = (row: typeof contentReports.$inferSelect): ContentReportView => Object.freeze({
  id: row.id,
  clientSubmissionId: row.clientSubmissionId,
  trackId: row.trackId,
  contentVersion: row.contentVersion,
  itemId: row.itemId,
  reason: row.reason,
  description: row.description,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export class DrizzleContentReportStore implements ContentReportStore {
  public constructor(private readonly db: Database) {}

  public async create(userId: string, input: CreateContentReport): Promise<Readonly<{ report: ContentReportView; duplicate: boolean }>> {
    const existing = await this.db.select().from(contentReports)
      .where(and(eq(contentReports.userId, userId), eq(contentReports.clientSubmissionId, input.clientSubmissionId)))
      .limit(1);
    if (existing[0]) return Object.freeze({ report: toView(existing[0]), duplicate: true });
    const inserted = await this.db.insert(contentReports).values({ userId, ...input }).returning();
    const report = inserted[0];
    if (!report) throw new Error("content_report_insert_failed");
    return Object.freeze({ report: toView(report), duplicate: false });
  }

  public async listOpen(): Promise<readonly ContentReportView[]> {
    const rows = await this.db.select().from(contentReports)
      .where(eq(contentReports.status, "open"))
      .orderBy(desc(contentReports.createdAt));
    return Object.freeze(rows.map(toView));
  }
}
