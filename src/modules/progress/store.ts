import { FieldValue, Timestamp, type Firestore, type DocumentReference, type CollectionReference, type DocumentSnapshot } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { canonicalJson, canonicalJsonBytes } from "../../infrastructure/identity/canonicalJson.js";
import {
  COLLECTIONS,
  adoptionTransferChunkDocumentId,
  adoptionTransferDecisionDocumentId,
  adoptionTransferIdempotencyDocumentId,
  adoptionTransferRecordDocumentId,
  progressDocumentId,
} from "../../infrastructure/firestore/paths.js";
import { asIsoString, asRecord, now } from "../../infrastructure/firestore/values.js";
import {
  buildGuestMergePreview,
  assertGoalPlanBundles, assertGoalPlanRecordShapes,
  guestMergeSnapshotSchema,
  createMergeRecordFingerprint,
  mergeRecordKey,
  progressRecordToMergeRecord,
  validateGuestMergeConfirmation,
  type AdoptionExecution,
  type AdoptionPreview,
  type GuestMergeConfirmation,
  type GuestMergeRecord,
  type GuestMergeSnapshot,
} from "../users/merge.js";
import {
  ADOPTION_TRANSFER_MAX_CANONICAL_BYTES,
  ADOPTION_TRANSFER_FIRESTORE_BATCH_SIZE,
  ADOPTION_TRANSFER_MAX_RECORDS,
  ADOPTION_TRANSFER_TTL_MS,
  adoptionTransferApplySchema,
  adoptionTransferChunkSchema,
  adoptionTransferConfirmSchema,
  adoptionTransferPreviewSchema,
  adoptionTransferRecordSchema,
  adoptionTransferSealSchema,
  adoptionTransferStateSchema,
  adoptionTransferStartSchema,
  adoptionTransferUploadSchema,
  appendAdoptionTransferChunk,
  appendAdoptionTransferRecord,
  adoptionTransferRecordKey,
  beginAdoptionApply,
  beginAdoptionResultBuild,
  buildAdoptionResultChunks,
  completeAdoptionTransfer,
  createAdoptionSnapshotSeal,
  createAdoptionTransfer,
  createAdoptionTransferChunkFingerprint,
  markAdoptionPreviewReady,
  sealAdoptionTransfer,
  type AdoptionTransfer,
  type AdoptionTransferApply,
  type AdoptionTransferConfirm,
  type AdoptionTransferPreviewRequest,
  type AdoptionTransferSeal,
  type AdoptionTransferStart,
  type AdoptionTransferUpload,
} from "../users/adoptionTransfer.js";
import { legacySyncableRecordTypeSchema, syncableRecordTypeSchema, type ProgressMutation, type ProgressRecord, type ProgressSnapshot, type ProgressStore, type SyncBatchMetadata, type SyncBatchResult } from "./contracts.js";

const ACCOUNT_METADATA_ID = "account";
const SYNC_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const ADOPTION_RECORDS_SUBCOLLECTION = "records";
const ADOPTION_CHUNKS_SUBCOLLECTION = "chunks";
const ADOPTION_DECISIONS_SUBCOLLECTION = "decisions";
const ADOPTION_RESULTS_SUBCOLLECTION = "results";
const ADOPTION_GENERATIONS_SUBCOLLECTION = "progressGenerations";
const ADOPTION_PROMOTION_LEASE_MS = 5 * 60 * 1_000;

function adoptionPromotionLease(): Timestamp {
  return Timestamp.fromMillis(Date.now() + ADOPTION_PROMOTION_LEASE_MS);
}

function hasActiveAdoptionPromotionLease(data: Record<string, unknown> | undefined): boolean {
  const sessionId = data?.adoptionPromotionSessionId;
  const expiresAt = data?.adoptionPromotionLeaseExpiresAt;
  return typeof sessionId === "string" && expiresAt instanceof Timestamp && expiresAt.toMillis() > Date.now();
}

function expiresAfterSyncRetention(createdAt: Timestamp): Timestamp {
  return Timestamp.fromMillis(createdAt.toMillis() + SYNC_RETENTION_MS);
}

function toView(data: Record<string, unknown>): ProgressRecord {
  const kind = data.kind;
  const trackId = data.trackId;
  const targetId = data.targetId;
  const version = data.version;
  const fingerprint = data.fingerprint;
  const lastMutationId = data.lastMutationId;
  const parsedRecordType = syncableRecordTypeSchema.safeParse(data.recordType);
  if (kind !== "node" && kind !== "item" || !parsedRecordType.success || typeof trackId !== "string" || typeof targetId !== "string" || typeof version !== "number" || !Number.isSafeInteger(version) || version < 0 || typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint) || typeof lastMutationId !== "string") throw new Error("progress_record_invalid");
  const state = asRecord(data.state, "progress_state");
  if (createMergeRecordFingerprint({ recordId: targetId, recordType: parsedRecordType.data, state, trackId }) !== fingerprint) throw new Error("progress_fingerprint_mismatch");
  return Object.freeze({ kind, recordType: parsedRecordType.data, trackId, targetId, version, fingerprint, state, lastMutationId, updatedAt: asIsoString(data.updatedAt, "progress_updated_at") });
}

function mergeRecordToMutation(record: GuestMergeRecord, mutationId: string, expectedVersion: number | null): ProgressMutation {
  const kind = record.recordType === "training_attempt" || record.recordType === "review_queue_entry" ? "item" : "node";
  return { mutationId, kind, recordType: record.recordType, trackId: record.trackId, targetId: record.recordId, expectedVersion, fingerprint: record.fingerprint, state: record.state };
}

function accountMetadataRef(db: Firestore, userId: string): DocumentReference {
  return db.collection(COLLECTIONS.users).doc(userId).collection("syncMetadata").doc(ACCOUNT_METADATA_ID);
}

function progressCollectionRef(db: Firestore, userId: string, generation: number): CollectionReference {
  const userRef = db.collection(COLLECTIONS.users).doc(userId);
  return generation === 0 ? userRef.collection("progress") : userRef.collection(ADOPTION_GENERATIONS_SUBCOLLECTION).doc(String(generation)).collection(ADOPTION_RECORDS_SUBCOLLECTION);
}

function progressGenerationRef(db: Firestore, userId: string, generation: number): DocumentReference {
  return db.collection(COLLECTIONS.users).doc(userId).collection(ADOPTION_GENERATIONS_SUBCOLLECTION).doc(String(generation));
}

function legacyProgressDocumentId(mutation: Pick<ProgressMutation, "kind" | "recordType" | "targetId">): string {
  return progressDocumentId({ kind: mutation.kind, recordType: mutation.recordType, targetId: mutation.targetId });
}

function accountAdoptionCollectionRef(db: Firestore, accountId: string): CollectionReference {
  return db.collection(COLLECTIONS.accounts).doc(accountId).collection("adoptionTransfers");
}

function accountAdoptionRef(db: Firestore, accountId: string, sessionId: string): DocumentReference {
  return accountAdoptionCollectionRef(db, accountId).doc(sessionId);
}

function adoptionTransferIdempotencyRef(db: Firestore, accountId: string, idempotencyKey: string): DocumentReference {
  return db.collection(COLLECTIONS.accounts).doc(accountId).collection("adoptionTransferIdempotency").doc(adoptionTransferIdempotencyDocumentId(idempotencyKey));
}

function adoptionChildRef(db: Firestore, accountId: string, sessionId: string, collection: string, id: string): DocumentReference {
  return accountAdoptionRef(db, accountId, sessionId).collection(collection).doc(id);
}

function adoptionExpiresAt(createdAt: Timestamp): Timestamp {
  return Timestamp.fromMillis(createdAt.toMillis() + ADOPTION_TRANSFER_TTL_MS);
}

const adoptionRecordKey = adoptionTransferRecordKey;

function adoptionRecordFingerprint(record: Readonly<{ recordType: string; recordId: string; trackId: string; state: Readonly<Record<string, unknown>> }>): string {
  return createHash("sha256").update(canonicalJson({ recordId: record.recordId, recordType: record.recordType, state: record.state, trackId: record.trackId }), "utf8").digest("hex");
}

function adoptionSnapshotEnvelopeBytes(guestUserId: string, snapshotVersion: number, recordCount: number, recordPayloadBytes: number): number {
  // `recordPayloadBytes` is the exact sum of canonical record JSON bytes.  A
  // canonical array adds one comma between adjacent records; all other bytes
  // are the fixed envelope, so this avoids storing a full record table in the
  // operation document while still enforcing the complete envelope limit.
  const empty = canonicalJsonBytes({ schema: "canonical-json-v1", guestUserId, records: [], snapshotVersion });
  return empty - 2 + recordPayloadBytes + Math.max(0, recordCount - 1);
}

function recordPayloadBytes(record: Readonly<{ recordType: string; recordId: string; trackId: string; fingerprint: string; state: Readonly<Record<string, unknown>>; version: number }>): number {
  return canonicalJsonBytes(record);
}

function adoptionKind(recordType: string): "node" | "item" {
  return recordType === "training_attempt" || recordType === "review_queue_entry" ? "item" : "node";
}

function readStoredAdoptionTransfer(data: Record<string, unknown>): AdoptionTransfer {
  const accountId = typeof data.accountId === "string" ? data.accountId : "";
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
  const guestUserId = typeof data.guestUserId === "string" ? data.guestUserId : "";
  const state = adoptionTransferStateSchema.safeParse(data.state);
  const expectedGeneration = data.expectedGeneration;
  const generation = data.generation;
  const targetGeneration = data.targetGeneration === undefined ? Number(expectedGeneration) + 1 : data.targetGeneration;
  const snapshotVersion = data.snapshotVersion;
  const recordCount = data.recordCount;
  const chunkCount = data.chunkCount;
  const operationFingerprint = data.operationFingerprint;
  const idempotencyKey = data.idempotencyKey;
  if (!accountId || !sessionId || !guestUserId || !state.success || !Number.isSafeInteger(expectedGeneration) || !Number.isSafeInteger(generation) || !Number.isSafeInteger(targetGeneration) || Number(targetGeneration) <= Number(expectedGeneration) || !Number.isSafeInteger(snapshotVersion) || !Number.isSafeInteger(recordCount) || !Number.isSafeInteger(chunkCount) || typeof operationFingerprint !== "string" || typeof idempotencyKey !== "string") throw new Error("adoption_transfer_invalid");
  return Object.freeze({
    version: 3,
    accountId,
    sessionId,
    guestUserId,
    state: state.data,
    expectedGeneration: Number(expectedGeneration),
    generation: Number(generation),
    targetGeneration: Number(targetGeneration),
    snapshotVersion: Number(snapshotVersion),
    recordCount: Number(recordCount),
    chunkCount: Number(chunkCount),
    snapshotFingerprint: typeof data.snapshotFingerprint === "string" ? data.snapshotFingerprint : null,
    records: Object.freeze([]),
    chunks: Object.freeze([]),
    decisions: Object.freeze([]),
    resultChunks: Object.freeze([]),
    failureCode: typeof data.failureCode === "string" ? data.failureCode : null,
    operationFingerprint,
    idempotencyKey,
    updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt.toDate().toISOString() : typeof data.updatedAt === "string" ? data.updatedAt : new Date(0).toISOString(),
  });
}

