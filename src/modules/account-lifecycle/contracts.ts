import { z } from "zod";

export const accountRecoveryCodeIssueSchema = z.object({}).strict();
export const accountRecoveryCodeConsumeSchema = z.object({ code: z.string().regex(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/u) }).strict();
export const accountSessionRevokeSchema = z.object({ operationId: z.string().uuid() }).strict();
export const accountDeletionRequestSchema = z.object({ operationId: z.string().uuid() }).strict();
export const publicDeletionRequestSchema = z.object({ email: z.string().email().max(320) }).strict();
export const publicDeletionConfirmSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/u) }).strict();
export const publicDeletionStatusSchema = z.object({ operationId: z.string().uuid(), accountUidHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

export type AccountDeletionResult = Readonly<{ operationId: string; proofId: string; status: "remote_deleted" | "already_deleted" }>;
export type CompletedDeletion = Readonly<{ status: "deleted"; operationId: string; proofId: string }>;
export type PublicDeletionConfirmation = Readonly<
  | { status: "pending"; userId: string; operationId: string }
  | { status: "complete"; operationId: string; proofId: string }
>;
