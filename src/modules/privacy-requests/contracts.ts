import { z } from "zod";

export const PRIVACY_REQUEST_RIGHTS = [
  "access",
  "rectification",
  "erasure",
  "restriction",
  "objection",
  "portability",
  "consent_withdrawal",
] as const;

export const privacyRequestRightSchema = z.enum(PRIVACY_REQUEST_RIGHTS);
export type PrivacyRequestRight = z.infer<typeof privacyRequestRightSchema>;

export const PRIVACY_REQUEST_STATUSES = [
  "received",
  "identity_verification_required",
  "in_review",
  "response_ready",
  "fulfilled",
  "partially_fulfilled",
  "refused",
  "closed",
] as const;

export const privacyRequestStatusSchema = z.enum(PRIVACY_REQUEST_STATUSES);
export type PrivacyRequestStatus = z.infer<typeof privacyRequestStatusSchema>;

export type PrivacyRequestOutcome = "fulfilled" | "partially_fulfilled" | "refused";
export type PrivacyRequestChannel = "account" | "public";

const narrativeSchema = z.string().trim().min(1).max(2_000);
const reportSubmissionIdSchema = z.string().uuid();

export const createAccountPrivacyRequestSchema = z.object({
  right: privacyRequestRightSchema,
  narrative: narrativeSchema.optional(),
}).strict();

export const createPublicPrivacyRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  right: privacyRequestRightSchema,
  narrative: narrativeSchema.optional(),
  reportSubmissionIds: z.array(reportSubmissionIdSchema).max(10).default([]),
}).strict();

export const verifyPublicPrivacyRequestSchema = z.object({
  token: z.string().min(32).max(512),
}).strict();

export const publicPrivacySessionSchema = z.object({
  sessionToken: z.string().min(32).max(512),
}).strict();

const reasonSchema = z.string().trim().min(1).max(2_000);
const responseSchema = z.string().trim().min(1).max(250_000);
const revisionShape = { expectedRevision: z.number().int().nonnegative() } as const;

export const privacyRequestAdminActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("require_verification"), reason: reasonSchema, ...revisionShape }).strict(),
  z.object({ action: z.literal("verify_subject"), reason: reasonSchema, ...revisionShape }).strict(),
  z.object({ action: z.literal("start_review"), ...revisionShape }).strict(),
  z.object({ action: z.literal("execute_export"), ...revisionShape }).strict(),
  z.object({ action: z.literal("extend"), reason: reasonSchema, noticeLocale: z.enum(["pl", "en"]), ...revisionShape }).strict(),
  z.object({ action: z.literal("retry_extension_notice"), ...revisionShape }).strict(),
  z.object({
    action: z.literal("prepare_response"),
    outcome: z.enum(["fulfilled", "partially_fulfilled", "refused"]),
    response: responseSchema,
    reason: reasonSchema,
    complaintInformationIncluded: z.literal(true),
    executionEvidence: z.string().trim().min(1).max(512),
    ...revisionShape,
  }).strict(),
  z.object({ action: z.literal("deliver"), ...revisionShape }).strict(),
  z.object({ action: z.literal("close"), ...revisionShape }).strict(),
]);

export type PrivacyRequestAdminAction = z.infer<typeof privacyRequestAdminActionSchema>;

export type PrivacyRequestSnapshot = Readonly<{
  status: PrivacyRequestStatus;
  outcome: PrivacyRequestOutcome | null;
  deadlineAt: Date;
  extendedAt: Date | null;
  responsePreparedAt: Date | null;
  deliveredAt: Date | null;
  closedAt: Date | null;
}>;

export type PrivacyRequestTransition = Readonly<{
  status: PrivacyRequestStatus;
  outcome: PrivacyRequestOutcome | null;
  deadlineAt: Date;
  extendedAt: Date | null;
  responsePreparedAt: Date | null;
  deliveredAt: Date | null;
  closedAt: Date | null;
}>;

export type PrivacyRightPolicy = Readonly<{
  accountVerification: "active_session" | "recent_reauthentication";
  guestVerification: "subject_link_required";
  executor: "article_15_export" | "rectification" | "owner_confirmed_deletion" | "restriction" | "objection" | "portability_export" | "consent_registry";
}>;