function parseAdoptionRecord(data: Record<string, unknown>): import("../users/adoptionTransfer.js").AdoptionTransferRecord {
  const parsed = adoptionTransferRecordSchema.safeParse({ recordType: data.recordType, recordId: data.recordId, trackId: data.trackId, fingerprint: data.fingerprint, state: data.state, version: data.version });
  if (!parsed.success) throw new Error("adoption_transfer_record_invalid");
  if (adoptionRecordFingerprint(parsed.data) !== parsed.data.fingerprint) throw new Error("progress_fingerprint_mismatch");
  return Object.freeze(parsed.data);
}

function parseAdoptionChunk(data: Record<string, unknown>): import("../users/adoptionTransfer.js").AdoptionTransferChunk {
  const chunk = {
    chunkId: data.chunkId,
    index: data.index,
    recordKeys: data.recordKeys,
    fingerprint: data.fingerprint,
    bytes: data.bytes,
  };
  const parsed = adoptionTransferChunkSchema.safeParse(chunk);
  if (!parsed.success || createAdoptionTransferChunkFingerprint(parsed.data) !== parsed.data.fingerprint) throw new Error("adoption_transfer_chunk_invalid");
  return Object.freeze(parsed.data);
}

function adoptionStatusFromData(data: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const status: Record<string, unknown> = {
    version: 3,
    accountId: data.accountId,
    sessionId: data.sessionId,
    guestUserId: data.guestUserId,
    state: data.state,
    expectedGeneration: data.expectedGeneration,
    generation: data.generation,
    targetGeneration: data.targetGeneration ?? (typeof data.expectedGeneration === "number" ? data.expectedGeneration + 1 : null),
    snapshotVersion: data.snapshotVersion,
    recordCount: data.recordCount,
    chunkCount: data.chunkCount,
    snapshotFingerprint: data.snapshotFingerprint ?? null,
    previewFingerprint: data.previewFingerprint ?? null,
    operationId: data.previewOperationId ?? null,
    decisionFingerprint: data.decisionFingerprint ?? null,
    applyCursor: data.applyCursor ?? 0,
    applyTotal: data.applyTotal ?? null,
    accountRevision: data.accountRevision ?? null,
    failureCode: data.failureCode ?? null,
  };
  return Object.freeze(status);
}

function adoptionOperationFields(transfer: AdoptionTransfer, createdAt: Timestamp, expiresAt: Timestamp, input: AdoptionTransferStart): Record<string, unknown> {
  return {
    version: 3,
    accountId: transfer.accountId,
    sessionId: transfer.sessionId,
    guestUserId: transfer.guestUserId,
    state: transfer.state,
    expectedGeneration: transfer.expectedGeneration,
    generation: transfer.generation,
    targetGeneration: transfer.targetGeneration,
    snapshotVersion: transfer.snapshotVersion,
    recordCount: transfer.recordCount,
    chunkCount: transfer.chunkCount,
    snapshotFingerprint: null,
    failureCode: null,
    operationFingerprint: transfer.operationFingerprint,
    idempotencyKey: transfer.idempotencyKey,
    deviceId: input.deviceId,
    activeSession: input.activeSession,
    pendingJournal: input.pendingJournal,
    canonicalRecordBytes: 0,
    createdAt,
    updatedAt: createdAt,
    expiresAt,
  };
}

export function createAdoptionDecisionFingerprint(input: AdoptionTransferConfirm): string {
  const resolutions = [...input.resolutions].sort((left, right) => left.conflictId.localeCompare(right.conflictId));
  const groupChoices = [...(input.groupChoices ?? [])].sort((left, right) => left.groupId.localeCompare(right.groupId));
  return createHash("sha256").update(canonicalJson({
    schema: "adoption-transfer-v3-decision",
    deviceId: input.deviceId,
    previewFingerprint: input.previewFingerprint,
    protocolVersion: input.protocolVersion,
    resolutions,
    groupChoices,
  }), "utf8").digest("hex");
}

function adoptionPreviewSnapshot(input: Readonly<{ guestUserId: string; snapshotVersion: number; protocolVersion: 1 | 2; activeSession: boolean; pendingJournal: boolean }>, records: readonly import("../users/adoptionTransfer.js").AdoptionTransferRecord[]): GuestMergeSnapshot {
  return {
    protocolVersion: input.protocolVersion,
    guestSnapshotVersion: input.snapshotVersion,
    guestUserId: input.guestUserId,
    activeSession: input.activeSession,
    pendingJournal: input.pendingJournal,
    records: records.map((record) => ({
      fingerprint: record.fingerprint,
      recordId: record.recordId,
      recordType: record.recordType as import("../progress/contracts.js").SyncableRecordType,
      state: record.state,
      trackId: record.trackId,
      version: record.version,
    })),
  } as GuestMergeSnapshot;
}

function ensureFullIdentityUniqueness(records: readonly Readonly<{ recordType: string; recordId: string; trackId: string }>[]): void {
  const fullKeys = new Set<string>();
  for (const record of records) {
    const fullKey = adoptionRecordKey(record);
    if (fullKeys.has(fullKey)) throw new Error("adoption_transfer_duplicate_record_key");
    fullKeys.add(fullKey);
  }
}

function parseAdoptionDecisionRows(rows: readonly DocumentSnapshot[]): AdoptionTransferConfirm | null {
  if (rows.length === 0) return null;
  const first = asRecord(rows[0]!.data(), "adoption_decision");
  const resolutions = rows.filter((row) => row.get("kind") === "resolution").map((row) => {
    const data = asRecord(row.data(), "adoption_resolution");
    return { conflictId: String(data.conflictId), resolution: data.resolution as "keep_guest" | "keep_account" | "manual_required" };
  });
  const groupChoices = rows.filter((row) => row.get("kind") === "group_choice").map((row) => {
    const data = asRecord(row.data(), "adoption_group_choice");
    return { groupId: String(data.groupId), resolution: data.resolution as "keep_guest" | "keep_account" };
  });
  const parsed = adoptionTransferConfirmSchema.safeParse({
    canonicalVersion: "canonical-json-v1",
    deviceId: first.deviceId,
    previewFingerprint: first.previewFingerprint,
    decisionFingerprint: first.decisionFingerprint,
    protocolVersion: first.protocolVersion,
    resolutions,
    ...(groupChoices.length > 0 ? { groupChoices } : {}),
  });
  if (!parsed.success) throw new Error("adoption_transfer_decision_invalid");
  return parsed.data;
}

type AdoptionMaterialization = Readonly<{
  records: readonly GuestMergeRecord[];
  changes: readonly Readonly<{ record: GuestMergeRecord; remote: GuestMergeRecord | undefined; mutationId: string }>[];
}>;

function buildAdoptionMaterialization(operationId: string, guestRecords: readonly GuestMergeRecord[], remoteRecords: readonly GuestMergeRecord[], confirmation: GuestMergeConfirmation): AdoptionMaterialization {
  // Guest and account snapshots may contain the same logical record. That is
  // the normal deduplication path, not a malformed snapshot. Validate each
  // source independently so only duplicate/ambiguous identities within one
  // source are rejected.
  ensureFullIdentityUniqueness(guestRecords);
  ensureFullIdentityUniqueness(remoteRecords);
  const remoteByKey = new Map(remoteRecords.map((record) => [adoptionRecordKey(record), record]));
  const localByKey = new Map(guestRecords.map((record) => [adoptionRecordKey(record), record]));
  const resolved = new Map(remoteByKey);
  const changes: Array<{ record: GuestMergeRecord; remote: GuestMergeRecord | undefined; mutationId: string }> = [];
  const groupedKeys = new Set<string>();

  if (confirmation.protocolVersion === 2) {
    const preview = buildGuestMergePreview({ accountUserId: "00000000-0000-4000-8000-000000000000", accountSnapshotVersion: 0, guestSnapshot: { protocolVersion: 2, guestSnapshotVersion: 0, guestUserId: "11111111-1111-4111-8111-111111111111", records: [...guestRecords], activeSession: false, pendingJournal: false }, remoteRecords, identityMode: "full" });
    const previewGroups = preview.preview.protocolVersion === 2 ? preview.preview.goalPlanConflictGroups : [];
    for (const group of previewGroups) {
      for (const key of [...group.localRecordIds, ...group.accountRecordIds]) groupedKeys.add(key);
      const choice = confirmation.groupChoices.find((candidate) => candidate.groupId === group.groupId);
      if (!choice || choice.resolution === "keep_account") continue;
      for (const recordType of ["goal", "learning_plan"] as const) {
        const key = adoptionRecordKey({ recordType, recordId: group.trackId, trackId: group.trackId });
        const local = localByKey.get(key);
        const remote = remoteByKey.get(key);
        if (local && local.state.deleted !== true) queue(local, remote, key);
        else if (remote && remote.state.deleted !== true) {
          const tombstoneState = Object.freeze({ deleted: true });
          const tombstone: GuestMergeRecord = Object.freeze({ fingerprint: createMergeRecordFingerprint({ recordId: group.trackId, recordType, state: tombstoneState, trackId: group.trackId }), recordId: group.trackId, recordType, state: tombstoneState, trackId: group.trackId, version: remote.version });
          queue(tombstone, remote, key);
        }
      }
    }
  }
  for (const record of guestRecords) {
    const key = adoptionRecordKey(record);
    if (groupedKeys.has(key)) continue;
    const remote = remoteByKey.get(key);
    if (remote?.fingerprint === record.fingerprint) continue;
    const resolution = confirmation.resolutions.find((candidate) => candidate.conflictId === key);
    if (remote && resolution?.resolution === "keep_account") continue;
    queue(record, remote, key);
  }
  if (confirmation.protocolVersion === 2) assertGoalPlanBundles([...resolved.values()]);
  return Object.freeze({
    records: Object.freeze([...resolved.values()].sort((left, right) => adoptionRecordKey(left).localeCompare(adoptionRecordKey(right)))),
    changes: Object.freeze(changes),
  });

  function queue(record: GuestMergeRecord, remote: GuestMergeRecord | undefined, key: string): void {
    if (remote?.fingerprint === record.fingerprint) return;
    const nextVersion = (remote?.version ?? 0) + 1;
    const updated = Object.freeze({ ...record, version: nextVersion });
    const mutationId = adoptionMutationId(operationId, key, updated.fingerprint);
    resolved.set(key, updated);
    changes.push({ record: updated, remote, mutationId });
  }
}

