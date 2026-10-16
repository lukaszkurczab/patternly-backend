import { z } from "zod";
import { addUtcCalendarMonths } from "../../infrastructure/time/utcCalendar.js";

export const legalRequestKindSchema = z.enum(["complaint", "withdrawal", "data_recovery", "suspension_appeal"]);
export type LegalRequestKind = z.infer<typeof legalRequestKindSchema>;
export const LEGAL_REQUEST_STATUSES = ["received", "in_review", "answered", "closed"] as const;

const narrative = z.string().trim().min(1).max(4_000);
const transactionId = z.string().trim().min(1).max(128).optional();
export const createLegalRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("complaint"), narrative, transactionId }).strict(),
  z.object({ kind: z.literal("withdrawal"), narrative: narrative.optional(), transactionId }).strict(),
  z.object({ kind: z.literal("data_recovery"), narrative, transactionId }).strict(),
  z.object({ kind: z.literal("suspension_appeal"), narrative, transactionId }).strict(),
]);

export const createPublicLegalRequestSchema = z.discriminatedUnion("kind", [
  z.object({ email: z.string().email().max(320), kind: z.literal("complaint"), narrative, transactionId }).strict(),
  z.object({ email: z.string().email().max(320), kind: z.literal("withdrawal"), narrative: narrative.optional(), transactionId }).strict(),
  z.object({ email: z.string().email().max(320), kind: z.literal("data_recovery"), narrative, transactionId }).strict(),
  z.object({ email: z.string().email().max(320), kind: z.literal("suspension_appeal"), narrative, transactionId }).strict(),
]);

export const legalEvidenceFields = ["email", "narrative", "transactionId", "response"] as const;
const necessaryFields = z.array(z.enum(legalEvidenceFields)).max(4).refine((fields) => new Set(fields).size === fields.length);

export const legalRequestAdminActionSchema = z.union([
  z.object({ action: z.literal("start_review"), expectedRevision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("answer"), expectedRevision: z.number().int().nonnegative(), response: z.string().trim().min(1).max(50_000) }).strict(),
  z.object({ action: z.literal("close"), expectedRevision: z.number().int().nonnegative(), disposition: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("minimal_archive"), reason: z.string().trim().min(1).max(1_000) }).strict(),
    z.object({ kind: z.literal("claim"), necessaryFields, retentionUntil: z.string().datetime(), basis: z.string().trim().min(1).max(1_000), reason: z.string().trim().min(1).max(1_000) }).strict(),
  ]) }).strict(),
  z.object({ action: z.literal("review_retention"), expectedRevision: z.number().int().nonnegative(), reason: z.string().trim().min(1).max(1_000), nextReviewAt: z.string().datetime(), necessaryFields, retentionUntil: z.string().datetime(), basis: z.string().trim().min(1).max(1_000), dispute: z.enum(["unchanged", "ongoing", "resolved_executed"]), finalResolutionAt: z.string().datetime().optional(), executedAt: z.string().datetime().optional() }).strict(),
  z.object({ action: z.literal("set_legal_hold"), expectedRevision: z.number().int().nonnegative(), active: z.boolean(), reason: z.string().trim().min(1).max(1_000), reviewBy: z.string().datetime().optional() }).strict(),
]);
export type LegalRequestAdminAction = z.infer<typeof legalRequestAdminActionSchema>;

export type LegalRequestStatus = (typeof LEGAL_REQUEST_STATUSES)[number];

export function complaintResponseDueAt(receivedAt: Date, kind: LegalRequestKind): Date | null {
  if (kind !== "complaint") return null;
  const due = new Date(receivedAt);
  due.setUTCDate(due.getUTCDate() + 14);
  return due;
}

export function retentionUntilFromClosure(closedAt: Date, months: number): Date {
  return addUtcCalendarMonths(closedAt, months);
}
