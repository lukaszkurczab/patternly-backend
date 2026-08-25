import { z } from "zod";

const contentIdentifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:/-]+$/u);

export const contentReportStatusSchema = z.enum(["open", "in_review", "resolved", "closed"]);
export const contentReportContextSchema = z.object({
  releasePackageId: contentIdentifier,
  trackNode: z.string().min(1).max(128).nullable(),
  modeRoute: z.enum(["practice_feedback_details", "answer_review"]),
  locale: z.enum(["en", "pl"]),
  appBuild: z.string().trim().min(1).max(32),
  platform: z.enum(["ios", "android"]),
  occurredAt: z.string().datetime({ offset: true }),
}).strict();

export const createContentReportSchema = z.object({
  clientSubmissionId: z.string().uuid(),
  trackId: contentIdentifier,
  contentVersion: z.string().min(1).max(128),
  itemId: contentIdentifier,
  reason: z.enum(["incorrect_answer", "unclear_explanation", "outdated_content", "technical_issue", "other"]),
  description: z.string().trim().min(10).max(2_000),
  context: contentReportContextSchema,
  linkAccount: z.boolean().default(false),
  contactEmail: z.string().email().optional(),
}).strict();

export type CreateContentReport = z.infer<typeof createContentReportSchema>;
export type ContentReportContext = z.infer<typeof contentReportContextSchema>;
export type ContentReportStatus = z.infer<typeof contentReportStatusSchema>;

export const transitionContentReportSchema = z.object({ status: contentReportStatusSchema }).strict();

export type ContentReportView = Readonly<{
  id: string;
  clientSubmissionId: string;
  trackId: string;
  contentVersion: string;
  itemId: string;
  reason: CreateContentReport["reason"];
  description: string;
  context: ContentReportContext;
  linkage: "unlinked" | "account" | "contact" | "account_and_contact";
  status: ContentReportStatus;
  createdAt: string;
  updatedAt: string;
}>;

export interface ContentReportStore {
  create(userId: string | undefined, input: CreateContentReport, context: Readonly<{ rateLimitKey: string }>): Promise<Readonly<{ report: ContentReportView; duplicate: boolean }>>;
  listQueue(): Promise<readonly ContentReportView[]>;
  transitionStatus(clientSubmissionId: string, actorId: string, nextStatus: ContentReportStatus): Promise<Readonly<{ report: ContentReportView; duplicate: boolean }>>;
  unlinkAccount(userId: string): Promise<void>;
}