function operationRef(db: Firestore, userId: string, operationId: string): DocumentReference {
  return db.collection(COLLECTIONS.users).doc(userId).collection("syncOperations").doc(operationId);
}

function syncBatchRef(db: Firestore, userId: string, metadata: SyncBatchMetadata): DocumentReference {
  const id = createHash("sha256").update(`${metadata.sessionId}:${metadata.batchId}`, "utf8").digest("hex");
  return db.collection(COLLECTIONS.users).doc(userId).collection("syncBatches").doc(id);
}

function syncBatchFingerprint(metadata: SyncBatchMetadata, expectedAccountRevision: number, mutations: readonly ProgressMutation[]): string {
  return createHash("sha256").update(canonicalJson({ metadata, expectedAccountRevision, mutations }), "utf8").digest("hex");
}

function readAccountRevision(data: Record<string, unknown> | undefined): number {
  if (!data || data.accountRevision === undefined) return 0;
  if (!Number.isSafeInteger(data.accountRevision) || Number(data.accountRevision) < 0) throw new Error("account_revision_invalid");
  return Number(data.accountRevision);
}

function readAccountGeneration(data: Record<string, unknown> | undefined): number {
  if (!data || data.generation === undefined) return 0;
  if (!Number.isSafeInteger(data.generation) || Number(data.generation) < 0) throw new Error("account_generation_invalid");
  return Number(data.generation);
}

function readAdoptionGenerationCounter(data: Record<string, unknown> | undefined, activeGeneration: number): number {
  if (!data || data.adoptionGenerationCounter === undefined) return activeGeneration;
  if (!Number.isSafeInteger(data.adoptionGenerationCounter) || Number(data.adoptionGenerationCounter) < activeGeneration) throw new Error("account_generation_invalid");
  return Number(data.adoptionGenerationCounter);
}

export class FirestoreProgressStore implements ProgressStore {
  public constructor(private readonly db: Firestore) {}

  public async read(userId: string, protocolVersion: 1 | 2 = 1): Promise<readonly ProgressRecord[]> {
    return (await this.readSnapshot(userId, protocolVersion)).records;
  }

  public async readSnapshot(userId: string, protocolVersion: 1 | 2 = 1): Promise<ProgressSnapshot> {
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const meta = await accountMetadataRef(this.db, userId).get();
    const metadata = meta.data() as Record<string, unknown> | undefined;
    const generation = readAccountGeneration(metadata);
    const snapshot = await progressCollectionRef(this.db, userId, generation).get();
    const records = snapshot.docs.map((document) => toView(asRecord(document.data(), "progress")))
      .filter((record) => protocolVersion === 2 || legacySyncableRecordTypeSchema.safeParse(record.recordType).success);
    return Object.freeze({ accountRevision: readAccountRevision(metadata), generation, records: Object.freeze(records) });
  }

  public async previewAdoption(userId: string, guestSnapshot: GuestMergeSnapshot): Promise<AdoptionPreview> {
    const parsedSnapshot = guestMergeSnapshotSchema.parse(guestSnapshot);
    const remote = await this.readSnapshot(userId, parsedSnapshot.protocolVersion);
    return buildGuestMergePreview({
      accountUserId: userId,
      accountSnapshotVersion: remote.accountRevision,
      guestSnapshot: parsedSnapshot,
      remoteRecords: remote.records.map(progressRecordToMergeRecord),
    });
  }

  public async confirmAdoption(userId: string, deviceId: string, guestSnapshot: GuestMergeSnapshot, confirmation: GuestMergeConfirmation): Promise<AdoptionExecution> {
    const parsedGuestSnapshot = guestMergeSnapshotSchema.parse(guestSnapshot);
    const db = this.db;
    return this.db.runTransaction(async (transaction) => {
      const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
      const user = await transaction.get(userRef);
      if (!user.exists || asRecord(user.data(), "user").deletedAt !== undefined) throw new Error("account_deleted");
      const metaRef = accountMetadataRef(this.db, userId);
      const operation = operationRef(this.db, userId, confirmation.operationId);
      const metaSnapshot = await transaction.get(metaRef);
      const metadata = metaSnapshot.data() as Record<string, unknown> | undefined;
      const activeGeneration = readAccountGeneration(metadata);
      const progressSnapshot = await transaction.get(progressCollectionRef(this.db, userId, activeGeneration));
      const operationSnapshot = await transaction.get(operation);
      if (operationSnapshot.exists) {
        const stored = asRecord(operationSnapshot.data(), "sync_operation");
        if (stored.previewFingerprint !== confirmation.previewFingerprint || stored.guestUserId !== parsedGuestSnapshot.guestUserId) throw new Error("mutation_id_reuse");
        if (stored.protocolVersion !== undefined && stored.protocolVersion !== confirmation.protocolVersion) throw new Error("mutation_id_reuse");
        if (stored.confirmation !== undefined && JSON.stringify(stored.confirmation) !== JSON.stringify(confirmation)) throw new Error("mutation_id_reuse");
        if (!Number.isSafeInteger(stored.accountRevision) || Number(stored.accountRevision) < 0) throw new Error("account_revision_invalid");
        return Object.freeze({ accountRevision: Number(stored.accountRevision), operationId: confirmation.operationId, mutationIds: Object.freeze(Array.isArray(stored.mutationIds) ? stored.mutationIds.filter((value): value is string => typeof value === "string") : []), records: Object.freeze(Array.isArray(stored.records) ? stored.records.map((value) => value as GuestMergeRecord) : []) });
      }
      const accountRevision = readAccountRevision(metaSnapshot.data() as Record<string, unknown> | undefined);
      const remoteRecords = progressSnapshot.docs.map((document) => progressRecordToMergeRecord(toView(asRecord(document.data(), "progress"))))
        .filter((record) => parsedGuestSnapshot.protocolVersion === 2 || legacySyncableRecordTypeSchema.safeParse(record.recordType).success);
      const adoption = buildGuestMergePreview({ accountUserId: userId, accountSnapshotVersion: accountRevision, guestSnapshot: parsedGuestSnapshot, remoteRecords });
      if (adoption.preview.fingerprint !== confirmation.previewFingerprint || adoption.preview.operationId !== confirmation.operationId) throw new Error("merge_preview_mismatch");
      if (adoption.plan.blockingReason === "active_session") throw new Error("active_session_adoption_blocked");
      if (adoption.plan.blockingReason === "journal_recovery") throw new Error("journal_recovery_required");
      const ready = validateGuestMergeConfirmation(adoption.preview, confirmation);
      const remoteByKey = new Map(remoteRecords.map((record) => [mergeRecordKey(record), record]));
      const resolved = new Map(remoteByKey);
      const mutationIds: string[] = [];
      const progressWrites: Array<{ mutation: ProgressMutation; ref: DocumentReference; mutationRef: DocumentReference; nextVersion: number; updatedAt: ReturnType<typeof now> }> = [];
      const groupedKeys = new Set<string>();
      if (adoption.preview.protocolVersion === 2 && ready.confirmation.protocolVersion === 2) {
        const localByKey = new Map(parsedGuestSnapshot.records.map((record) => [mergeRecordKey(record), record]));
        for (const group of adoption.preview.goalPlanConflictGroups) {
          for (const key of [...group.localRecordIds, ...group.accountRecordIds]) groupedKeys.add(key);
          const choice = ready.confirmation.groupChoices.find((candidate) => candidate.groupId === group.groupId)!;
          if (choice.resolution === "keep_account") continue;
          for (const recordType of ["goal", "learning_plan"] as const) {
            const key = `${recordType}:${group.trackId}`;
            const local = localByKey.get(key);
            const remote = remoteByKey.get(key);
            if (local && local.state.deleted !== true) {
              if (remote?.fingerprint === local.fingerprint) continue;
              queueWrite(local, remote, key);
            } else if (remote && remote.state.deleted !== true) {
              const tombstoneState = Object.freeze({ deleted: true });
              const tombstone: GuestMergeRecord = Object.freeze({ fingerprint: createMergeRecordFingerprint({ recordId: group.trackId, recordType, state: tombstoneState, trackId: group.trackId }), recordId: group.trackId, recordType, state: tombstoneState, trackId: group.trackId, version: remote.version });
              queueWrite(tombstone, remote, key);
            }
          }
        }
      }
      for (const record of parsedGuestSnapshot.records) {
        const key = mergeRecordKey(record);
        if (groupedKeys.has(key)) continue;
        const remote = remoteByKey.get(key);
        if (remote?.fingerprint === record.fingerprint) continue;
        if (remote && ready.confirmation.resolutions.find((resolution) => resolution.conflictId === key)?.resolution === "keep_account") continue;
        queueWrite(record, remote, key);
      }
      if (parsedGuestSnapshot.protocolVersion === 2) assertGoalPlanBundles([...resolved.values()]);
      for (const write of progressWrites) {
        transaction.set(write.ref, {
          kind: write.mutation.kind,
          recordType: write.mutation.recordType,
          trackId: write.mutation.trackId,
          targetId: write.mutation.targetId,
          version: write.nextVersion,
          fingerprint: write.mutation.fingerprint,
          state: write.mutation.state,
          lastMutationId: write.mutation.mutationId,
          updatedAt: write.updatedAt,
        });
        transaction.create(write.mutationRef, {
          deviceId,
          mutationId: write.mutation.mutationId,
          recordType: write.mutation.recordType,
          appliedVersion: write.nextVersion,
          createdAt: write.updatedAt,
          expiresAt: expiresAfterSyncRetention(write.updatedAt),
          operationId: confirmation.operationId,
        });
      }
      const nextAccountRevision = accountRevision + progressWrites.length;
      if (progressWrites.length > 0) transaction.set(metaRef, { accountRevision: nextAccountRevision, updatedAt: now() }, { merge: true });
      const records = [...resolved.values()].sort((left, right) => mergeRecordKey(left).localeCompare(mergeRecordKey(right)));
      const createdAt = now();
      transaction.create(operation, {
        accountRevision: nextAccountRevision,
        createdAt,
        expiresAt: expiresAfterSyncRetention(createdAt),
        deviceId,
        guestUserId: parsedGuestSnapshot.guestUserId,
        mutationIds,
        previewFingerprint: confirmation.previewFingerprint,
        protocolVersion: confirmation.protocolVersion,
        confirmation,
        records,
      });
      return Object.freeze({ accountRevision: nextAccountRevision, operationId: confirmation.operationId, mutationIds: Object.freeze(mutationIds), records: Object.freeze(records) });

      function queueWrite(record: GuestMergeRecord, remote: GuestMergeRecord | undefined, key: string): void {
        const mutationId = adoptionMutationId(confirmation.operationId, key, record.fingerprint);
        const mutation = mergeRecordToMutation(record, mutationId, remote?.version ?? null);
        const ref = progressCollectionRef(db, userId, activeGeneration).doc(legacyProgressDocumentId(mutation));
        const mutationRef = userRef.collection("syncMutations").doc(mutationId);
        const nextVersion = (remote?.version ?? 0) + 1;
        const updatedAt = now();
        progressWrites.push({ mutation, ref, mutationRef, nextVersion, updatedAt });
        mutationIds.push(mutationId);
        resolved.set(key, { ...record, version: nextVersion });
      }
    });
  }

