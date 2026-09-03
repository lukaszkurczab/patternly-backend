import type { Firestore, DocumentReference } from "firebase-admin/firestore";
import { COLLECTIONS, progressDocumentId } from "../../infrastructure/firestore/paths.js";
import { asIsoString, asRecord, now } from "../../infrastructure/firestore/values.js";
import {
  buildGuestMergePreview,
  createMergeRecordFingerprint,
  mergeRecordKey,
  progressRecordToMergeRecord,
  type AdoptionExecution,
  type AdoptionPreview,
  type GuestMergeConfirmation,
  type GuestMergeRecord,
  type GuestMergeSnapshot,
} from "../users/merge.js";
import { syncableRecordTypeSchema, type ProgressMutation, type ProgressRecord, type ProgressSnapshot, type ProgressStore, type SyncBatchResult } from "./contracts.js";

const ACCOUNT_METADATA_ID = "account";

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

function operationRef(db: Firestore, userId: string, operationId: string): DocumentReference {
  return db.collection(COLLECTIONS.users).doc(userId).collection("syncOperations").doc(operationId);
}

function readAccountRevision(data: Record<string, unknown> | undefined): number {
  if (!data) return 0;
  if (!Number.isSafeInteger(data.accountRevision) || Number(data.accountRevision) < 0) throw new Error("account_revision_invalid");
  return Number(data.accountRevision);
}

export class FirestoreProgressStore implements ProgressStore {
  public constructor(private readonly db: Firestore) {}

  public async read(userId: string): Promise<readonly ProgressRecord[]> {
    return (await this.readSnapshot(userId)).records;
  }

  public async readSnapshot(userId: string): Promise<ProgressSnapshot> {
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const [meta, snapshot] = await Promise.all([
      accountMetadataRef(this.db, userId).get(),
      userRef.collection("progress").get(),
    ]);
    return Object.freeze({ accountRevision: readAccountRevision(meta.data() as Record<string, unknown> | undefined), records: Object.freeze(snapshot.docs.map((document) => toView(asRecord(document.data(), "progress")))) });
  }

  public async previewAdoption(userId: string, guestSnapshot: GuestMergeSnapshot): Promise<AdoptionPreview> {
    const remote = await this.readSnapshot(userId);
    return buildGuestMergePreview({
      accountUserId: userId,
      accountSnapshotVersion: remote.accountRevision,
      guestSnapshot,
      remoteRecords: remote.records.map(progressRecordToMergeRecord),
    });
  }

