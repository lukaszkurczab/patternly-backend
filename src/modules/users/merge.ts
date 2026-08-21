import { z } from "zod";

const mergeUserId = z.string().uuid();
const mergeOperationId = z.string().uuid();
const conflictId = z.string().min(1).max(128);
const recordId = z.string().min(1).max(256);

export const guestMergeConflictSchema = z.object({
  accountVersion: z.number().int().nonnegative(),
  conflictId,
  guestVersion: z.number().int().nonnegative(),
  recordId,
  recordType: z.enum(["node_progress", "item_progress"]),
}).strict();

export const guestMergePreviewSchema = z.object({
  accountSnapshotVersion: z.number().int().nonnegative(),
  accountUserId: mergeUserId,
  conflicts: z.array(guestMergeConflictSchema).max(1_000),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  guestSnapshotVersion: z.number().int().nonnegative(),
  guestUserId: mergeUserId,
  operationId: mergeOperationId,
  protocolVersion: z.literal(1),
}).strict().superRefine((value, context) => {
  if (value.guestUserId === value.accountUserId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "guest_and_account_must_differ", path: ["accountUserId"] });
  }
});

export const guestMergeResolutionSchema = z.object({
  conflictId,
  resolution: z.enum(["keep_guest", "keep_account", "manual_required"]),
}).strict();

export const guestMergeConfirmationSchema = z.object({
  operationId: mergeOperationId,
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  protocolVersion: z.literal(1),
  resolutions: z.array(guestMergeResolutionSchema).max(1_000),
}).strict();

export type GuestMergePreview = z.infer<typeof guestMergePreviewSchema>;
export type GuestMergeConfirmation = z.infer<typeof guestMergeConfirmationSchema>;

export type ReadyGuestMerge = Readonly<{
  confirmation: GuestMergeConfirmation;
  preview: GuestMergePreview;
  status: "ready_to_execute";
}>;

/**
 * A merge is executable only after the client confirms the exact preview and
 * supplies one explicit resolution for every conflict. There is no implicit
 * winner for a guest record and no partial confirmation path.
 */
export function validateGuestMergeConfirmation(
  preview: GuestMergePreview,
  confirmation: GuestMergeConfirmation,
): ReadyGuestMerge {
  if (confirmation.operationId !== preview.operationId) throw new Error("merge_preview_mismatch");
  if (confirmation.previewFingerprint !== preview.fingerprint) throw new Error("merge_preview_mismatch");
  if (confirmation.resolutions.length !== preview.conflicts.length) throw new Error("merge_resolution_incomplete");

  const conflictIds = new Set(preview.conflicts.map((conflict) => conflict.conflictId));
  const resolvedIds = new Set<string>();
  for (const resolution of confirmation.resolutions) {
    if (!conflictIds.has(resolution.conflictId) || resolvedIds.has(resolution.conflictId)) {
      throw new Error("merge_resolution_mismatch");
    }
    resolvedIds.add(resolution.conflictId);
    if (resolution.resolution === "manual_required") throw new Error("merge_conflict_requires_manual_resolution");
  }
  if (resolvedIds.size !== conflictIds.size) throw new Error("merge_resolution_incomplete");
  return { confirmation, preview, status: "ready_to_execute" };
}
