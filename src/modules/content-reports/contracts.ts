import { z } from "zod";

const contentIdentifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:/-]+$/u);

const REPORT_DESCRIPTION_MAX_LENGTH = 280;
const contactDataPatterns = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /\b(?:https?:\/\/|www\.)[^\s]+/iu,
  /\b[A-Z0-9-]+\.(?:com|org|net|edu|gov|io|dev|app|pl|eu)(?:[/?#][^\s]*)?\b/iu,
  /(?:^|[^\w])(?:\+?\d[\s().-]*){7,15}(?!\w)/u,
];
const secretPatterns = [
  /\b(?:password|passwd|passcode|hasło|pin|otp|verification\s+code|recovery\s+code|kod(?:\s+(?:dostępu|weryfikacyjny|jednorazowy))?)\b\s*(?:[:=#-]\s*\S{4,}|\s+\d{4,})/iu,
  /\b(?:code|kod)\b\s*[:=#-]?\s*\d{4,}\b/iu,
  /\b[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}\b/u,
];

const EMPTY_REPORT_DESCRIPTION = "No additional details provided.";

const contentReportDescriptionSchema = z.string().trim().max(REPORT_DESCRIPTION_MAX_LENGTH).superRefine((description, context) => {
  if (contactDataPatterns.some((pattern) => pattern.test(description))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "description_contains_contact_data" });
  }
  if (secretPatterns.some((pattern) => pattern.test(description))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "description_contains_secret" });
  }
});

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
  description: contentReportDescriptionSchema,
  context: contentReportContextSchema,
  linkAccount: z.boolean().default(false),
  contactEmail: z.string().email().optional(),
}).strict().transform((report) => ({
  ...report,
  description: report.description || EMPTY_REPORT_DESCRIPTION,
}));

export type CreateContentReport = z.infer<typeof createContentReportSchema>;
export type ContentReportContext = z.infer<typeof contentReportContextSchema>;
export type ContentReportStatus = z.infer<typeof contentReportStatusSchema>;

function isContextRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOccurredAt(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (isContextRecord(value) && typeof value.toDate === "function") {
    const date = value.toDate();
    if (date instanceof Date) return date.toISOString();
  }
  return value;
}

/**
 * Projects persisted report context through the canonical allowlist. Legacy
 * documents may carry extra nested metadata; none of it belongs in a report
 * view or account export.
 */
export function projectContentReportContext(value: unknown): ContentReportContext {
  if (!isContextRecord(value)) throw new Error("content_report_context_invalid");
  const parsed = contentReportContextSchema.safeParse({
    releasePackageId: value.releasePackageId,
    trackNode: value.trackNode,
    modeRoute: value.modeRoute,
    locale: value.locale,
    appBuild: value.appBuild,
    platform: value.platform,
    occurredAt: normalizeOccurredAt(value.occurredAt),
  });
  if (!parsed.success) throw new Error("content_report_context_invalid");
  return Object.freeze(parsed.data);
}

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