  public async startAdoptionTransfer(userId: string, input: AdoptionTransferStart): Promise<Readonly<Record<string, unknown>>> {
    const parsed = adoptionTransferStartSchema.parse(input);
    const idempotencyKey = parsed.idempotencyKey;
    const sessionId = parsed.sessionId ?? `transfer_${createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 48)}`;
    const createdAt = now();
    const expiresAt = adoptionExpiresAt(createdAt);
    const operation = accountAdoptionRef(this.db, userId, sessionId);
    const metadataRef = accountMetadataRef(this.db, userId);
    const idempotencyRef = adoptionTransferIdempotencyRef(this.db, userId, idempotencyKey);
    return this.db.runTransaction(async (transaction) => {
      const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
      const user = await transaction.get(userRef);
      if (!user.exists || asRecord(user.data(), "user").deletedAt !== undefined) throw new Error("account_deleted");
      const metadata = await transaction.get(metadataRef);
      const existing = await transaction.get(operation);
      const idempotency = await transaction.get(idempotencyRef);
      const metadataData = metadata.data() as Record<string, unknown> | undefined;
      const currentGeneration = readAccountGeneration(metadataData);
      const idempotencyData = idempotency.exists ? asRecord(idempotency.data(), "adoption_transfer_idempotency") : undefined;
      if (idempotencyData && (idempotencyData.accountId !== userId || idempotencyData.idempotencyKey !== idempotencyKey || idempotencyData.sessionId !== sessionId)) throw new Error("adoption_transfer_idempotency_mismatch");
      if (existing.exists) {
        const stored = asRecord(existing.data(), "adoption_transfer");
        if (stored.idempotencyKey !== idempotencyKey || stored.guestUserId !== parsed.guestUserId || stored.snapshotVersion !== parsed.snapshotVersion || stored.expectedGeneration !== parsed.expectedGeneration || stored.deviceId !== parsed.deviceId) throw new Error("adoption_transfer_idempotency_mismatch");
        if (!idempotency.exists) transaction.create(idempotencyRef, { accountId: userId, idempotencyKey, sessionId, targetGeneration: stored.targetGeneration ?? Number(stored.expectedGeneration) + 1, createdAt, updatedAt: createdAt, expiresAt: stored.expiresAt ?? expiresAt });
        return adoptionStatusFromData(stored);
      }
      if (currentGeneration !== parsed.expectedGeneration) throw new Error("adoption_transfer_generation_conflict");
      if (idempotency.exists) throw new Error("adoption_transfer_idempotency_mismatch");
      const targetGeneration = Math.max(currentGeneration, readAdoptionGenerationCounter(metadataData, currentGeneration)) + 1;
      const transfer = createAdoptionTransfer({ accountId: userId, sessionId, guestUserId: parsed.guestUserId, snapshotVersion: parsed.snapshotVersion, expectedGeneration: parsed.expectedGeneration, targetGeneration, idempotencyKey });
      transaction.set(this.db.collection(COLLECTIONS.accounts).doc(userId), { accountId: userId, updatedAt: createdAt }, { merge: true });
      transaction.set(metadataRef, { adoptionGenerationCounter: targetGeneration, updatedAt: createdAt }, { merge: true });
      transaction.create(idempotencyRef, { accountId: userId, idempotencyKey, sessionId, targetGeneration, createdAt, updatedAt: createdAt, expiresAt });
      transaction.create(operation, adoptionOperationFields(transfer, createdAt, expiresAt, { ...parsed, sessionId, idempotencyKey }));
      return adoptionStatusFromData({ ...adoptionOperationFields(transfer, createdAt, expiresAt, { ...parsed, sessionId, idempotencyKey }), updatedAt: createdAt });
    });
  }

  public async uploadAdoptionTransfer(userId: string, sessionId: string, input: AdoptionTransferUpload): Promise<Readonly<Record<string, unknown>>> {
    const parsed = adoptionTransferUploadSchema.parse(input);
    const records = parsed.records.map((record) => adoptionTransferRecordSchema.parse(record));
    const fullKeys = records.map(adoptionRecordKey);
    if (new Set(fullKeys).size !== fullKeys.length) throw new Error("adoption_transfer_duplicate_record_key");
    const expectedKeys = [...fullKeys].sort();
    const declaredKeys = [...parsed.chunk.recordKeys].sort();
    if (expectedKeys.length !== declaredKeys.length || expectedKeys.some((key, index) => key !== declaredKeys[index])) throw new Error("adoption_transfer_chunk_records_mismatch");
    if (parsed.chunk.fingerprint !== createAdoptionTransferChunkFingerprint(parsed.chunk)) throw new Error("adoption_transfer_chunk_fingerprint_mismatch");
    for (const record of records) if (adoptionRecordFingerprint(record) !== record.fingerprint) throw new Error("progress_fingerprint_mismatch");
    const operation = accountAdoptionRef(this.db, userId, sessionId);
    return this.db.runTransaction(async (transaction) => {
      const operationSnapshot = await transaction.get(operation);
      if (!operationSnapshot.exists) throw new Error("adoption_transfer_not_found");
      const storedData = asRecord(operationSnapshot.data(), "adoption_transfer");
      const transfer = readStoredAdoptionTransfer(storedData);
      if (storedData.deviceId !== parsed.deviceId) throw new Error("adoption_transfer_device_mismatch");
      if (transfer.state !== "collecting") {
        const existingChunk = await transaction.get(adoptionChildRef(this.db, userId, sessionId, ADOPTION_CHUNKS_SUBCOLLECTION, adoptionTransferChunkDocumentId(parsed.chunk.chunkId)));
        if (existingChunk.exists && parseAdoptionChunk(asRecord(existingChunk.data(), "adoption_chunk")).fingerprint === parsed.chunk.fingerprint) return adoptionStatusFromData(storedData);
        throw new Error("adoption_transfer_precondition_failed");
      }
      // Invoke the pure primitive for transition/fingerprint validation; the
      // Firestore children below are the durable representation of its arrays.
      let candidate = appendAdoptionTransferChunk(transfer, parsed.chunk, parsed.idempotencyKey ?? parsed.chunk.chunkId);
      for (const record of records) candidate = appendAdoptionTransferRecord(candidate, record, parsed.idempotencyKey ?? record.fingerprint);
      const chunkRef = adoptionChildRef(this.db, userId, sessionId, ADOPTION_CHUNKS_SUBCOLLECTION, adoptionTransferChunkDocumentId(parsed.chunk.chunkId));
      const existingChunk = await transaction.get(chunkRef);
      if (existingChunk.exists) {
        const oldChunk = parseAdoptionChunk(asRecord(existingChunk.data(), "adoption_chunk"));
        if (oldChunk.fingerprint !== parsed.chunk.fingerprint || oldChunk.index !== parsed.chunk.index || canonicalJson(oldChunk.recordKeys) !== canonicalJson(parsed.chunk.recordKeys) || oldChunk.bytes !== parsed.chunk.bytes) throw new Error("adoption_transfer_chunk_conflict");
        return adoptionStatusFromData(storedData);
      }
      if (transfer.recordCount + records.length > ADOPTION_TRANSFER_MAX_RECORDS) throw new Error("adoption_transfer_record_limit");
      const recordRefs = records.map((record) => adoptionChildRef(this.db, userId, sessionId, ADOPTION_RECORDS_SUBCOLLECTION, adoptionTransferRecordDocumentId(record)));
      const existingRecords = await transaction.getAll(...recordRefs);
      for (let index = 0; index < records.length; index += 1) {
        const existingRecord = existingRecords[index]!;
        if (existingRecord.exists) {
          const oldRecord = parseAdoptionRecord(asRecord(existingRecord.data(), "adoption_record"));
          if (oldRecord.fingerprint !== records[index]!.fingerprint || oldRecord.version !== records[index]!.version || canonicalJson(oldRecord.state) !== canonicalJson(records[index]!.state)) throw new Error("adoption_transfer_record_conflict");
          throw new Error("adoption_transfer_duplicate_record_key");
        }
      }
      const canonicalRecordBytes = Number(storedData.canonicalRecordBytes ?? 0) + records.reduce((sum, record) => sum + recordPayloadBytes(record), 0);
      const envelopeBytes = adoptionSnapshotEnvelopeBytes(transfer.guestUserId, transfer.snapshotVersion, transfer.recordCount + records.length, canonicalRecordBytes);
      if (envelopeBytes > ADOPTION_TRANSFER_MAX_CANONICAL_BYTES) throw new Error("adoption_transfer_envelope_too_large");
      const createdAt = now();
      for (let index = 0; index < records.length; index += 1) {
        transaction.create(recordRefs[index]!, { ...records[index], recordKey: fullKeys[index], createdAt, updatedAt: createdAt, expiresAt: storedData.expiresAt });
      }
      transaction.create(chunkRef, { ...parsed.chunk, recordKeys: expectedKeys, createdAt, updatedAt: createdAt, expiresAt: storedData.expiresAt });
      const update = { recordCount: transfer.recordCount + records.length, chunkCount: transfer.chunkCount + 1, canonicalRecordBytes, updatedAt: createdAt };
      transaction.update(operation, update);
      return adoptionStatusFromData({ ...storedData, ...update });
    });
  }

