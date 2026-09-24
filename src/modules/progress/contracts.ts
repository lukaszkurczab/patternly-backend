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
import { canonicalJsonBytes, CANONICAL_JSON_VERSION } from "../../infrastructure/identity/canonicalJson.js";
import { MAX_SERIALIZED_JSON_UTF16_CODE_UNITS, MAX_SYNC_ENVELOPE_UTF8_BYTES } from "./serializedJsonLimits.js";

const contentIdentitySha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const CONTENT_IDENTITY_EDGE_WHITESPACE = /^[\u0009-\u000D\u001C-\u001F\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]|[\u0009-\u000D\u001C-\u001F\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]$/u;
function isCanonicalSafeIdentity(value: string): boolean {
  return value.length > 0 && !CONTENT_IDENTITY_EDGE_WHITESPACE.test(value) && value !== "." && value !== ".." && !/[\\/\u0000]/u.test(value);
}
const contentIdentityPart = z.string().min(1).refine(isCanonicalSafeIdentity, "canonical_safe_identity");

/** Exact material identity accepted by every active sync and transfer path. */
export const resolvedContentRefSchema = z.object({
  trackId: contentIdentityPart,
  questionId: contentIdentityPart,
  contentVersion: contentIdentityPart,
  artifactSha256: contentIdentitySha256,
}).strict();

const contentIdentityTombstoneBase = {
  trackId: contentIdentityPart,
  questionId: contentIdentityPart,
  contentVersion: contentIdentityPart,
  reason: z.enum(["unknown_artifact_hash", "stale_content_version", "stale_content_release", "track_mismatch", "question_not_in_active_artifact"]),
} as const;

export const contentIdentityTombstoneSchema = z.union([
  z.object({ ...contentIdentityTombstoneBase, kind: z.literal("archival_history"), sessionId: contentIdentityPart }).strict(),
  z.object({ ...contentIdentityTombstoneBase, kind: z.literal("unavailable_active"), sessionId: contentIdentityPart }).strict(),
  z.object({ ...contentIdentityTombstoneBase, kind: z.literal("unavailable_review"), reviewId: contentIdentityPart }).strict(),
]);

export const contentIdentityResolutionSchema = z.union([
  z.object({ kind: z.literal("resolved"), ref: resolvedContentRefSchema }).strict(),
  z.object({ kind: z.literal("tombstone"), tombstone: contentIdentityTombstoneSchema }).strict(),
]);

const CONTENT_IDENTITY_FORBIDDEN_KEYS = new Set([
  "protocolVersion",
  "contentIdentitySchema",
  "packagePin",
  "contentPackagePin",
  "itemId",
  "migrationVersion",
  "legacyIdentityDigest",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function contentIdentityConflict(): never {
  throw new Error("content_identity_schema_conflict");
}

/**
 * Validate identity-bearing leaves without adding a schema marker to the
 * payload. Opaque progress fields remain application-owned, while arbitrary
 * resolved reference or tombstone is required to have the exact shape above.
 */
export function assertContentIdentityState(value: unknown): void {
  const seen = new Set<unknown>();
  visit(value);

  function visit(candidate: unknown): void {
    if (candidate === null || typeof candidate !== "object") return;
    if (seen.has(candidate)) contentIdentityConflict();
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const child of candidate) visit(child);
      return;
    }
    if (!isPlainRecord(candidate)) contentIdentityConflict();
    const keys = Object.keys(candidate);
    if (keys.some((key) => CONTENT_IDENTITY_FORBIDDEN_KEYS.has(key))) contentIdentityConflict();

    if (candidate.kind === "resolved" || candidate.kind === "tombstone") {
      if (!contentIdentityResolutionSchema.safeParse(candidate).success) contentIdentityConflict();
      return;
    }

    if (resolvedContentRefSchema.safeParse(candidate).success || contentIdentityTombstoneSchema.safeParse(candidate).success) return;
    const hasTombstoneMarker = candidate.kind === "archival_history" || candidate.kind === "unavailable_active" || candidate.kind === "unavailable_review";
    if (hasTombstoneMarker || (keys.includes("questionId") && (keys.includes("contentVersion") || keys.includes("artifactSha256")))) contentIdentityConflict();
    for (const child of Object.values(candidate)) visit(child);
  }
}

export function isContentIdentityState(value: unknown): boolean {
  try { assertContentIdentityState(value); return true; } catch { return false; }
}

const progressState = z.record(z.unknown()).refine((value) => {
  try {
    return JSON.stringify(value).length <= MAX_SERIALIZED_JSON_UTF16_CODE_UNITS && canonicalJsonBytes(value) <= MAX_SYNC_ENVELOPE_UTF8_BYTES;
  } catch {
    return false;
  }
}, "progress_state_too_large").superRefine((value, context) => {
  try { assertContentIdentityState(value); } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : "content_identity_schema_conflict" });
  }
});

