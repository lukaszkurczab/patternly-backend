import { z } from "zod";

const progressState = z.record(z.unknown()).refine((value) => JSON.stringify(value).length <= 64 * 1024, "progress_state_too_large");

export const progressMutationSchema = z.object({
  mutationId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u),
  kind: z.enum(["node", "item"]),
  trackId: z.string().min(1).max(128),
  targetId: z.string().min(1).max(256),
  expectedVersion: z.number().int().nonnegative().nullable(),
  state: progressState,
});

export const syncRequestSchema = z.object({
  deviceId: z.string().uuid().nullable().optional().default(null),
  mutations: z.array(progressMutationSchema).min(1).max(100),
});

export type ProgressMutation = z.infer<typeof progressMutationSchema>;
export type SyncRequest = z.infer<typeof syncRequestSchema>;

export type ProgressRecord = Readonly<{
  kind: "node" | "item";
  trackId: string;
  targetId: string;
  version: number;
  state: Readonly<Record<string, unknown>>;
  lastMutationId: string;
  updatedAt: string;
}>;

export type ProgressConflict = Readonly<{
  mutationId: string;
  code: "version_conflict";
  current: ProgressRecord | null;
}>;

export type SyncBatchResult = Readonly<{
  applied: readonly ProgressRecord[];
  duplicates: readonly string[];
  conflicts: readonly ProgressConflict[];
}>;

export interface ProgressStore {
  read(userId: string): Promise<readonly ProgressRecord[]>;
  applyBatch(userId: string, deviceId: string | null, mutations: readonly ProgressMutation[]): Promise<SyncBatchResult>;
}