  public async sealAdoptionTransfer(userId: string, sessionId: string, input: AdoptionTransferSeal): Promise<Readonly<Record<string, unknown>>> {
    const parsed = adoptionTransferSealSchema.parse(input);
    const operation = accountAdoptionRef(this.db, userId, sessionId);
    const first = await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(operation);
      if (!snapshot.exists) throw new Error("adoption_transfer_not_found");
      const data = asRecord(snapshot.data(), "adoption_transfer");
      if (data.deviceId !== parsed.deviceId) throw new Error("adoption_transfer_device_mismatch");
      if (data.state === "sealed" || data.state === "result_building" || data.state === "preview_ready" || data.state === "applying" || data.state === "complete") {
        if (data.snapshotFingerprint !== parsed.snapshotFingerprint) throw new Error("adoption_transfer_snapshot_seal_mismatch");
        return false;
      }
      if (data.state !== "collecting" && data.state !== "sealing") throw new Error("adoption_transfer_precondition_failed");
      if (data.state === "collecting") transaction.update(operation, { state: "sealing", updatedAt: now() });
      return true;
    });
    if (!first) {
      const stored = await operation.get();
      return adoptionStatusFromData(asRecord(stored.data(), "adoption_transfer"));
    }
    const operationSnapshot = await operation.get();
    const operationData = asRecord(operationSnapshot.data(), "adoption_transfer");
    const transfer = readStoredAdoptionTransfer(operationData);
    if (operationData.deviceId !== parsed.deviceId) throw new Error("adoption_transfer_device_mismatch");
    const recordsSnapshot = await operation.collection(ADOPTION_RECORDS_SUBCOLLECTION).get();
    const chunksSnapshot = await operation.collection(ADOPTION_CHUNKS_SUBCOLLECTION).get();
    const records = recordsSnapshot.docs.map((document) => parseAdoptionRecord(asRecord(document.data(), "adoption_record"))).sort((left, right) => adoptionRecordKey(left).localeCompare(adoptionRecordKey(right)));
    const chunks = chunksSnapshot.docs.map((document) => parseAdoptionChunk(asRecord(document.data(), "adoption_chunk"))).sort((left, right) => left.index - right.index);
    if (records.length !== parsed.recordCount || chunks.length !== parsed.chunkCount || records.length !== transfer.recordCount || chunks.length !== transfer.chunkCount) throw new Error("adoption_transfer_snapshot_incomplete");
    ensureFullIdentityUniqueness(records);
    const seenChunkKeys = new Set<string>();
    for (let index = 0; index < chunks.length; index += 1) {
      if (chunks[index]!.index !== index) throw new Error("adoption_transfer_chunk_sequence_invalid");
      for (const key of chunks[index]!.recordKeys) {
        if (seenChunkKeys.has(key)) throw new Error("adoption_transfer_duplicate_record_key");
        seenChunkKeys.add(key);
      }
    }
    if (seenChunkKeys.size !== records.length || records.some((record) => !seenChunkKeys.has(adoptionRecordKey(record)))) throw new Error("adoption_transfer_chunk_records_mismatch");
    const expected = createAdoptionSnapshotSeal({ guestUserId: transfer.guestUserId, snapshotVersion: transfer.snapshotVersion, records, chunks });
    if (expected !== parsed.snapshotFingerprint) throw new Error("adoption_transfer_snapshot_seal_mismatch");
    const sealed = sealAdoptionTransfer(Object.freeze({ ...transfer, records, chunks, recordCount: records.length, chunkCount: chunks.length }), { snapshotFingerprint: parsed.snapshotFingerprint, recordCount: parsed.recordCount, chunkCount: parsed.chunkCount, expectedState: "sealing", ...(parsed.idempotencyKey === undefined ? {} : { idempotencyKey: parsed.idempotencyKey }) });
    await this.db.runTransaction(async (transaction) => {
      const current = await transaction.get(operation);
      if (!current.exists) throw new Error("adoption_transfer_not_found");
      const data = asRecord(current.data(), "adoption_transfer");
      if (data.state === "sealed" || data.state === "result_building" || data.state === "preview_ready" || data.state === "applying" || data.state === "complete") {
        if (data.snapshotFingerprint !== parsed.snapshotFingerprint) throw new Error("adoption_transfer_snapshot_seal_mismatch");
        return;
      }
      if (data.state !== "sealing") throw new Error("adoption_transfer_precondition_failed");
      transaction.update(operation, { state: sealed.state, snapshotFingerprint: sealed.snapshotFingerprint, recordCount: sealed.recordCount, chunkCount: sealed.chunkCount, updatedAt: now() });
    });
    const final = await operation.get();
    return adoptionStatusFromData(asRecord(final.data(), "adoption_transfer"));
  }

  public async previewAdoptionTransfer(userId: string, sessionId: string, input: AdoptionTransferPreviewRequest): Promise<Readonly<Record<string, unknown>>> {
    const parsed = adoptionTransferPreviewSchema.parse(input);
    const operation = accountAdoptionRef(this.db, userId, sessionId);
    const operationSnapshot = await operation.get();
    if (!operationSnapshot.exists) throw new Error("adoption_transfer_not_found");
    const operationData = asRecord(operationSnapshot.data(), "adoption_transfer");
    const transfer = readStoredAdoptionTransfer(operationData);
    if (operationData.deviceId !== parsed.deviceId) throw new Error("adoption_transfer_device_mismatch");
    if (!["sealed", "result_building", "preview_ready", "applying", "complete"].includes(transfer.state)) throw new Error("adoption_transfer_precondition_failed");
    const records = (await operation.collection(ADOPTION_RECORDS_SUBCOLLECTION).get()).docs.map((document) => parseAdoptionRecord(asRecord(document.data(), "adoption_record"))).sort((left, right) => adoptionRecordKey(left).localeCompare(adoptionRecordKey(right)));
    const active = await this.readSnapshot(userId, parsed.protocolVersion);
    const remoteRecords = active.records.map(progressRecordToMergeRecord);
    // The same full identity may legitimately exist in both sources. The
    // merge layer compares fingerprints and keeps one copy.
    ensureFullIdentityUniqueness(records);
    ensureFullIdentityUniqueness(remoteRecords);
    const guestSnapshot = adoptionPreviewSnapshot({ guestUserId: transfer.guestUserId, snapshotVersion: transfer.snapshotVersion, protocolVersion: parsed.protocolVersion, activeSession: operationData.activeSession === true, pendingJournal: operationData.pendingJournal === true }, records);
    const adoption = buildGuestMergePreview({ accountUserId: userId, accountSnapshotVersion: active.accountRevision, guestSnapshot, remoteRecords, identityMode: "full" });
    if (operationData.snapshotFingerprint !== transfer.snapshotFingerprint) throw new Error("adoption_transfer_snapshot_seal_mismatch");
    const storedPreviewFingerprint = typeof operationData.previewFingerprint === "string" ? operationData.previewFingerprint : null;
    if (storedPreviewFingerprint !== null && storedPreviewFingerprint !== adoption.preview.fingerprint) throw new Error("adoption_transfer_preview_mismatch");
    if (operationData.previewAccountRevision !== undefined && operationData.previewAccountRevision !== active.accountRevision) throw new Error("adoption_transfer_preview_stale");
    if (operationData.previewGeneration !== undefined && operationData.previewGeneration !== (active.generation ?? 0)) throw new Error("adoption_transfer_preview_stale");
    if (storedPreviewFingerprint !== null) return Object.freeze({ ...adoptionStatusFromData(operationData), preview: adoption.preview, plan: adoption.plan, remoteRecords: adoption.remoteRecords });

    // A result chunk contains only identities/fingerprints.  The operation
    // document remains bounded; records are reconstructed from child docs on
    // retry and are never copied into one operation field.
    const resultChunks = buildAdoptionResultChunks(records);
    const resultRefs = resultChunks.map((_, index) => adoptionChildRef(this.db, userId, sessionId, ADOPTION_RESULTS_SUBCOLLECTION, String(index).padStart(8, "0")));
    const resultExisting = await this.db.getAll(...resultRefs);
    const createdAt = now();
    for (let start = 0; start < resultChunks.length; start += ADOPTION_TRANSFER_FIRESTORE_BATCH_SIZE) {
      const resultBatch = this.db.batch();
      let pending = 0;
      for (let index = start; index < Math.min(start + ADOPTION_TRANSFER_FIRESTORE_BATCH_SIZE, resultChunks.length); index += 1) {
        const result = resultChunks[index]!;
        const recordKeys = result.map(adoptionRecordKey);
        const fingerprint = createHash("sha256").update(canonicalJson({ index, recordKeys, records: result.map((record) => record.fingerprint) }), "utf8").digest("hex");
        if (resultExisting[index]?.exists) {
          const existing = asRecord(resultExisting[index]!.data(), "adoption_result");
          if (existing.fingerprint !== fingerprint || canonicalJson(existing.recordKeys) !== canonicalJson(recordKeys)) throw new Error("adoption_transfer_result_chunk_conflict");
        } else {
          resultBatch.create(resultRefs[index]!, { index, recordKeys, fingerprint, createdAt, updatedAt: createdAt, expiresAt: operationData.expiresAt });
          pending += 1;
        }
      }
      if (pending > 0) await resultBatch.commit();
    }
    const previewReady = await this.db.runTransaction(async (transaction) => {
      const current = await transaction.get(operation);
      if (!current.exists) throw new Error("adoption_transfer_not_found");
      const currentData = asRecord(current.data(), "adoption_transfer");
      if (typeof currentData.previewFingerprint === "string") {
        if (currentData.previewFingerprint !== adoption.preview.fingerprint) throw new Error("adoption_transfer_preview_mismatch");
        return currentData;
      }
      if (currentData.state !== "sealed" && currentData.state !== "result_building") throw new Error("adoption_transfer_precondition_failed");
      const transferWithChildren = Object.freeze({ ...readStoredAdoptionTransfer(currentData), records, chunks: Object.freeze([]), resultChunks: Object.freeze([]) });
      const transitioned = currentData.state === "sealed" ? beginAdoptionResultBuild(transferWithChildren, parsed.idempotencyKey ?? transferWithChildren.idempotencyKey) : transferWithChildren;
      const marked = markAdoptionPreviewReady(transitioned, parsed.idempotencyKey ?? transferWithChildren.idempotencyKey);
      const update = {
        state: marked.state,
        previewFingerprint: adoption.preview.fingerprint,
        previewOperationId: adoption.preview.operationId,
        previewProtocolVersion: parsed.protocolVersion,
        previewAccountRevision: active.accountRevision,
        previewGeneration: active.generation ?? 0,
        previewConflictCount: adoption.preview.conflicts.length,
        previewRecordCount: adoption.remoteRecords.length,
        previewPlanCaseId: adoption.plan.caseId,
        previewBlockingReason: adoption.plan.blockingReason,
        previewUploadCount: adoption.plan.uploadRecordIds.length,
        previewRestoreCount: adoption.plan.restoreRecordIds.length,
        previewDeduplicatedCount: adoption.plan.deduplicatedRecordIds.length,
        previewUpdatedAt: now(),
        updatedAt: now(),
      };
      transaction.update(operation, update);
      return { ...currentData, ...update };
    });
    return Object.freeze({ ...adoptionStatusFromData(previewReady), preview: adoption.preview, plan: adoption.plan, remoteRecords: adoption.remoteRecords });
  }

  public async confirmAdoptionTransfer(userId: string, sessionId: string, input: AdoptionTransferConfirm): Promise<Readonly<Record<string, unknown>>> {
    const parsed = adoptionTransferConfirmSchema.parse(input);
    const operation = accountAdoptionRef(this.db, userId, sessionId);
    const operationSnapshot = await operation.get();
    if (!operationSnapshot.exists) throw new Error("adoption_transfer_not_found");
    const operationData = asRecord(operationSnapshot.data(), "adoption_transfer");
    const transfer = readStoredAdoptionTransfer(operationData);
    if (operationData.deviceId !== parsed.deviceId) throw new Error("adoption_transfer_device_mismatch");
    if (parsed.operationId !== undefined && operationData.previewOperationId !== parsed.operationId) throw new Error("adoption_transfer_preview_mismatch");
    if (typeof operationData.previewFingerprint !== "string" || operationData.previewFingerprint !== parsed.previewFingerprint) throw new Error("adoption_transfer_preview_mismatch");
    if (transfer.state !== "preview_ready" && transfer.state !== "applying" && transfer.state !== "complete") throw new Error("adoption_transfer_precondition_failed");
    const suppliedDecisionFingerprint = createAdoptionDecisionFingerprint(parsed);
    if (parsed.decisionFingerprint !== undefined && parsed.decisionFingerprint !== suppliedDecisionFingerprint) throw new Error("adoption_transfer_decision_mismatch");
    if (typeof operationData.decisionFingerprint === "string" && operationData.decisionFingerprint !== suppliedDecisionFingerprint) throw new Error("adoption_transfer_decision_mismatch");
    if (typeof operationData.decisionFingerprint !== "string") {
      const records = (await operation.collection(ADOPTION_RECORDS_SUBCOLLECTION).get()).docs.map((document) => parseAdoptionRecord(asRecord(document.data(), "adoption_record"))).sort((left, right) => adoptionRecordKey(left).localeCompare(adoptionRecordKey(right)));
      const active = await this.readSnapshot(userId, parsed.protocolVersion);
      const guestSnapshot = adoptionPreviewSnapshot({ guestUserId: transfer.guestUserId, snapshotVersion: transfer.snapshotVersion, protocolVersion: parsed.protocolVersion, activeSession: operationData.activeSession === true, pendingJournal: operationData.pendingJournal === true }, records);
      const adoption = buildGuestMergePreview({ accountUserId: userId, accountSnapshotVersion: active.accountRevision, guestSnapshot, remoteRecords: active.records.map(progressRecordToMergeRecord), identityMode: "full" });
      if (adoption.preview.fingerprint !== parsed.previewFingerprint || adoption.preview.operationId !== operationData.previewOperationId) throw new Error("adoption_transfer_preview_mismatch");
      if (adoption.plan.blockingReason === "active_session") throw new Error("active_session_adoption_blocked");
      if (adoption.plan.blockingReason === "journal_recovery") throw new Error("journal_recovery_required");
      const confirmation: GuestMergeConfirmation = parsed.protocolVersion === 2
        ? { operationId: adoption.preview.operationId, previewFingerprint: parsed.previewFingerprint, protocolVersion: 2, resolutions: parsed.resolutions, groupChoices: parsed.groupChoices ?? [] }
        : { operationId: adoption.preview.operationId, previewFingerprint: parsed.previewFingerprint, protocolVersion: 1, resolutions: parsed.resolutions };
      validateGuestMergeConfirmation(adoption.preview, confirmation);
    }
    // Reserve the immutable fingerprint before writing children. If a later
    // batch is interrupted, a retry is allowed to fill only the missing
    // deterministic children; a different decision can never take over.
    const confirmed = await this.db.runTransaction(async (transaction) => {
      const current = await transaction.get(operation);
      if (!current.exists) throw new Error("adoption_transfer_not_found");
      const currentData = asRecord(current.data(), "adoption_transfer");
      if (typeof currentData.decisionFingerprint === "string") {
        if (currentData.decisionFingerprint !== suppliedDecisionFingerprint) throw new Error("adoption_transfer_decision_mismatch");
        return currentData;
      }
      if (currentData.state !== "preview_ready") throw new Error("adoption_transfer_precondition_failed");
      const update = { decisionFingerprint: suppliedDecisionFingerprint, decisionDeviceId: parsed.deviceId, decisionProtocolVersion: parsed.protocolVersion, decisionAt: now(), updatedAt: now() };
      transaction.update(operation, update);
      return { ...currentData, ...update };
    });
    const createdAt = now();
    const decisionWrites: Array<Readonly<{ id: string; ref: DocumentReference; value: Record<string, unknown> }>> = [];
    const addDecisionWrite = (id: string, value: Record<string, unknown>): void => {
      decisionWrites.push({ id, ref: adoptionChildRef(this.db, userId, sessionId, ADOPTION_DECISIONS_SUBCOLLECTION, adoptionTransferDecisionDocumentId(id)), value });
    };
    addDecisionWrite("meta", { kind: "meta", deviceId: parsed.deviceId, previewFingerprint: parsed.previewFingerprint, decisionFingerprint: suppliedDecisionFingerprint, protocolVersion: parsed.protocolVersion, createdAt, updatedAt: createdAt, expiresAt: operationData.expiresAt });
    for (const resolution of parsed.resolutions) addDecisionWrite(`resolution:${resolution.conflictId}`, { kind: "resolution", conflictId: resolution.conflictId, resolution: resolution.resolution, deviceId: parsed.deviceId, previewFingerprint: parsed.previewFingerprint, decisionFingerprint: suppliedDecisionFingerprint, protocolVersion: parsed.protocolVersion, createdAt, updatedAt: createdAt, expiresAt: operationData.expiresAt });
    for (const choice of parsed.groupChoices ?? []) addDecisionWrite(`group:${choice.groupId}`, { kind: "group_choice", groupId: choice.groupId, resolution: choice.resolution, deviceId: parsed.deviceId, previewFingerprint: parsed.previewFingerprint, decisionFingerprint: suppliedDecisionFingerprint, protocolVersion: parsed.protocolVersion, createdAt, updatedAt: createdAt, expiresAt: operationData.expiresAt });

    const existingDecisionRows = (await operation.collection(ADOPTION_DECISIONS_SUBCOLLECTION).get()).docs;
    const expectedById = new Map(decisionWrites.map((write) => [write.ref.id, write.value]));
    for (const row of existingDecisionRows) {
      const existing = asRecord(row.data(), "adoption_decision");
      const expected = expectedById.get(row.id);
      if (!expected || existing.decisionFingerprint !== suppliedDecisionFingerprint || existing.deviceId !== parsed.deviceId || existing.previewFingerprint !== parsed.previewFingerprint || existing.protocolVersion !== parsed.protocolVersion || existing.kind !== expected.kind || (expected.kind === "resolution" && (existing.conflictId !== expected.conflictId || existing.resolution !== expected.resolution)) || (expected.kind === "group_choice" && (existing.groupId !== expected.groupId || existing.resolution !== expected.resolution))) throw new Error("adoption_transfer_decision_mismatch");
    }
    const missing = decisionWrites.filter((write) => !existingDecisionRows.some((row) => row.id === write.ref.id));
    for (let start = 0; start < missing.length; start += ADOPTION_TRANSFER_FIRESTORE_BATCH_SIZE) {
      const decisionBatch = this.db.batch();
      for (const write of missing.slice(start, start + ADOPTION_TRANSFER_FIRESTORE_BATCH_SIZE)) decisionBatch.set(write.ref, write.value);
      if (missing.length > start) await decisionBatch.commit();
    }
    return Object.freeze({ ...adoptionStatusFromData(confirmed), decisionFingerprint: suppliedDecisionFingerprint });
  }

  public async applyAdoptionTransfer(userId: string, sessionId: string, input: AdoptionTransferApply): Promise<Readonly<Record<string, unknown>>> {
    const parsed = adoptionTransferApplySchema.parse(input);
    const operation = accountAdoptionRef(this.db, userId, sessionId);
    const operationSnapshot = await operation.get();
    if (!operationSnapshot.exists) throw new Error("adoption_transfer_not_found");
    let operationData = asRecord(operationSnapshot.data(), "adoption_transfer");
    const transfer = readStoredAdoptionTransfer(operationData);
    if (operationData.deviceId !== parsed.deviceId) throw new Error("adoption_transfer_device_mismatch");
    if (typeof operationData.decisionFingerprint !== "string") throw new Error("adoption_transfer_confirmation_required");
    if (parsed.decisionFingerprint !== undefined && parsed.decisionFingerprint !== operationData.decisionFingerprint) throw new Error("adoption_transfer_decision_mismatch");
    if (transfer.state === "complete") return adoptionStatusFromData(operationData);
    if (transfer.state !== "preview_ready" && transfer.state !== "applying") throw new Error("adoption_transfer_precondition_failed");
    const decisions = await operation.collection(ADOPTION_DECISIONS_SUBCOLLECTION).get();
    const storedConfirmation = parseAdoptionDecisionRows(decisions.docs);
    if (!storedConfirmation) throw new Error("adoption_transfer_confirmation_required");
    if (createAdoptionDecisionFingerprint(storedConfirmation) !== operationData.decisionFingerprint) throw new Error("adoption_transfer_decision_incomplete");
    const records = (await operation.collection(ADOPTION_RECORDS_SUBCOLLECTION).get()).docs.map((document) => parseAdoptionRecord(asRecord(document.data(), "adoption_record"))).sort((left, right) => adoptionRecordKey(left).localeCompare(adoptionRecordKey(right)));
    const protocolVersion = storedConfirmation.protocolVersion;
    const active = await this.readSnapshot(userId, protocolVersion);
    if (operationData.previewAccountRevision !== undefined && operationData.previewAccountRevision !== active.accountRevision) throw new Error("adoption_transfer_preview_stale");
    if (operationData.previewGeneration !== undefined && operationData.previewGeneration !== (active.generation ?? 0)) throw new Error("adoption_transfer_preview_stale");
    const guestSnapshot = adoptionPreviewSnapshot({ guestUserId: transfer.guestUserId, snapshotVersion: transfer.snapshotVersion, protocolVersion, activeSession: operationData.activeSession === true, pendingJournal: operationData.pendingJournal === true }, records);
    const adoption = buildGuestMergePreview({ accountUserId: userId, accountSnapshotVersion: active.accountRevision, guestSnapshot, remoteRecords: active.records.map(progressRecordToMergeRecord), identityMode: "full" });
    if (adoption.preview.fingerprint !== operationData.previewFingerprint || adoption.preview.operationId !== operationData.previewOperationId) throw new Error("adoption_transfer_preview_stale");
    if (adoption.plan.blockingReason === "active_session") throw new Error("active_session_adoption_blocked");
    if (adoption.plan.blockingReason === "journal_recovery") throw new Error("journal_recovery_required");
    const domainConfirmation: GuestMergeConfirmation = storedConfirmation.protocolVersion === 2
      ? { operationId: adoption.preview.operationId, previewFingerprint: String(operationData.previewFingerprint), protocolVersion: 2, resolutions: storedConfirmation.resolutions, groupChoices: storedConfirmation.groupChoices ?? [] }
      : { operationId: adoption.preview.operationId, previewFingerprint: String(operationData.previewFingerprint), protocolVersion: 1, resolutions: storedConfirmation.resolutions };
    validateGuestMergeConfirmation(adoption.preview, domainConfirmation);
    const materialization = buildAdoptionMaterialization(sessionId, guestSnapshot.records as GuestMergeRecord[], active.records.map(progressRecordToMergeRecord), domainConfirmation);
    const expectedGeneration = parsed.expectedGeneration ?? transfer.expectedGeneration;
    if (expectedGeneration !== transfer.expectedGeneration) throw new Error("adoption_transfer_generation_conflict");
    const targetGeneration = transfer.targetGeneration;
    const targetCollection = progressCollectionRef(this.db, userId, targetGeneration);
    if (transfer.state === "preview_ready") {
      const begun = await this.db.runTransaction(async (transaction) => {
        const current = await transaction.get(operation);
        const metadata = await transaction.get(accountMetadataRef(this.db, userId));
        if (!current.exists) throw new Error("adoption_transfer_not_found");
        const currentData = asRecord(current.data(), "adoption_transfer");
        const currentTransfer = readStoredAdoptionTransfer(currentData);
        const metadataData = metadata.data() as Record<string, unknown> | undefined;
        const currentGeneration = readAccountGeneration(metadataData);
        const currentRevision = readAccountRevision(metadataData);
        if (currentTransfer.state === "complete") return currentData;
        if (currentTransfer.state !== "preview_ready") throw new Error("adoption_transfer_precondition_failed");
        if (currentGeneration !== currentTransfer.expectedGeneration || currentRevision !== Number(currentData.previewAccountRevision)) throw new Error("adoption_transfer_generation_conflict");
        if (hasActiveAdoptionPromotionLease(metadataData) && metadataData?.adoptionPromotionSessionId !== sessionId) throw new Error("adoption_transfer_generation_conflict");
        const applying = beginAdoptionApply(Object.freeze({ ...currentTransfer, records: [], chunks: [], decisions: [], resultChunks: [] }), currentTransfer.expectedGeneration, parsed.idempotencyKey ?? currentTransfer.idempotencyKey);
        const leaseExpiresAt = adoptionPromotionLease();
        const update = { state: applying.state, targetGeneration, applyCursor: 0, applyTotal: materialization.records.length, applyAccountRevision: currentRevision + materialization.changes.length, applyChangeCount: materialization.changes.length, applyStartedAt: now(), updatedAt: now() };
        transaction.set(progressGenerationRef(this.db, userId, targetGeneration), { userId, generation: targetGeneration, sourceSessionId: sessionId, state: "building", createdAt: currentData.createdAt ?? update.applyStartedAt, updatedAt: update.updatedAt, expiresAt: currentData.expiresAt }, { merge: true });
        transaction.set(accountMetadataRef(this.db, userId), { adoptionPromotionSessionId: sessionId, adoptionPromotionTargetGeneration: targetGeneration, adoptionPromotionLeaseExpiresAt: leaseExpiresAt, updatedAt: update.updatedAt }, { merge: true });
        transaction.update(operation, update);
        return { ...currentData, ...update };
      });
      operationData = begun;
    } else {
      const current = await operation.get();
      operationData = asRecord(current.data(), "adoption_transfer");
    }
    const applyTotal = Number(operationData.applyTotal ?? materialization.records.length);
    let cursor = Number(operationData.applyCursor ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > applyTotal) throw new Error("adoption_transfer_cursor_invalid");
    const applyAccountRevision = Number(operationData.applyAccountRevision);
    if (!Number.isSafeInteger(applyAccountRevision) || applyAccountRevision < 0) throw new Error("adoption_transfer_revision_invalid");
    const changedMutationIds = new Map(materialization.changes.map((change) => [adoptionRecordKey(change.record), change.mutationId]));
    while (cursor < materialization.records.length) {
      const batch = this.db.batch();
      const nextCursor = Math.min(cursor + ADOPTION_TRANSFER_FIRESTORE_BATCH_SIZE, materialization.records.length);
      for (const record of materialization.records.slice(cursor, nextCursor)) {
        const key = adoptionRecordKey(record);
        const mutationId = changedMutationIds.get(key) ?? `adoption_carry_${sessionId.replaceAll("-", "")}_${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 24)}`;
        const ref = targetCollection.doc(progressDocumentId({ kind: adoptionKind(record.recordType), recordType: record.recordType as ProgressMutation["recordType"], targetId: record.recordId, trackId: record.trackId }));
        batch.set(ref, { kind: adoptionKind(record.recordType), recordType: record.recordType, trackId: record.trackId, targetId: record.recordId, version: record.version, fingerprint: record.fingerprint, state: record.state, lastMutationId: mutationId, generation: targetGeneration, sourceSessionId: sessionId, updatedAt: now(), expiresAt: operationData.expiresAt });
      }
      await batch.commit();
      await this.db.runTransaction(async (transaction) => {
        const current = await transaction.get(operation);
        if (!current.exists) throw new Error("adoption_transfer_not_found");
        const data = asRecord(current.data(), "adoption_transfer");
        if (data.state === "complete") return;
        if (data.state !== "applying" || Number(data.applyCursor ?? 0) !== cursor) throw new Error("adoption_transfer_apply_cursor_conflict");
        const metadataRef = accountMetadataRef(this.db, userId);
        const metadataSnapshot = await transaction.get(metadataRef);
        const metadata = metadataSnapshot.data() as Record<string, unknown> | undefined;
        if (metadata?.adoptionPromotionSessionId !== sessionId || Number(metadata.adoptionPromotionTargetGeneration) !== targetGeneration) throw new Error("adoption_transfer_generation_conflict");
        transaction.update(operation, { applyCursor: nextCursor, updatedAt: now() });
        transaction.set(metadataRef, { adoptionPromotionLeaseExpiresAt: adoptionPromotionLease(), updatedAt: now() }, { merge: true });
      });
      cursor = nextCursor;
    }
    const metadataRef = accountMetadataRef(this.db, userId);
    await this.db.runTransaction(async (transaction) => {
      const current = await transaction.get(operation);
      const metadataSnapshot = await transaction.get(metadataRef);
      if (!current.exists) throw new Error("adoption_transfer_not_found");
      const data = asRecord(current.data(), "adoption_transfer");
      if (data.state === "complete") return;
      if (data.state !== "applying" || Number(data.applyCursor ?? 0) < Number(data.applyTotal ?? 0)) throw new Error("adoption_transfer_apply_incomplete");
      const metadata = metadataSnapshot.data() as Record<string, unknown> | undefined;
      const currentGeneration = readAccountGeneration(metadata);
      const currentRevision = readAccountRevision(metadata);
      if (currentGeneration !== transfer.expectedGeneration || currentRevision !== Number(data.previewAccountRevision)) throw new Error("adoption_transfer_generation_conflict");
      if (metadata?.adoptionPromotionSessionId !== undefined && metadata.adoptionPromotionSessionId !== sessionId) throw new Error("adoption_transfer_generation_conflict");
      transaction.set(metadataRef, { adoptionPromotionSessionId: sessionId, adoptionPromotionTargetGeneration: targetGeneration, adoptionPromotionLeaseExpiresAt: adoptionPromotionLease(), updatedAt: now() }, { merge: true });
    });
    // Active generations must not retain the short-lived staging expiry. This
    // cleanup is recoverable: the promotion reservation above prevents a
    // competing transfer from flipping the account while it runs.
    const hiddenRecords = await targetCollection.get();
    for (let start = 0; start < hiddenRecords.docs.length; start += ADOPTION_TRANSFER_FIRESTORE_BATCH_SIZE) {
      const expiryBatch = this.db.batch();
      for (const document of hiddenRecords.docs.slice(start, start + ADOPTION_TRANSFER_FIRESTORE_BATCH_SIZE)) expiryBatch.update(document.ref, { expiresAt: FieldValue.delete() });
      await expiryBatch.commit();
    }
    const completed = await this.db.runTransaction(async (transaction) => {
      const current = await transaction.get(operation);
      const metadataSnapshot = await transaction.get(metadataRef);
      if (!current.exists) throw new Error("adoption_transfer_not_found");
      const data = asRecord(current.data(), "adoption_transfer");
      if (data.state === "complete") return data;
      if (data.state !== "applying" || Number(data.applyCursor ?? 0) < Number(data.applyTotal ?? 0)) throw new Error("adoption_transfer_apply_incomplete");
      const metadata = metadataSnapshot.data() as Record<string, unknown> | undefined;
      const currentGeneration = readAccountGeneration(metadata);
      const currentRevision = readAccountRevision(metadata);
      if (currentGeneration !== transfer.expectedGeneration || currentRevision !== Number(data.previewAccountRevision)) throw new Error("adoption_transfer_generation_conflict");
      if (metadata?.adoptionPromotionSessionId !== sessionId || Number(metadata.adoptionPromotionTargetGeneration) !== targetGeneration) throw new Error("adoption_transfer_generation_conflict");
      const currentTransfer = readStoredAdoptionTransfer(data);
      const complete = completeAdoptionTransfer(Object.freeze({ ...currentTransfer, records: [], chunks: [], decisions: [], resultChunks: [] }), transfer.expectedGeneration, targetGeneration);
      const updatedAt = now();
      transaction.set(metadataRef, { generation: targetGeneration, activeGeneration: targetGeneration, accountRevision: applyAccountRevision, adoptionPromotionSessionId: FieldValue.delete(), adoptionPromotionTargetGeneration: FieldValue.delete(), adoptionPromotionLeaseExpiresAt: FieldValue.delete(), updatedAt }, { merge: true });
      transaction.set(progressGenerationRef(this.db, userId, targetGeneration), { userId, generation: targetGeneration, sourceSessionId: sessionId, state: "active", updatedAt, expiresAt: FieldValue.delete() }, { merge: true });
      transaction.set(operation.collection("markers").doc(String(targetGeneration)), { sessionId, targetGeneration, accountRevision: applyAccountRevision, committedAt: updatedAt, expiresAt: data.expiresAt });
      const update = { state: complete.state, generation: complete.generation, activeGeneration: targetGeneration, accountRevision: applyAccountRevision, committedAt: updatedAt, updatedAt };
      transaction.update(operation, update);
      return { ...data, ...update };
    });
    return adoptionStatusFromData(completed);
  }

  public async statusAdoptionTransfer(userId: string, sessionId: string, deviceId: string): Promise<Readonly<Record<string, unknown>> | null> {
    const snapshot = await accountAdoptionRef(this.db, userId, sessionId).get();
    if (!snapshot.exists) return null;
    const data = asRecord(snapshot.data(), "adoption_transfer");
    if (data.deviceId !== deviceId) throw new Error("adoption_transfer_device_mismatch");
    return adoptionStatusFromData(data);
  }

  public async applyBatch(userId: string, deviceId: string | null, expectedAccountRevision: number, mutations: readonly ProgressMutation[], metadata?: SyncBatchMetadata): Promise<SyncBatchResult> {
    assertGoalPlanRecordShapes(mutations.map((mutation) => ({ fingerprint: mutation.fingerprint, recordId: mutation.targetId, recordType: mutation.recordType, state: mutation.state, trackId: mutation.trackId, version: mutation.expectedVersion ?? 0 })));
    for (const mutation of mutations) {
      if (createMergeRecordFingerprint({ recordId: mutation.targetId, recordType: mutation.recordType, state: mutation.state, trackId: mutation.trackId }) !== mutation.fingerprint) throw new Error("progress_fingerprint_mismatch");
    }
    return this.db.runTransaction(async (transaction) => {
      const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
      const user = await transaction.get(userRef);
      if (!user.exists || asRecord(user.data(), "user").deletedAt !== undefined) throw new Error("account_deleted");
      const metaRef = accountMetadataRef(this.db, userId);
      const batchRef = metadata ? syncBatchRef(this.db, userId, metadata) : null;
      const metaSnapshot = await transaction.get(metaRef);
      const metadataSnapshot = metaSnapshot.data() as Record<string, unknown> | undefined;
      const activeGeneration = readAccountGeneration(metadataSnapshot);
      const progressRefs = mutations.map((mutation) => progressCollectionRef(this.db, userId, activeGeneration).doc(metadata ? progressDocumentId(mutation) : legacyProgressDocumentId(mutation)));
      const mutationRefs = mutations.map((mutation) => userRef.collection("syncMutations").doc(mutation.mutationId));
      const batchSnapshot = batchRef ? await transaction.get(batchRef) : undefined;
      const snapshots = await transaction.getAll(...progressRefs, ...mutationRefs);
      const accountRevision = readAccountRevision(metadataSnapshot);
      const progressSnapshots = snapshots.slice(0, mutations.length);
      const mutationSnapshots = snapshots.slice(mutations.length);
      if (batchSnapshot?.exists && metadata) {
        const stored = asRecord(batchSnapshot.data(), "sync_batch");
        const fingerprint = syncBatchFingerprint(metadata, expectedAccountRevision, mutations);
        if (stored.fingerprint !== fingerprint) throw new Error("mutation_id_reuse");
        const storedResult = stored.result;
        if (!storedResult || typeof storedResult !== "object" || Array.isArray(storedResult)) throw new Error("sync_batch_invalid");
        return parseStoredBatchResult(storedResult);
      }
      const applied: ProgressRecord[] = [];
      const duplicates: string[] = [];
      const conflicts: Array<SyncBatchResult["conflicts"][number]> = [];
      const newMutations: Array<{ mutation: ProgressMutation; index: number; current: ProgressRecord | null }> = [];
      for (let index = 0; index < mutations.length; index += 1) {
        const mutation = mutations[index]!;
        const current = progressSnapshots[index]!.exists ? toView(asRecord(progressSnapshots[index]!.data(), "progress")) : null;
        const mutationSnapshot = mutationSnapshots[index]!;
        if (mutationSnapshot.exists || current?.lastMutationId === mutation.mutationId) {
          const stored = mutationSnapshot.exists ? asRecord(mutationSnapshot.data(), "sync_mutation") : {};
          if (stored.fingerprint !== undefined && (stored.fingerprint !== mutation.fingerprint || stored.targetId !== mutation.targetId || stored.recordType !== mutation.recordType)) throw new Error("mutation_id_reuse");
          if (current && (current.fingerprint !== mutation.fingerprint || current.targetId !== mutation.targetId || current.recordType !== mutation.recordType)) throw new Error("mutation_id_reuse");
          duplicates.push(mutation.mutationId);
          continue;
        }
        newMutations.push({ mutation, index, current });
      }
      if (newMutations.length > 0 && expectedAccountRevision !== accountRevision) return Object.freeze({ accountRevision, applied: Object.freeze([]), duplicates: Object.freeze(duplicates), conflicts: Object.freeze([]), accountRevisionConflict: { code: "account_revision_conflict", currentAccountRevision: accountRevision } });
      for (const { mutation, current } of newMutations) {
        if ((current?.version ?? null) !== mutation.expectedVersion) conflicts.push({ mutationId: mutation.mutationId, code: "version_conflict", current });
      }
      if (conflicts.length > 0) return Object.freeze({ accountRevision, applied: Object.freeze([]), duplicates: Object.freeze(duplicates), conflicts: Object.freeze(conflicts) });
      for (const { mutation, index, current } of newMutations) {
        const nextVersion = (current?.version ?? 0) + 1;
        const updatedAt = now();
        const updated: ProgressRecord = Object.freeze({ kind: mutation.kind, recordType: mutation.recordType, trackId: mutation.trackId, targetId: mutation.targetId, version: nextVersion, fingerprint: mutation.fingerprint, state: mutation.state, lastMutationId: mutation.mutationId, updatedAt: updatedAt.toDate().toISOString() });
        const progressRef = progressRefs[index]!;
        transaction.set(progressRef, { kind: mutation.kind, recordType: mutation.recordType, trackId: mutation.trackId, targetId: mutation.targetId, version: nextVersion, fingerprint: mutation.fingerprint, state: mutation.state, lastMutationId: mutation.mutationId, updatedAt, ...(activeGeneration === 0 ? {} : { generation: activeGeneration }) });
        transaction.create(mutationRefs[index]!, {
          ...(deviceId === null ? {} : { deviceId }),
          mutationId: mutation.mutationId,
          recordType: mutation.recordType,
          appliedVersion: nextVersion,
          createdAt: updatedAt,
          expiresAt: expiresAfterSyncRetention(updatedAt),
        });
        applied.push(updated);
      }
      const nextAccountRevision = accountRevision + applied.length;
      if (applied.length > 0) transaction.set(metaRef, { accountRevision: nextAccountRevision, updatedAt: now() }, { merge: true });
      const result = Object.freeze({ accountRevision: nextAccountRevision, applied: Object.freeze(applied), duplicates: Object.freeze(duplicates), conflicts: Object.freeze(conflicts) });
      if (batchRef && metadata) {
        const createdAt = now();
        transaction.create(batchRef, {
          sessionId: metadata.sessionId,
          batchId: metadata.batchId,
          planVersion: metadata.planVersion,
          highWatermark: metadata.highWatermark,
          fingerprint: syncBatchFingerprint(metadata, expectedAccountRevision, mutations),
          expectedAccountRevision,
          result,
          createdAt,
          expiresAt: expiresAfterSyncRetention(createdAt),
        });
      }
      return result;
    });
  }
}

function parseStoredBatchResult(value: object): SyncBatchResult {
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.accountRevision) || !Array.isArray(candidate.applied) || !Array.isArray(candidate.duplicates) || !Array.isArray(candidate.conflicts)) throw new Error("sync_batch_invalid");
  const base = {
    accountRevision: Number(candidate.accountRevision),
    applied: Object.freeze(candidate.applied as ProgressRecord[]),
    duplicates: Object.freeze(candidate.duplicates.filter((item): item is string => typeof item === "string")),
    conflicts: Object.freeze(candidate.conflicts as SyncBatchResult["conflicts"]),
  };
  if (candidate.accountRevisionConflict === undefined) return Object.freeze(base);
  return Object.freeze({ ...base, accountRevisionConflict: candidate.accountRevisionConflict as NonNullable<SyncBatchResult["accountRevisionConflict"]> });
}

function adoptionMutationId(operationId: string, key: string, fingerprint: string): string {
  return `adoption_${operationId.replaceAll("-", "")}_${createMergeRecordFingerprint({ recordId: key, recordType: "active_track", state: { fingerprint }, trackId: key }).slice(0, 24)}`;
}
