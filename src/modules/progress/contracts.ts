import { z } from "zod";
import type { AdoptionExecution, AdoptionPreview, GuestMergeConfirmation, GuestMergeSnapshot } from "../users/merge.js";
import { MAX_SERIALIZED_JSON_UTF16_CODE_UNITS } from "./serializedJsonLimits.js";

const progressState = z.record(z.unknown()).refine((value) => JSON.stringify(value).length <= MAX_SERIALIZED_JSON_UTF16_CODE_UNITS, "progress_state_too_large");

export const legacySyncableRecordTypeSchema = z.enum([
  "active_track",
  "training_session_summary",
  "training_session_result",
  "training_attempt",
  "review_queue_entry",
]);

export const syncableRecordTypeSchema = z.enum([
  ...legacySyncableRecordTypeSchema.options,
  "goal",
  "learning_plan",
]);

export type SyncableRecordType = z.infer<typeof syncableRecordTypeSchema>;

const progressMutationShape = {
  mutationId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u),
  kind: z.enum(["node", "item"]),
  trackId: z.string().min(1).max(128),
  targetId: z.string().min(1).max(256),
  expectedVersion: z.number().int().nonnegative().nullable(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  state: progressState,
} as const;

function mutationSchema<T extends typeof legacySyncableRecordTypeSchema | typeof syncableRecordTypeSchema>(recordType: T) {
  return z.object({ ...progressMutationShape, recordType }).strict().superRefine((value, context) => {
  const expectedKind = value.recordType === "training_attempt" || value.recordType === "review_queue_entry" ? "item" : "node";
  if (value.kind !== expectedKind) context.addIssue({ code: z.ZodIssueCode.custom, message: "progress_kind_record_type_mismatch", path: ["kind"] });
  });
}

export const progressMutationSchema = mutationSchema(syncableRecordTypeSchema);
export const legacyProgressMutationSchema = mutationSchema(legacySyncableRecordTypeSchema);

const syncRequestV1Schema = z.object({
  protocolVersion: z.literal(1).optional().default(1),
  expectedAccountRevision: z.number().int().nonnegative(),
  deviceId: z.string().uuid().nullable().optional().default(null),
  mutations: z.array(legacyProgressMutationSchema).min(1).max(100),
}).strict();

const syncRequestV2Schema = z.object({
  protocolVersion: z.literal(2),
  expectedAccountRevision: z.number().int().nonnegative(),
  deviceId: z.string().uuid().nullable().optional().default(null),
  mutations: z.array(progressMutationSchema).min(1).max(100),
}).strict();

export const syncRequestSchema = z.union([syncRequestV2Schema, syncRequestV1Schema]);

export type ProgressMutation = z.infer<typeof progressMutationSchema>;
export type SyncRequest = z.infer<typeof syncRequestSchema>;

export type ProgressRecord = Readonly<{
  kind: "node" | "item";
  recordType: SyncableRecordType;
  trackId: string;
  targetId: string;
  version: number;
  fingerprint: string;
  state: Readonly<Record<string, unknown>>;
  lastMutationId: string;
  updatedAt: string;
}>;

export type ProgressSnapshot = Readonly<{
  accountRevision: number;
  records: readonly ProgressRecord[];
}>;

export type ProgressConflict = Readonly<{
  mutationId: string;
  code: "version_conflict";
  current: ProgressRecord | null;
}>;

export type SyncBatchResult = Readonly<{
  accountRevision: number;
  applied: readonly ProgressRecord[];
  duplicates: readonly string[];
  conflicts: readonly ProgressConflict[];
  accountRevisionConflict?: Readonly<{ code: "account_revision_conflict"; currentAccountRevision: number }>;
}>;

export interface ProgressStore {
  read(userId: string, protocolVersion?: 1 | 2): Promise<readonly ProgressRecord[]>;
  readSnapshot(userId: string, protocolVersion?: 1 | 2): Promise<ProgressSnapshot>;
  previewAdoption(userId: string, guestSnapshot: GuestMergeSnapshot): Promise<AdoptionPreview>;
  confirmAdoption(userId: string, deviceId: string, guestSnapshot: GuestMergeSnapshot, confirmation: GuestMergeConfirmation): Promise<AdoptionExecution>;
  applyBatch(userId: string, deviceId: string | null, expectedAccountRevision: number, mutations: readonly ProgressMutation[]): Promise<SyncBatchResult>;
}