export const PRIVACY_RIGHT_POLICIES: Readonly<Record<PrivacyRequestRight, PrivacyRightPolicy>> = Object.freeze({
  access: Object.freeze({ accountVerification: "recent_reauthentication", guestVerification: "subject_link_required", executor: "article_15_export" }),
  rectification: Object.freeze({ accountVerification: "recent_reauthentication", guestVerification: "subject_link_required", executor: "rectification" }),
  erasure: Object.freeze({ accountVerification: "recent_reauthentication", guestVerification: "subject_link_required", executor: "owner_confirmed_deletion" }),
  restriction: Object.freeze({ accountVerification: "recent_reauthentication", guestVerification: "subject_link_required", executor: "restriction" }),
  objection: Object.freeze({ accountVerification: "active_session", guestVerification: "subject_link_required", executor: "objection" }),
  portability: Object.freeze({ accountVerification: "recent_reauthentication", guestVerification: "subject_link_required", executor: "portability_export" }),
  consent_withdrawal: Object.freeze({ accountVerification: "active_session", guestVerification: "subject_link_required", executor: "consent_registry" }),
});

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function addUtcCalendarMonths(value: Date, months: number): Date {
  if (!Number.isInteger(months) || months < 0) throw new Error("privacy_request_months_invalid");
  const targetMonthIndex = value.getUTCMonth() + months;
  const targetYear = value.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const day = Math.min(value.getUTCDate(), daysInUtcMonth(targetYear, targetMonth));
  return new Date(Date.UTC(targetYear, targetMonth, day, value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(), value.getUTCMilliseconds()));
}

export function initialPrivacyRequestDeadline(receivedAt: Date): Date {
  return addUtcCalendarMonths(receivedAt, 1);
}

export function transitionPrivacyRequest(snapshot: PrivacyRequestSnapshot, action: PrivacyRequestAdminAction, now: Date): PrivacyRequestTransition {
  const base = { ...snapshot };
  switch (action.action) {
    case "require_verification":
      if (snapshot.status !== "received") throw new Error("privacy_request_transition_invalid");
      return Object.freeze({ ...base, status: "identity_verification_required" });
    case "verify_subject":
      if (snapshot.status !== "received" && snapshot.status !== "identity_verification_required") throw new Error("privacy_request_transition_invalid");
      return Object.freeze({ ...base, status: "received" });
    case "start_review":
      if (snapshot.status !== "received" && snapshot.status !== "identity_verification_required") throw new Error("privacy_request_transition_invalid");
      return Object.freeze({ ...base, status: "in_review" });
    case "execute_export":
      if (snapshot.status !== "in_review") throw new Error("privacy_request_transition_invalid");
      return Object.freeze({ ...base, status: "response_ready", outcome: "fulfilled", responsePreparedAt: now });
    case "extend":
      if (snapshot.status !== "received" && snapshot.status !== "identity_verification_required" && snapshot.status !== "in_review") throw new Error("privacy_request_transition_invalid");
      if (snapshot.extendedAt !== null || now.getTime() >= snapshot.deadlineAt.getTime()) throw new Error("privacy_request_extension_invalid");
      return Object.freeze({ ...base, deadlineAt: addUtcCalendarMonths(snapshot.deadlineAt, 2), extendedAt: now });
    case "retry_extension_notice":
      if (snapshot.extendedAt === null) throw new Error("privacy_request_transition_invalid");
      return Object.freeze(base);
    case "prepare_response":
      if (snapshot.status !== "in_review") throw new Error("privacy_request_transition_invalid");
      return Object.freeze({ ...base, status: "response_ready", outcome: action.outcome, responsePreparedAt: now });
    case "deliver":
      if (snapshot.status !== "response_ready" || snapshot.outcome === null || snapshot.responsePreparedAt === null) throw new Error("privacy_request_transition_invalid");
      return Object.freeze({ ...base, status: snapshot.outcome, deliveredAt: now });
    case "close":
      if (!(["fulfilled", "partially_fulfilled", "refused"] as PrivacyRequestStatus[]).includes(snapshot.status) || snapshot.deliveredAt === null) throw new Error("privacy_request_transition_invalid");
      return Object.freeze({ ...base, status: "closed", closedAt: now });
  }
}
