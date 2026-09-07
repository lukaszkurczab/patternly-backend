import { z } from "zod";

export const legalRequestKindSchema = z.enum(["complaint", "withdrawal", "data_recovery", "suspension_appeal"]);
export type LegalRequestKind = z.infer<typeof legalRequestKindSchema>;

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

export const legalRequestAdminActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start_review"), expectedRevision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("answer"), expectedRevision: z.number().int().nonnegative(), response: z.string().trim().min(1).max(50_000) }).strict(),
  z.object({ action: z.literal("close"), expectedRevision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("set_legal_hold"), expectedRevision: z.number().int().nonnegative(), active: z.boolean(), reason: z.string().trim().min(1).max(1_000) }).strict(),
]);
export type LegalRequestAdminAction = z.infer<typeof legalRequestAdminActionSchema>;

export type LegalRequestStatus = "received" | "in_review" | "answered" | "closed";

export function complaintResponseDueAt(receivedAt: Date, kind: LegalRequestKind): Date | null {
  if (kind !== "complaint") return null;
  const due = new Date(receivedAt);
  due.setUTCDate(due.getUTCDate() + 14);
  return due;
}

export function retentionUntilFromClosure(closedAt: Date): Date {
  const result = new Date(closedAt);
  result.setUTCFullYear(result.getUTCFullYear() + 6);
  return result;
}
