import { z } from "zod";

const contentIdentifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:/-]+$/u);

export const createContentReportSchema = z.object({
  clientSubmissionId: z.string().uuid(),
  trackId: contentIdentifier,
  contentVersion: z.string().min(1).max(128),
  itemId: contentIdentifier,
  reason: z.enum(["incorrect_answer", "unclear_explanation", "outdated_content", "technical_issue", "other"]),
  description: z.string().trim().min(10).max(2_000),
  linkAccount: z.boolean().default(false),
  contactEmail: z.string().email().optional(),
}).strict();

export type CreateContentReport = z.infer<typeof createContentReportSchema>;

export type ContentReportView = Readonly<{
  id: string;
  clientSubmissionId: string;
  trackId: string;
  contentVersion: string;
  itemId: string;
  reason: CreateContentReport["reason"];
  description: string;
  linkage: "unlinked" | "account" | "contact" | "account_and_contact";
  status: "open" | "in_review" | "resolved" | "closed";
  createdAt: string;
  updatedAt: string;
}>;

export interface ContentReportStore {
  create(userId: string | undefined, input: CreateContentReport, context: Readonly<{ rateLimitKey: string }>): Promise<Readonly<{ report: ContentReportView; duplicate: boolean }>>;
  listOpen(): Promise<readonly ContentReportView[]>;
  unlinkAccount(userId: string): Promise<void>;
}