  public async confirmAdoption(userId: string, deviceId: string, guestSnapshot: GuestMergeSnapshot, confirmation: GuestMergeConfirmation): Promise<AdoptionExecution> {
    return this.db.runTransaction(async (transaction) => {
      const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
      const metaRef = accountMetadataRef(this.db, userId);
      const operation = operationRef(this.db, userId, confirmation.operationId);
      const [metaSnapshot, progressSnapshot, operationSnapshot] = await Promise.all([
        transaction.get(metaRef),
        transaction.get(userRef.collection("progress")),
        transaction.get(operation),
      ]);
      if (operationSnapshot.exists) {
        const stored = asRecord(operationSnapshot.data(), "sync_operation");
        if (stored.previewFingerprint !== confirmation.previewFingerprint || stored.guestUserId !== guestSnapshot.guestUserId) throw new Error("mutation_id_reuse");
        if (!Number.isSafeInteger(stored.accountRevision) || Number(stored.accountRevision) < 0) throw new Error("account_revision_invalid");
        return Object.freeze({ accountRevision: Number(stored.accountRevision), operationId: confirmation.operationId, mutationIds: Object.freeze(Array.isArray(stored.mutationIds) ? stored.mutationIds.filter((value): value is string => typeof value === "string") : []), records: Object.freeze(Array.isArray(stored.records) ? stored.records.map((value) => value as GuestMergeRecord) : []) });
      }
      const accountRevision = readAccountRevision(metaSnapshot.data() as Record<string, unknown> | undefined);
      const remoteRecords = progressSnapshot.docs.map((document) => progressRecordToMergeRecord(toView(asRecord(document.data(), "progress"))));
      const adoption = buildGuestMergePreview({ accountUserId: userId, accountSnapshotVersion: accountRevision, guestSnapshot, remoteRecords });
      if (adoption.preview.fingerprint !== confirmation.previewFingerprint || adoption.preview.operationId !== confirmation.operationId) throw new Error("merge_preview_mismatch");
      if (adoption.plan.blockingReason === "active_session") throw new Error("active_session_adoption_blocked");
      if (adoption.plan.blockingReason === "journal_recovery") throw new Error("journal_recovery_required");
      const ready = validateConfirmation(adoption.preview, confirmation);
      const remoteByKey = new Map(remoteRecords.map((record) => [mergeRecordKey(record), record]));
      const resolved = new Map(remoteByKey);
      const mutationIds: string[] = [];
      const progressWrites: Array<{ mutation: ProgressMutation; ref: DocumentReference; mutationRef: DocumentReference; nextVersion: number; updatedAt: ReturnType<typeof now> }> = [];
      for (const record of guestSnapshot.records) {
        const key = mergeRecordKey(record);
        const remote = remoteByKey.get(key);
        if (remote?.fingerprint === record.fingerprint) continue;
        if (remote && ready.confirmation.resolutions.find((resolution) => resolution.conflictId === key)?.resolution === "keep_account") continue;
        const mutationId = adoptionMutationId(confirmation.operationId, key, record.fingerprint);
        const mutation = mergeRecordToMutation(record, mutationId, remote?.version ?? null);
        const ref = userRef.collection("progress").doc(progressDocumentId(mutation));
        const mutationRef = userRef.collection("syncMutations").doc(mutationId);
        const nextVersion = (remote?.version ?? 0) + 1;
        const updatedAt = now();
        progressWrites.push({ mutation, ref, mutationRef, nextVersion, updatedAt });
        mutationIds.push(mutationId);
        resolved.set(key, { ...record, version: nextVersion });
      }
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
        transaction.create(write.mutationRef, { deviceId, mutationId: write.mutation.mutationId, recordType: write.mutation.recordType, appliedVersion: write.nextVersion, createdAt: write.updatedAt, operationId: confirmation.operationId });
      }
      const nextAccountRevision = accountRevision + progressWrites.length;
      if (progressWrites.length > 0) transaction.set(metaRef, { accountRevision: nextAccountRevision, updatedAt: now() }, { merge: true });
      const records = [...resolved.values()].sort((left, right) => mergeRecordKey(left).localeCompare(mergeRecordKey(right)));
      transaction.create(operation, { accountRevision: nextAccountRevision, createdAt: now(), deviceId, guestUserId: guestSnapshot.guestUserId, mutationIds, previewFingerprint: confirmation.previewFingerprint, records });
      return Object.freeze({ accountRevision: nextAccountRevision, operationId: confirmation.operationId, mutationIds: Object.freeze(mutationIds), records: Object.freeze(records) });
    });
  }

  public async applyBatch(userId: string, deviceId: string | null, expectedAccountRevision: number, mutations: readonly ProgressMutation[]): Promise<SyncBatchResult> {
    for (const mutation of mutations) {
      if (createMergeRecordFingerprint({ recordId: mutation.targetId, recordType: mutation.recordType, state: mutation.state, trackId: mutation.trackId }) !== mutation.fingerprint) throw new Error("progress_fingerprint_mismatch");
    }
    return this.db.runTransaction(async (transaction) => {
      const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
      const metaRef = accountMetadataRef(this.db, userId);
      const progressRefs = mutations.map((mutation) => userRef.collection("progress").doc(progressDocumentId(mutation)));
      const mutationRefs = mutations.map((mutation) => userRef.collection("syncMutations").doc(mutation.mutationId));
      const snapshots = await transaction.getAll(metaRef, ...progressRefs, ...mutationRefs);
      const accountRevision = readAccountRevision(snapshots[0]?.data() as Record<string, unknown> | undefined);
      const progressSnapshots = snapshots.slice(1, mutations.length + 1);
      const mutationSnapshots = snapshots.slice(mutations.length + 1);
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
        transaction.set(progressRef, { kind: mutation.kind, recordType: mutation.recordType, trackId: mutation.trackId, targetId: mutation.targetId, version: nextVersion, fingerprint: mutation.fingerprint, state: mutation.state, lastMutationId: mutation.mutationId, updatedAt });
        transaction.create(mutationRefs[index]!, { ...(deviceId === null ? {} : { deviceId }), mutationId: mutation.mutationId, recordType: mutation.recordType, appliedVersion: nextVersion, createdAt: updatedAt });
        applied.push(updated);
      }
      const nextAccountRevision = accountRevision + applied.length;
      if (applied.length > 0) transaction.set(metaRef, { accountRevision: nextAccountRevision, updatedAt: now() }, { merge: true });
      return Object.freeze({ accountRevision: nextAccountRevision, applied: Object.freeze(applied), duplicates: Object.freeze(duplicates), conflicts: Object.freeze(conflicts) });
    });
  }
}

function validateConfirmation(preview: ReturnType<typeof buildGuestMergePreview>["preview"], confirmation: GuestMergeConfirmation) {
  const conflictIds = new Set(preview.conflicts.map((conflict) => conflict.conflictId));
  if (confirmation.operationId !== preview.operationId || confirmation.previewFingerprint !== preview.fingerprint) throw new Error("merge_preview_mismatch");
  if (confirmation.resolutions.length !== conflictIds.size) throw new Error("merge_resolution_incomplete");
  const resolved = new Set<string>();
  for (const resolution of confirmation.resolutions) {
    if (!conflictIds.has(resolution.conflictId) || resolved.has(resolution.conflictId)) throw new Error("merge_resolution_mismatch");
    if (resolution.resolution === "manual_required") throw new Error("merge_conflict_requires_manual_resolution");
    resolved.add(resolution.conflictId);
  }
  if (resolved.size !== conflictIds.size) throw new Error("merge_resolution_incomplete");
  return { confirmation, preview, status: "ready_to_execute" as const };
}

function adoptionMutationId(operationId: string, key: string, fingerprint: string): string {
  return `adoption_${operationId.replaceAll("-", "")}_${createMergeRecordFingerprint({ recordId: key, recordType: "active_track", state: { fingerprint }, trackId: key }).slice(0, 24)}`;
}
