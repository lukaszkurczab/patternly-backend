import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, canonicalJsonBytes, CANONICAL_JSON_VERSION } from "../../infrastructure/identity/canonicalJson.js";

/**
 * Protocol-v3 is a durable transfer protocol, rather than a larger version of
 * the legacy one-shot merge request.  Keep these limits here so the HTTP and
 * Firestore implementations use the same contract.
 */
export const ADOPTION_TRANSFER_MAX_RECORDS = 1_000;
/** Firestore transaction headroom: records + chunk + operation stay below 500 writes. */
export const ADOPTION_TRANSFER_MAX_CHUNK_RECORDS = 450;
/** Keep multi-document recovery batches well below Firestore's hard limit. */
export const ADOPTION_TRANSFER_FIRESTORE_BATCH_SIZE = 200;
export const ADOPTION_TRANSFER_MAX_CANONICAL_BYTES = 512 * 1024;
export const ADOPTION_TRANSFER_TTL_MS = 24 * 60 * 60 * 1_000;

export const ADOPTION_TRANSFER_STATES = Object.freeze([
  "collecting",
  "sealing",
  "sealed",
  "result_building",
  "preview_ready",
  "applying",
  "complete",
  "failed",
] as const);
export const adoptionTransferStateSchema = z.enum(ADOPTION_TRANSFER_STATES);
export const adoptionTransferIdentitySchema = z.object({ recordType: z.string().min(1).max(128), recordId: z.string().min(1).max(256), trackId: z.string().min(1).max(128) }).strict();
export const adoptionTransferRecordSchema = z.object({ ...adoptionTransferIdentitySchema.shape, fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), state: z.record(z.unknown()), version: z.number().int().nonnegative() }).strict().superRefine((value, context) => {
  try {
    if (JSON.stringify(value.state).length > 128 * 1024 || canonicalJsonBytes(value.state) > ADOPTION_TRANSFER_MAX_CANONICAL_BYTES) context.addIssue({ code: z.ZodIssueCode.custom, message: "adoption_transfer_record_too_large", path: ["state"] });
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "adoption_transfer_record_not_canonical", path: ["state"] });
  }
});
export const adoptionTransferChunkSchema = z.object({ chunkId: z.string().min(1).max(128), index: z.number().int().nonnegative(), recordKeys: z.array(z.string().min(1)).max(ADOPTION_TRANSFER_MAX_CHUNK_RECORDS), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), bytes: z.number().int().nonnegative().max(ADOPTION_TRANSFER_MAX_CANONICAL_BYTES) }).strict();
export const adoptionTransferDecisionSchema = z.object({ decisionId: z.string().min(1).max(128), identity: adoptionTransferIdentitySchema, resolution: z.enum(["keep_guest", "keep_account"]), previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

const uuid = z.string().uuid();
const idempotencyKey = z.string().min(1).max(128);

/** HTTP DTOs for the resumable protocol-v3 lifecycle. */
export const adoptionTransferStartSchema = z.object({
  protocolVersion: z.literal(3).optional().default(3),
  canonicalVersion: z.literal(CANONICAL_JSON_VERSION).optional().default(CANONICAL_JSON_VERSION),
  sessionId: idempotencyKey.optional(),
  idempotencyKey,
  guestUserId: uuid,
  snapshotVersion: z.number().int().nonnegative(),
  expectedGeneration: z.number().int().nonnegative().optional().default(0),
  deviceId: uuid,
  activeSession: z.boolean().optional().default(false),
  pendingJournal: z.boolean().optional().default(false),
}).strict();

export const adoptionTransferUploadSchema = z.object({
  canonicalVersion: z.literal(CANONICAL_JSON_VERSION).optional().default(CANONICAL_JSON_VERSION),
  idempotencyKey: idempotencyKey.optional(),
  deviceId: uuid,
  chunk: adoptionTransferChunkSchema,
  records: z.array(adoptionTransferRecordSchema).max(ADOPTION_TRANSFER_MAX_CHUNK_RECORDS),
}).strict();

export const adoptionTransferSealSchema = z.object({
  canonicalVersion: z.literal(CANONICAL_JSON_VERSION).optional().default(CANONICAL_JSON_VERSION),
  idempotencyKey: idempotencyKey.optional(),
  deviceId: uuid,
  snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  recordCount: z.number().int().nonnegative().max(ADOPTION_TRANSFER_MAX_RECORDS),
  chunkCount: z.number().int().nonnegative().max(ADOPTION_TRANSFER_MAX_RECORDS),
}).strict();

export const adoptionTransferPreviewSchema = z.object({
  canonicalVersion: z.literal(CANONICAL_JSON_VERSION).optional().default(CANONICAL_JSON_VERSION),
  idempotencyKey: idempotencyKey.optional(),
  deviceId: uuid,
  protocolVersion: z.union([z.literal(1), z.literal(2)]).optional().default(2),
}).strict();

const adoptionTransferResolutionSchema = z.object({ conflictId: z.string().min(1).max(768), resolution: z.enum(["keep_guest", "keep_account", "manual_required"]) }).strict();
const adoptionTransferGroupChoiceSchema = z.object({ groupId: z.string().min(1).max(512), resolution: z.enum(["keep_guest", "keep_account"]) }).strict();
export const adoptionTransferConfirmSchema = z.object({
  canonicalVersion: z.literal(CANONICAL_JSON_VERSION).optional().default(CANONICAL_JSON_VERSION),
  idempotencyKey: idempotencyKey.optional(),
  deviceId: uuid,
  operationId: uuid.optional(),
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  decisionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  protocolVersion: z.union([z.literal(1), z.literal(2)]),
  resolutions: z.array(adoptionTransferResolutionSchema).max(ADOPTION_TRANSFER_MAX_RECORDS),
  groupChoices: z.array(adoptionTransferGroupChoiceSchema).max(ADOPTION_TRANSFER_MAX_RECORDS).optional(),
}).strict();

export const adoptionTransferApplySchema = z.object({
  canonicalVersion: z.literal(CANONICAL_JSON_VERSION).optional().default(CANONICAL_JSON_VERSION),
  idempotencyKey: idempotencyKey.optional(),
  deviceId: uuid,
  decisionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  expectedGeneration: z.number().int().nonnegative().optional(),
}).strict();

export const adoptionTransferStatusSchema = z.object({
  canonicalVersion: z.literal(CANONICAL_JSON_VERSION).optional().default(CANONICAL_JSON_VERSION),
  deviceId: uuid,
}).strict();

export type AdoptionTransferStart = z.infer<typeof adoptionTransferStartSchema>;
export type AdoptionTransferUpload = z.infer<typeof adoptionTransferUploadSchema>;
export type AdoptionTransferSeal = z.infer<typeof adoptionTransferSealSchema>;
export type AdoptionTransferPreviewRequest = z.infer<typeof adoptionTransferPreviewSchema>;
export type AdoptionTransferConfirm = z.infer<typeof adoptionTransferConfirmSchema>;
export type AdoptionTransferApply = z.infer<typeof adoptionTransferApplySchema>;

export type AdoptionTransferStateName = (typeof ADOPTION_TRANSFER_STATES)[number];
export type AdoptionTransferIdentity = Readonly<{ recordType: string; recordId: string; trackId: string }>;
export type AdoptionTransferRecord = Readonly<AdoptionTransferIdentity & {
  fingerprint: string;
  state: Readonly<Record<string, unknown>>;
  version: number;
}>;
export type AdoptionTransferChunk = Readonly<{
  chunkId: string;
  index: number;
  recordKeys: readonly string[];
  fingerprint: string;
  bytes: number;
}>;
export type AdoptionTransferDecision = Readonly<{
  decisionId: string;
  identity: AdoptionTransferIdentity;
  resolution: "keep_guest" | "keep_account";
  previewFingerprint: string;
}>;
export type AdoptionTransferResultChunk = Readonly<{
  chunkId: string;
  index: number;
  recordKeys: readonly string[];
  fingerprint: string;
}>;
export type AdoptionTransfer = Readonly<{
  version: 3;
  accountId: string;
  sessionId: string;
  guestUserId: string;
  state: AdoptionTransferStateName;
  expectedGeneration: number;
  generation: number;
  snapshotVersion: number;
  targetGeneration: number;
  recordCount: number;
  chunkCount: number;
  snapshotFingerprint: string | null;
  records: readonly AdoptionTransferRecord[];
  chunks: readonly AdoptionTransferChunk[];
  decisions: readonly AdoptionTransferDecision[];
  resultChunks: readonly AdoptionTransferResultChunk[];
  failureCode: string | null;
  operationFingerprint: string;
  idempotencyKey: string;
  updatedAt: string;
}>;

const stateTransitions: Readonly<Record<AdoptionTransferStateName, readonly AdoptionTransferStateName[]>> = Object.freeze({
  collecting: ["sealing", "failed"],
  sealing: ["sealed", "failed"],
  sealed: ["result_building", "failed"],
  result_building: ["preview_ready", "failed"],
  preview_ready: ["applying", "failed"],
  applying: ["complete", "failed"],
  complete: [],
  failed: [],
});

function isoNow(): string { return new Date().toISOString(); }
function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"); }
/** Collision-safe identity shared by staging, merge and pagination paths. */
export function adoptionTransferRecordKey(value: AdoptionTransferIdentity): string {
  return canonicalJson({ recordId: value.recordId, recordType: value.recordType, trackId: value.trackId });
}

export function createAdoptionSnapshotSeal(input: Readonly<{ guestUserId: string; snapshotVersion: number; records: readonly AdoptionTransferRecord[]; chunks: readonly AdoptionTransferChunk[] }>): string {
  return digest({
    schema: CANONICAL_JSON_VERSION,
    guestUserId: input.guestUserId,
    snapshotVersion: input.snapshotVersion,
    records: input.records.slice().sort((a, b) => adoptionTransferRecordKey(a).localeCompare(adoptionTransferRecordKey(b))),
    chunks: input.chunks.slice().sort((a, b) => a.index - b.index).map((chunk) => ({ ...chunk, recordKeys: [...chunk.recordKeys].sort() })),
  });
}

export function createAdoptionTransferChunkFingerprint(input: Readonly<Pick<AdoptionTransferChunk, "chunkId" | "index" | "recordKeys" | "bytes">>): string {
  return digest({ chunkId: input.chunkId, index: input.index, recordKeys: [...input.recordKeys].sort(), bytes: input.bytes });
}

export function createAdoptionTransfer(input: Readonly<{ accountId: string; sessionId: string; guestUserId: string; snapshotVersion: number; expectedGeneration?: number; targetGeneration?: number; idempotencyKey?: string }>): AdoptionTransfer {
  const expectedGeneration = input.expectedGeneration ?? 0;
  const targetGeneration = input.targetGeneration ?? expectedGeneration + 1;
  const idempotencyKey = input.idempotencyKey ?? input.sessionId;
  if (!Number.isSafeInteger(targetGeneration) || targetGeneration <= expectedGeneration) throw new Error("adoption_transfer_generation_conflict");
  const base = { version: 3 as const, accountId: input.accountId, sessionId: input.sessionId, guestUserId: input.guestUserId, state: "collecting" as const, expectedGeneration, generation: expectedGeneration, targetGeneration, snapshotVersion: input.snapshotVersion, recordCount: 0, chunkCount: 0, snapshotFingerprint: null, records: Object.freeze([]), chunks: Object.freeze([]), decisions: Object.freeze([]), resultChunks: Object.freeze([]), failureCode: null, idempotencyKey, updatedAt: isoNow() };
  return Object.freeze({ ...base, operationFingerprint: digest(base) });
}

function transition(transfer: AdoptionTransfer, next: AdoptionTransferStateName, expectedState: AdoptionTransferStateName, idempotencyKey?: string): AdoptionTransfer {
  if (transfer.state !== expectedState) {
    if (idempotencyKey !== undefined && idempotencyKey === transfer.idempotencyKey && transfer.state === next) return transfer;
    throw new Error("adoption_transfer_precondition_failed");
  }
  if (!stateTransitions[transfer.state].includes(next)) throw new Error("adoption_transfer_invalid_transition");
  return Object.freeze({ ...transfer, state: next, updatedAt: isoNow() });
}

export function appendAdoptionTransferRecord(transfer: AdoptionTransfer, record: AdoptionTransferRecord, idempotencyKey = record.fingerprint): AdoptionTransfer {
  if (transfer.state !== "collecting") {
    if (idempotencyKey === transfer.idempotencyKey) return transfer;
    throw new Error("adoption_transfer_precondition_failed");
  }
  const key = adoptionTransferRecordKey(record);
  const existing = transfer.records.find((candidate) => adoptionTransferRecordKey(candidate) === key);
  if (existing) {
    if (existing.fingerprint !== record.fingerprint || idempotencyKey !== record.fingerprint) throw new Error("adoption_transfer_record_conflict");
    return transfer;
  }
  const records = Object.freeze([...transfer.records, Object.freeze({ ...record })].sort((a, b) => adoptionTransferRecordKey(a).localeCompare(adoptionTransferRecordKey(b))));
  return Object.freeze({ ...transfer, records, recordCount: records.length, updatedAt: isoNow() });
}

export function appendAdoptionTransferChunk(transfer: AdoptionTransfer, chunk: AdoptionTransferChunk, idempotencyKey = chunk.chunkId): AdoptionTransfer {
  if (transfer.state !== "collecting") {
    if (idempotencyKey === transfer.idempotencyKey) return transfer;
    throw new Error("adoption_transfer_precondition_failed");
  }
  const expectedFingerprint = createAdoptionTransferChunkFingerprint(chunk);
  if (chunk.fingerprint !== expectedFingerprint) throw new Error("adoption_transfer_chunk_fingerprint_mismatch");
  const existing = transfer.chunks.find((candidate) => candidate.chunkId === chunk.chunkId);
  if (existing) {
    if (existing.fingerprint !== chunk.fingerprint || existing.index !== chunk.index) throw new Error("adoption_transfer_chunk_conflict");
    return transfer;
  }
  const chunks = Object.freeze([...transfer.chunks, Object.freeze({ ...chunk, recordKeys: Object.freeze([...chunk.recordKeys].sort()) })].sort((a, b) => a.index - b.index));
  return Object.freeze({ ...transfer, chunks, chunkCount: chunks.length, updatedAt: isoNow() });
}

export function sealAdoptionTransfer(transfer: AdoptionTransfer, input: Readonly<{ snapshotFingerprint: string; recordCount: number; chunkCount: number; expectedState?: "collecting" | "sealing"; idempotencyKey?: string }>): AdoptionTransfer {
  if (transfer.state === "sealed" && transfer.snapshotFingerprint === input.snapshotFingerprint) return transfer;
  const expectedState = input.expectedState ?? "collecting";
  const sealing = transfer.state === "collecting" ? transition(transfer, "sealing", "collecting", input.idempotencyKey) : transfer;
  if (sealing.state !== "sealing") throw new Error("adoption_transfer_precondition_failed");
  if (input.recordCount !== sealing.recordCount || input.chunkCount !== sealing.chunkCount) throw new Error("adoption_transfer_snapshot_incomplete");
  if (expectedState !== "collecting" && transfer.state !== expectedState) throw new Error("adoption_transfer_precondition_failed");
  const expected = createAdoptionSnapshotSeal({ guestUserId: sealing.guestUserId, snapshotVersion: sealing.snapshotVersion, records: sealing.records, chunks: sealing.chunks });
  if (expected !== input.snapshotFingerprint) throw new Error("adoption_transfer_snapshot_seal_mismatch");
  return Object.freeze({ ...sealing, state: "sealed", snapshotFingerprint: input.snapshotFingerprint, updatedAt: isoNow() });
}

export function beginAdoptionResultBuild(transfer: AdoptionTransfer, idempotencyKey = transfer.idempotencyKey): AdoptionTransfer {
  return transition(transfer, "result_building", "sealed", idempotencyKey);
}

export function appendAdoptionResultChunk(transfer: AdoptionTransfer, chunk: AdoptionTransferResultChunk): AdoptionTransfer {
  if (transfer.state !== "result_building") {
    if (transfer.resultChunks.some((candidate) => candidate.chunkId === chunk.chunkId && candidate.fingerprint === chunk.fingerprint)) return transfer;
    throw new Error("adoption_transfer_precondition_failed");
  }
  const existing = transfer.resultChunks.find((candidate) => candidate.chunkId === chunk.chunkId);
  if (existing) {
    if (existing.fingerprint !== chunk.fingerprint) throw new Error("adoption_transfer_result_chunk_conflict");
    return transfer;
  }
  const resultChunks = Object.freeze([...transfer.resultChunks, Object.freeze({ ...chunk, recordKeys: Object.freeze([...chunk.recordKeys]) })].sort((a, b) => a.index - b.index));
  return Object.freeze({ ...transfer, resultChunks, updatedAt: isoNow() });
}

export function markAdoptionPreviewReady(transfer: AdoptionTransfer, idempotencyKey = transfer.idempotencyKey): AdoptionTransfer {
  return transition(transfer, "preview_ready", "result_building", idempotencyKey);
}

export function addAdoptionDecision(transfer: AdoptionTransfer, decision: AdoptionTransferDecision): AdoptionTransfer {
  if (transfer.state !== "preview_ready") throw new Error("adoption_transfer_precondition_failed");
  if (transfer.snapshotFingerprint === null || decision.previewFingerprint !== transfer.snapshotFingerprint) throw new Error("adoption_transfer_decision_stale");
  const existing = transfer.decisions.find((candidate) => candidate.decisionId === decision.decisionId);
  if (existing) {
    if (canonicalJson(existing) !== canonicalJson(decision)) throw new Error("adoption_transfer_decision_conflict");
    return transfer;
  }
  const decisions = Object.freeze([...transfer.decisions, Object.freeze({ ...decision })].sort((left, right) => left.decisionId.localeCompare(right.decisionId)));
  return Object.freeze({ ...transfer, decisions, updatedAt: isoNow() });
}

export function beginAdoptionApply(transfer: AdoptionTransfer, expectedGeneration: number, idempotencyKey = transfer.idempotencyKey): AdoptionTransfer {
  if (transfer.expectedGeneration !== expectedGeneration) throw new Error("adoption_transfer_generation_conflict");
  return transition(transfer, "applying", "preview_ready", idempotencyKey);
}

export function completeAdoptionTransfer(transfer: AdoptionTransfer, expectedGeneration: number, nextGeneration: number): AdoptionTransfer {
  if (transfer.state !== "applying" || transfer.expectedGeneration !== expectedGeneration || nextGeneration !== transfer.targetGeneration || nextGeneration <= expectedGeneration) throw new Error("adoption_transfer_generation_conflict");
  return Object.freeze({ ...transfer, state: "complete", generation: nextGeneration, updatedAt: isoNow() });
}

export function failAdoptionTransfer(transfer: AdoptionTransfer, errorCode: string): AdoptionTransfer {
  if (!errorCode.trim()) throw new Error("adoption_transfer_failure_required");
  if (transfer.state === "complete") throw new Error("adoption_transfer_precondition_failed");
  return Object.freeze({ ...transfer, state: "failed", failureCode: errorCode, updatedAt: isoNow() });
}

export function assertAtomicTrackGroups(records: readonly AdoptionTransferRecord[]): void {
  const byTrack = new Map<string, Set<string>>();
  for (const record of records) {
    if (record.recordType !== "goal" && record.recordType !== "learning_plan") continue;
    const types = byTrack.get(record.trackId) ?? new Set<string>();
    types.add(record.recordType);
    byTrack.set(record.trackId, types);
  }
  for (const types of byTrack.values()) if (types.size !== 2) throw new Error("adoption_transfer_track_group_incomplete");
}

export function buildAdoptionResultChunks(records: readonly AdoptionTransferRecord[], maxBytes = 512 * 1024): readonly (readonly AdoptionTransferRecord[])[] {
  assertAtomicTrackGroups(records);
  const groups = new Map<string, AdoptionTransferRecord[]>();
  for (const record of records) {
    const key = record.recordType === "goal" || record.recordType === "learning_plan" ? `track:${record.trackId}` : adoptionTransferRecordKey(record);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  const result: AdoptionTransferRecord[][] = [];
  let current: AdoptionTransferRecord[] = [];
  for (const group of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, values]) => values)) {
    const candidate = [...current, ...group];
    if (canonicalJsonBytes({ schema: CANONICAL_JSON_VERSION, records: candidate }) > maxBytes) {
      if (current.length === 0) throw new Error("adoption_transfer_result_chunk_too_large");
      result.push(current);
      current = [];
      if (canonicalJsonBytes({ schema: CANONICAL_JSON_VERSION, records: group }) > maxBytes) throw new Error("adoption_transfer_result_chunk_too_large");
    }
    current.push(...group);
  }
  if (current.length > 0) result.push(current);
  return Object.freeze(result.map((chunk) => Object.freeze(chunk)));
}

export function compareAndSwapAdoptionGeneration(currentGeneration: number, expectedGeneration: number, targetGeneration: number): number {
  if (currentGeneration !== expectedGeneration || targetGeneration <= expectedGeneration) throw new Error("adoption_transfer_generation_conflict");
  return targetGeneration;
}
