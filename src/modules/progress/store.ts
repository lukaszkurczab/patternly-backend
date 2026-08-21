import { and, eq } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import { itemProgress, nodeProgress, syncMutations } from "../../infrastructure/database/schema.js";
import type { ProgressMutation, ProgressRecord, ProgressStore, SyncBatchResult } from "./contracts.js";

const asProgressRecord = (row: typeof nodeProgress.$inferSelect | typeof itemProgress.$inferSelect): ProgressRecord => ({
  kind: "nodeId" in row ? "node" : "item",
  trackId: row.trackId,
  targetId: "nodeId" in row ? row.nodeId : row.itemId,
  version: row.version,
  state: row.state,
  lastMutationId: row.lastMutationId,
  updatedAt: row.updatedAt.toISOString(),
});

export class DrizzleProgressStore implements ProgressStore {
  public constructor(private readonly db: Database) {}

  public async read(userId: string): Promise<readonly ProgressRecord[]> {
    const [nodes, items] = await Promise.all([
      this.db.select().from(nodeProgress).where(eq(nodeProgress.userId, userId)),
      this.db.select().from(itemProgress).where(eq(itemProgress.userId, userId)),
    ]);
    return Object.freeze([...nodes.map(asProgressRecord), ...items.map(asProgressRecord)]);
  }

  public async applyBatch(userId: string, deviceId: string | null, mutations: readonly ProgressMutation[]): Promise<SyncBatchResult> {
    return this.db.transaction(async (tx) => {
      const applied: ProgressRecord[] = [];
      const duplicates: string[] = [];
      const conflicts: Array<SyncBatchResult["conflicts"][number]> = [];
      for (const mutation of mutations) {
        const duplicate = await tx.select({ mutationId: syncMutations.mutationId })
          .from(syncMutations)
          .where(and(eq(syncMutations.userId, userId), eq(syncMutations.mutationId, mutation.mutationId)))
          .limit(1);
        if (duplicate[0]) {
          duplicates.push(mutation.mutationId);
          continue;
        }
        const current = await readCurrent(tx, userId, mutation);
        if ((current?.version ?? null) !== mutation.expectedVersion) {
          conflicts.push({ mutationId: mutation.mutationId, code: "version_conflict", current });
          continue;
        }
        const nextVersion = (current?.version ?? 0) + 1;
        const updated = await writeCurrent(tx, userId, mutation, nextVersion);
        await tx.insert(syncMutations).values({
          userId,
          ...(deviceId === null ? {} : { deviceId }),
          mutationId: mutation.mutationId,
          kind: mutation.kind,
          payload: mutation.state,
          appliedVersion: nextVersion,
        });
        applied.push(updated);
      }
      return Object.freeze({ applied: Object.freeze(applied), duplicates: Object.freeze(duplicates), conflicts: Object.freeze(conflicts) });
    });
  }
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function readCurrent(tx: Transaction, userId: string, mutation: ProgressMutation): Promise<ProgressRecord | null> {
  if (mutation.kind === "node") {
    const rows = await tx.select().from(nodeProgress).where(and(eq(nodeProgress.userId, userId), eq(nodeProgress.trackId, mutation.trackId), eq(nodeProgress.nodeId, mutation.targetId))).limit(1);
    return rows[0] ? asProgressRecord(rows[0]) : null;
  }
  const rows = await tx.select().from(itemProgress).where(and(eq(itemProgress.userId, userId), eq(itemProgress.trackId, mutation.trackId), eq(itemProgress.itemId, mutation.targetId))).limit(1);
  return rows[0] ? asProgressRecord(rows[0]) : null;
}

async function writeCurrent(tx: Transaction, userId: string, mutation: ProgressMutation, version: number): Promise<ProgressRecord> {
  if (mutation.kind === "node") {
    const [row] = await tx.insert(nodeProgress).values({ userId, trackId: mutation.trackId, nodeId: mutation.targetId, version, state: mutation.state, lastMutationId: mutation.mutationId }).onConflictDoUpdate({ target: [nodeProgress.userId, nodeProgress.trackId, nodeProgress.nodeId], set: { version, state: mutation.state, lastMutationId: mutation.mutationId, updatedAt: new Date() } }).returning();
    if (!row) throw new Error("node_progress_write_failed");
    return asProgressRecord(row);
  }
  const [row] = await tx.insert(itemProgress).values({ userId, trackId: mutation.trackId, itemId: mutation.targetId, version, state: mutation.state, lastMutationId: mutation.mutationId }).onConflictDoUpdate({ target: [itemProgress.userId, itemProgress.trackId, itemProgress.itemId], set: { version, state: mutation.state, lastMutationId: mutation.mutationId, updatedAt: new Date() } }).returning();
  if (!row) throw new Error("item_progress_write_failed");
  return asProgressRecord(row);
}
