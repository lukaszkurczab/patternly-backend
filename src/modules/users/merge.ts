import { createHash } from "node:crypto";
import { z } from "zod";
import { syncableRecordTypeSchema, type ProgressRecord, type SyncableRecordType } from "../progress/contracts.js";

const mergeUserId = z.string().uuid();
const mergeOperationId = z.string().uuid();
const conflictId = z.string().min(1).max(128);
const recordId = z.string().min(1).max(256);

const mergeState = z.record(z.unknown()).refine((value) => JSON.stringify(value).length <= 64 * 1024, "merge_state_too_large");

export const guestMergeRecordSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  recordId,
  recordType: syncableRecordTypeSchema,
  state: mergeState,
  trackId: z.string().min(1).max(128),
  version: z.number().int().nonnegative(),
}).strict();

export const guestMergeSnapshotSchema = z.object({
  guestSnapshotVersion: z.number().int().nonnegative(),
  guestUserId: mergeUserId,
  records: z.array(guestMergeRecordSchema).max(1_000),
  activeSession: z.boolean(),
  pendingJournal: z.boolean(),
}).strict();

export const guestMergeConflictSchema = z.object({
  accountVersion: z.number().int().nonnegative(),
  conflictId,
  guestVersion: z.number().int().nonnegative(),
  recordId,
  recordType: syncableRecordTypeSchema,
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
export type GuestMergeRecord = z.infer<typeof guestMergeRecordSchema>;
export type GuestMergeSnapshot = z.infer<typeof guestMergeSnapshotSchema>;

export type AdoptionPlan = Readonly<{
  caseId: "emptyLocalEmptyRemote" | "populatedLocalEmptyRemote" | "emptyLocalPopulatedRemote" | "populatedLocalPopulatedRemote" | "divergentRecord" | "blocked";
  localRecordCount: number;
  remoteRecordCount: number;
  uploadRecordIds: readonly string[];
  restoreRecordIds: readonly string[];
  deduplicatedRecordIds: readonly string[];
  conflictRecordIds: readonly string[];
  blockingReason: "active_session" | "journal_recovery" | null;
}>;

export type AdoptionPreview = Readonly<{
  preview: GuestMergePreview;
  plan: AdoptionPlan;
  remoteRecords: readonly GuestMergeRecord[];
}>;

export type AdoptionExecution = Readonly<{
  accountRevision: number;
  operationId: string;
  mutationIds: readonly string[];
  records: readonly GuestMergeRecord[];
}>;

export type ReadyGuestMerge = Readonly<{
  confirmation: GuestMergeConfirmation;
  preview: GuestMergePreview;
  status: "ready_to_execute";
}>;

export function buildGuestMergePreview(input: Readonly<{
  accountUserId: string;
  accountSnapshotVersion: number;
  guestSnapshot: GuestMergeSnapshot;
  remoteRecords: readonly GuestMergeRecord[];
}>): AdoptionPreview {
  for (const record of input.guestSnapshot.records) assertMergeRecordIntegrity(record);
  for (const record of input.remoteRecords) assertMergeRecordIntegrity(record);
  const localByKey = new Map(input.guestSnapshot.records.map((record) => [mergeRecordKey(record), record]));
  const remoteByKey = new Map(input.remoteRecords.map((record) => [mergeRecordKey(record), record]));
  const uploadRecordIds: string[] = [];
  const restoreRecordIds: string[] = [];
  const deduplicatedRecordIds: string[] = [];
  const conflictRecordIds: string[] = [];
  const conflicts: Array<z.infer<typeof guestMergeConflictSchema>> = [];

  for (const record of input.guestSnapshot.records) {
    const key = mergeRecordKey(record);
    const remote = remoteByKey.get(key);
    if (!remote) {
      uploadRecordIds.push(key);
      continue;
    }
    if (remote.fingerprint === record.fingerprint) {
      deduplicatedRecordIds.push(key);
      continue;
    }
    conflictRecordIds.push(key);
    conflicts.push({
      accountVersion: remote.version,
      conflictId: key,
      guestVersion: record.version,
      recordId: record.recordId,
      recordType: record.recordType,
    });
  }
  for (const record of input.remoteRecords) {
    if (!localByKey.has(mergeRecordKey(record))) restoreRecordIds.push(mergeRecordKey(record));
  }

  const blockingReason = input.guestSnapshot.activeSession ? "active_session" : input.guestSnapshot.pendingJournal ? "journal_recovery" : null;
  const caseId = blockingReason ? "blocked" : input.guestSnapshot.records.length === 0 && input.remoteRecords.length === 0 ? "emptyLocalEmptyRemote"
    : input.guestSnapshot.records.length > 0 && input.remoteRecords.length === 0 ? "populatedLocalEmptyRemote"
      : input.guestSnapshot.records.length === 0 && input.remoteRecords.length > 0 ? "emptyLocalPopulatedRemote"
        : conflicts.length > 0 ? "divergentRecord" : "populatedLocalPopulatedRemote";
  const previewWithoutFingerprint = {
    accountSnapshotVersion: input.accountSnapshotVersion,
    accountUserId: input.accountUserId,
    conflicts: conflicts.sort((left, right) => left.conflictId.localeCompare(right.conflictId)),
    guestSnapshotVersion: input.guestSnapshot.guestSnapshotVersion,
    guestUserId: input.guestSnapshot.guestUserId,
    protocolVersion: 1 as const,
  };
  const fingerprint = sha256(canonicalJson({
    preview: previewWithoutFingerprint,
    plan: { caseId, localRecordCount: input.guestSnapshot.records.length, remoteRecordCount: input.remoteRecords.length, uploadRecordIds, restoreRecordIds, deduplicatedRecordIds, conflictRecordIds, blockingReason },
    localRecords: input.guestSnapshot.records,
    remoteRecords: input.remoteRecords,
  }));
  const preview: GuestMergePreview = Object.freeze({ ...previewWithoutFingerprint, fingerprint, operationId: deterministicOperationId(fingerprint) });
  return Object.freeze({
    preview,
    plan: Object.freeze({ caseId, localRecordCount: input.guestSnapshot.records.length, remoteRecordCount: input.remoteRecords.length, uploadRecordIds: Object.freeze(uploadRecordIds), restoreRecordIds: Object.freeze(restoreRecordIds), deduplicatedRecordIds: Object.freeze(deduplicatedRecordIds), conflictRecordIds: Object.freeze(conflictRecordIds), blockingReason }),
    remoteRecords: Object.freeze(input.remoteRecords),
  });
}

export function mergeRecordKey(record: Pick<GuestMergeRecord, "recordType" | "recordId">): string {
  return `${record.recordType}:${record.recordId}`;
}

export function progressRecordToMergeRecord(record: ProgressRecord): GuestMergeRecord {
  return Object.freeze({ fingerprint: record.fingerprint, recordId: record.targetId, recordType: record.recordType, state: record.state, trackId: record.trackId, version: record.version });
}

export function createMergeRecordFingerprint(record: Readonly<{ recordId: string; recordType: SyncableRecordType; state: Readonly<Record<string, unknown>>; trackId: string }>): string {
  return sha256(canonicalJson({ recordId: record.recordId, recordType: record.recordType, state: record.state, trackId: record.trackId }));
}

function assertMergeRecordIntegrity(record: GuestMergeRecord): void {
  if (createMergeRecordFingerprint(record) !== record.fingerprint) throw new Error("progress_fingerprint_mismatch");
}

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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === null) throw new Error("merge_value_not_serializable");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deterministicOperationId(fingerprint: string): string {
  const hex = sha256(`adoption:${fingerprint}`).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}
