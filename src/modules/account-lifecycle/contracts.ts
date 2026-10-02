import { z } from "zod";

export const accountRecoveryCodeIssueSchema = z.object({ operationId: z.string().uuid() }).strict();
export const accountRecoveryCodeConsumeSchema = z.object({
  operationId: z.string().uuid(),
  code: z.string().regex(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/u),
}).strict();
export const accountRecoveryOperationStatusSchema = accountRecoveryCodeConsumeSchema;
export const accountRecoveryOperationAckSchema = z.object({ operationId: z.string().uuid() }).strict();
export const accountRecoveryCodeIssueStatusSchema = accountRecoveryOperationAckSchema;
export const accountRecoveryCodeSavedAckSchema = accountRecoveryOperationAckSchema;
export const accountSessionRevokeSchema = z.object({ operationId: z.string().uuid() }).strict();
export const accountDeletionRequestSchema = z.object({ operationId: z.string().uuid(), operationSecret: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export const publicDeletionStatusSchema = z.object({ operationId: z.string().uuid(), operationSecret: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

export type AccountDeletionResult = Readonly<{ operationId: string; proofId: string; status: "remote_deleted" | "already_deleted" }>;
export type CompletedDeletion = Readonly<{ status: "deleted"; operationId: string; proofId: string }>;

export type RecoveryOperationStatus = "in_progress" | "result_available" | "acknowledged" | "delivery_unconfirmed" | "superseded" | "expired_or_invalid" | "provider_retryable";

export type RecoveryOperationProgress = Readonly<{
  operationId: string;
  status: Exclude<RecoveryOperationStatus, "result_available">;
  authorizationGeneration?: number;
}>;

export type RecoveryConsumeResult = RecoveryOperationProgress | Readonly<{
  operationId: string;
  status: "result_available";
  firebaseUid: string;
  authorizationGeneration: number;
  customToken: string;
}>;

export type RecoveryCodeIssueResult = RecoveryOperationProgress | Readonly<{
  operationId: string;
  status: "result_available";
  generationId: string;
  authorizationGeneration: number;
  codes: readonly string[];
}>;

export type RecoveryOperationAcknowledgement = Readonly<{
  operationId: string;
  status: "acknowledged";
  authorizationGeneration: number;
}>;

export type RecoveryOperationRuntime = Readonly<{
  cipher: import("./recoveryOperationCipher.js").RecoveryOperationCipher | null;
}>;