export const syncableRecordTypeSchema = z.enum([
  "active_track",
  "training_session_summary",
  "training_session_result",
  "training_attempt",
  "review_queue_entry",
  "goal",
  "learning_plan",
]);

export type SyncableRecordType = z.infer<typeof syncableRecordTypeSchema>;

const progressMutationShape = {
  mutationId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u),
  kind: z.enum(["node", "item"]),
  trackId: z.string().min(1),
  targetId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative().nullable(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  state: progressState,
} as const;

export const progressMutationSchema = z.object({ ...progressMutationShape, recordType: syncableRecordTypeSchema }).strict().superRefine((value, context) => {
  const expectedKind = value.recordType === "training_attempt" || value.recordType === "review_queue_entry" ? "item" : "node";
  if (value.kind !== expectedKind) context.addIssue({ code: z.ZodIssueCode.custom, message: "progress_kind_record_type_mismatch", path: ["kind"] });
});

export const syncRequestSchema = z.object({
  canonicalVersion: z.literal(CANONICAL_JSON_VERSION),
  expectedAccountRevision: z.number().int().nonnegative(),
  deviceId: z.string().uuid(),
  sessionId: z.string().min(1).max(128),
  batchId: z.string().min(1).max(128),
  highWatermark: z.number().int().nonnegative(),
  mutations: z.array(progressMutationSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  const mutationIds = new Set<string>();
  const targets = new Set<string>();
  value.mutations.forEach((mutation, index) => {
    if (mutationIds.has(mutation.mutationId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "progress_sync_duplicate_mutation_id", path: ["mutations", index, "mutationId"] });
    }
    mutationIds.add(mutation.mutationId);

    const targetKey = JSON.stringify([mutation.recordType, mutation.trackId, mutation.targetId]);
    if (targets.has(targetKey)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "progress_sync_duplicate_target", path: ["mutations", index, "recordType"] });
    }
    targets.add(targetKey);
  });
});

export function syncRequestCanonicalBytes(value: unknown): number {
  return canonicalJsonBytes({ schema: CANONICAL_JSON_VERSION, payload: value });
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

export type SyncBatchMetadata = Readonly<{
  sessionId: string;
  batchId: string;
  highWatermark: number;
}>;

export type SyncBatchResult = Readonly<{
  accountRevision: number;
  applied: readonly ProgressRecord[];
  duplicates: readonly string[];
  conflicts: readonly ProgressConflict[];
  accountRevisionConflict?: Readonly<{ code: "account_revision_conflict"; currentAccountRevision: number }>;
}>;

export interface ProgressStore {
  read(userId: string): Promise<readonly ProgressRecord[]>;
  readSnapshot(userId: string): Promise<ProgressSnapshot>;
  previewAdoption(userId: string, guestSnapshot: GuestMergeSnapshot): Promise<AdoptionPreview>;
  confirmAdoption(userId: string, expectedAuthorizationGeneration: number, deviceId: string, guestSnapshot: GuestMergeSnapshot, confirmation: GuestMergeConfirmation): Promise<AdoptionExecution>;
  applyBatch(userId: string, expectedAuthorizationGeneration: number, deviceId: string, expectedAccountRevision: number, mutations: readonly ProgressMutation[], metadata: SyncBatchMetadata): Promise<SyncBatchResult>;
  startAdoptionTransfer(userId: string, expectedAuthorizationGeneration: number, input: AdoptionTransferStart): Promise<Readonly<Record<string, unknown>>>;
  uploadAdoptionTransfer(userId: string, expectedAuthorizationGeneration: number, sessionId: string, input: AdoptionTransferUpload): Promise<Readonly<Record<string, unknown>>>;
  sealAdoptionTransfer(userId: string, expectedAuthorizationGeneration: number, sessionId: string, input: AdoptionTransferSeal): Promise<Readonly<Record<string, unknown>>>;
  previewAdoptionTransfer(userId: string, expectedAuthorizationGeneration: number, sessionId: string, input: AdoptionTransferPreviewRequest): Promise<Readonly<Record<string, unknown>>>;
  confirmAdoptionTransfer(userId: string, sessionId: string, input: AdoptionTransferConfirm): Promise<Readonly<Record<string, unknown>>>;
  applyAdoptionTransfer(userId: string, sessionId: string, input: AdoptionTransferApply): Promise<Readonly<Record<string, unknown>>>;
  statusAdoptionTransfer(userId: string, sessionId: string, deviceId: string): Promise<Readonly<Record<string, unknown>> | null>;
}
