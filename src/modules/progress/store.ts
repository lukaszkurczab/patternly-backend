import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, progressDocumentId } from "../../infrastructure/firestore/paths.js";
import { asIsoString, asRecord, now } from "../../infrastructure/firestore/values.js";
import type { ProgressMutation, ProgressRecord, ProgressStore, SyncBatchResult } from "./contracts.js";

const toView = (data: Record<string, unknown>): ProgressRecord => {
  if (data.kind !== "node" && data.kind !== "item" || typeof data.trackId !== "string" || typeof data.targetId !== "string" || typeof data.version !== "number" || typeof data.lastMutationId !== "string") throw new Error("progress_record_invalid");
  return Object.freeze({ kind: data.kind, trackId: data.trackId, targetId: data.targetId, version: data.version, state: asRecord(data.state, "progress_state"), lastMutationId: data.lastMutationId, updatedAt: asIsoString(data.updatedAt, "progress_updated_at") });
};

export class FirestoreProgressStore implements ProgressStore {
  public constructor(private readonly db: Firestore) {}

  public async read(userId: string): Promise<readonly ProgressRecord[]> {
    const snapshot = await this.db.collection(COLLECTIONS.users).doc(userId).collection("progress").get();
    return Object.freeze(snapshot.docs.map((document) => toView(asRecord(document.data(), "progress"))));
  }

  public async applyBatch(userId: string, deviceId: string | null, mutations: readonly ProgressMutation[]): Promise<SyncBatchResult> {
    return this.db.runTransaction(async (transaction) => {
      const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
      const progressRefs = mutations.map((mutation) => userRef.collection("progress").doc(progressDocumentId(mutation)));
      const mutationRefs = mutations.map((mutation) => userRef.collection("syncMutations").doc(mutation.mutationId));
      const snapshots = await transaction.getAll(...progressRefs, ...mutationRefs);
      const progressSnapshots = snapshots.slice(0, mutations.length);
      const mutationSnapshots = snapshots.slice(mutations.length);
      const applied: ProgressRecord[] = [];
      const duplicates: string[] = [];
      const conflicts: Array<SyncBatchResult["conflicts"][number]> = [];
      const currentByKey = new Map<string, ProgressRecord | null>();
      const appliedMutationIds = new Set<string>();
      for (let index = 0; index < mutations.length; index += 1) {
        const mutation = mutations[index]!;
        currentByKey.set(progressKey(mutation), progressSnapshots[index]!.exists ? toView(asRecord(progressSnapshots[index]!.data(), "progress")) : null);
      }
      for (let mutationIndex = 0; mutationIndex < mutations.length; mutationIndex += 1) {
        const mutation = mutations[mutationIndex]!;
        if (mutationSnapshots[mutationIndex]!.exists || appliedMutationIds.has(mutation.mutationId)) {
          duplicates.push(mutation.mutationId);
          continue;
        }
        const key = progressKey(mutation);
        const current = currentByKey.get(key) ?? null;
        if ((current?.version ?? null) !== mutation.expectedVersion) {
          conflicts.push({ mutationId: mutation.mutationId, code: "version_conflict", current });
          continue;
        }
        const nextVersion = (current?.version ?? 0) + 1;
        const updatedAt = now();
        const updated: ProgressRecord = Object.freeze({ kind: mutation.kind, trackId: mutation.trackId, targetId: mutation.targetId, version: nextVersion, state: mutation.state, lastMutationId: mutation.mutationId, updatedAt: updatedAt.toDate().toISOString() });
        transaction.set(progressRefs[mutationIndex]!, { kind: mutation.kind, trackId: mutation.trackId, targetId: mutation.targetId, version: nextVersion, state: mutation.state, lastMutationId: mutation.mutationId, updatedAt }, { merge: true });
        transaction.create(mutationRefs[mutationIndex]!, {
          ...(deviceId === null ? {} : { deviceId }),
          mutationId: mutation.mutationId,
          kind: mutation.kind,
          appliedVersion: nextVersion,
          createdAt: updatedAt,
        });
        currentByKey.set(key, updated);
        appliedMutationIds.add(mutation.mutationId);
        applied.push(updated);
      }
      return Object.freeze({ applied: Object.freeze(applied), duplicates: Object.freeze(duplicates), conflicts: Object.freeze(conflicts) });
    });
  }
}

function progressKey(mutation: Pick<ProgressMutation, "kind" | "trackId" | "targetId">): string {
  return `${mutation.kind}:${mutation.trackId}:${mutation.targetId}`;
}
