import { z } from "zod";
import { createHash } from "node:crypto";
import type { AdoptionExecution, AdoptionPreview, GuestMergeConfirmation, GuestMergeSnapshot } from "../users/merge.js";
import type {
  AdoptionTransferApply,
  AdoptionTransferConfirm,
  AdoptionTransferPreviewRequest,
  AdoptionTransferSeal,
  AdoptionTransferStart,
  AdoptionTransferUpload,
} from "../users/adoptionTransfer.js";
import { canonicalJsonBytes } from "../../infrastructure/identity/canonicalJson.js";
import { MAX_SERIALIZED_JSON_UTF16_CODE_UNITS, MAX_SYNC_ENVELOPE_UTF8_BYTES } from "./serializedJsonLimits.js";

const progressState = z.record(z.unknown()).refine((value) => {
  try {
    return JSON.stringify(value).length <= MAX_SERIALIZED_JSON_UTF16_CODE_UNITS
      && canonicalJsonBytes(value) <= MAX_SYNC_ENVELOPE_UTF8_BYTES;
  } catch {
    return false;
  }
}, "progress_state_too_large");

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

const syncRequestV3Schema = z.object({
  protocolVersion: z.literal(3),
  canonicalVersion: z.literal("canonical-json-v1"),
  expectedAccountRevision: z.number().int().nonnegative(),
  deviceId: z.string().uuid(),
  sessionId: z.string().min(1).max(128),
  batchId: z.string().min(1).max(128),
  planVersion: z.literal(3),
  highWatermark: z.number().int().nonnegative(),
  mutations: z.array(progressMutationSchema).min(1).max(100),
}).strict();

export const syncRequestSchema = z.union([syncRequestV3Schema, syncRequestV2Schema, syncRequestV1Schema]);

export function syncRequestCanonicalBytes(value: unknown): number {
  return canonicalJsonBytes({ schema: "canonical-json-v1", payload: value });
}

export function isSyncRequestWithinBudget(value: unknown): boolean {
  try { return syncRequestSchema.safeParse(value).success && syncRequestCanonicalBytes(value) <= MAX_SYNC_ENVELOPE_UTF8_BYTES; } catch { return false; }
}

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
  generation?: number;
}>;

export type ProgressPageToken = Readonly<{ version: 1; userId: string; generation: number; accountRevision: number; cursor: string }>;

export function createProgressPageToken(value: ProgressPageToken): string {
  const payload = canonicalJsonBytes(value);
  const serialized = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const checksum = createHash("sha256").update(`${value.userId}:${payload}:${serialized}`, "utf8").digest("hex").slice(0, 32);
  return `${serialized}.${checksum}`;
}

export function parseProgressPageToken(token: string): ProgressPageToken {
  const [encoded, checksum] = token.split(".");
  if (!encoded || !checksum || !/^[a-f0-9]{32}$/u.test(checksum)) throw new Error("progress_pagination_token_invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw new Error("progress_pagination_token_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("progress_pagination_token_invalid");
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1 || typeof value.userId !== "string" || !Number.isSafeInteger(value.generation) || !Number.isSafeInteger(value.accountRevision) || typeof value.cursor !== "string") throw new Error("progress_pagination_token_invalid");
  const candidate = value as unknown as ProgressPageToken;
  const payload = canonicalJsonBytes(candidate);
  const expected = createHash("sha256").update(`${candidate.userId}:${payload}:${encoded}`, "utf8").digest("hex").slice(0, 32);
  if (expected !== checksum) throw new Error("progress_pagination_token_invalid");
  return Object.freeze(candidate);
}

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

/**
 * Optional v3 transport metadata. It is deliberately separate from the
 * mutation payload so a retry can prove that the exact same batch was sent.
 */
export type SyncBatchMetadata = Readonly<{
  sessionId: string;
  batchId: string;
  planVersion: 3;
  highWatermark: number;
}>;

export interface ProgressStore {
  read(userId: string, protocolVersion?: 1 | 2): Promise<readonly ProgressRecord[]>;
  readSnapshot(userId: string, protocolVersion?: 1 | 2): Promise<ProgressSnapshot>;
  previewAdoption(userId: string, guestSnapshot: GuestMergeSnapshot): Promise<AdoptionPreview>;
  confirmAdoption(userId: string, deviceId: string, guestSnapshot: GuestMergeSnapshot, confirmation: GuestMergeConfirmation): Promise<AdoptionExecution>;
  applyBatch(userId: string, deviceId: string | null, expectedAccountRevision: number, mutations: readonly ProgressMutation[], metadata?: SyncBatchMetadata): Promise<SyncBatchResult>;
  startAdoptionTransfer(userId: string, input: AdoptionTransferStart): Promise<Readonly<Record<string, unknown>>>;
  uploadAdoptionTransfer(userId: string, sessionId: string, input: AdoptionTransferUpload): Promise<Readonly<Record<string, unknown>>>;
  sealAdoptionTransfer(userId: string, sessionId: string, input: AdoptionTransferSeal): Promise<Readonly<Record<string, unknown>>>;
  previewAdoptionTransfer(userId: string, sessionId: string, input: AdoptionTransferPreviewRequest): Promise<Readonly<Record<string, unknown>>>;
  confirmAdoptionTransfer(userId: string, sessionId: string, input: AdoptionTransferConfirm): Promise<Readonly<Record<string, unknown>>>;
  applyAdoptionTransfer(userId: string, sessionId: string, input: AdoptionTransferApply): Promise<Readonly<Record<string, unknown>>>;
  statusAdoptionTransfer(userId: string, sessionId: string, deviceId: string): Promise<Readonly<Record<string, unknown>> | null>;
}
