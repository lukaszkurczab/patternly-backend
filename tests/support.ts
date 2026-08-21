import type { BackendStores } from "../src/infrastructure/database/stores.js";
import type { ContentVersionStore, ContentVersionView } from "../src/modules/content/store.js";
import type { DeviceStore } from "../src/modules/devices/store.js";
import type { EntitlementStore, EntitlementView } from "../src/modules/entitlements/store.js";
import type { AuthenticatedIdentity } from "../src/modules/auth/contracts.js";
import type { ProgressMutation, ProgressRecord, ProgressStore, SyncBatchResult } from "../src/modules/progress/contracts.js";
import type { TrackAccessView, TrackStore } from "../src/modules/tracks/store.js";
import type { UserProfile, UserStore } from "../src/modules/users/store.js";

export function createMemoryStores(): BackendStores {
  const userId = "3f7b5b37-9e9a-4f4f-9db1-2bcbbaea3e29";
  const profile: UserProfile = { id: userId, createdAt: "2026-08-21T00:00:00.000Z", identity: { provider: "firebase", subject: "firebase-subject", email: "learner@example.com", emailVerified: true } };
  const records = new Map<string, ProgressRecord>();
  const mutationIds = new Set<string>();

  const users: UserStore = {
    async ensureUser(identity: AuthenticatedIdentity) { if (identity.subject !== profile.identity.subject) throw new Error("unexpected_identity"); return { userId }; },
    async readProfile(requestedUserId: string) { return requestedUserId === userId ? profile : null; },
  };
  const progress: ProgressStore = {
    async read(requestedUserId) { return requestedUserId === userId ? [...records.values()] : []; },
    async applyBatch(requestedUserId, _deviceId, mutations: readonly ProgressMutation[]): Promise<SyncBatchResult> {
      if (requestedUserId !== userId) throw new Error("unexpected_user");
      const applied: ProgressRecord[] = [];
      const duplicates: string[] = [];
      const conflicts: SyncBatchResult["conflicts"][number][] = [];
      for (const mutation of mutations) {
        if (mutationIds.has(mutation.mutationId)) { duplicates.push(mutation.mutationId); continue; }
        const key = `${mutation.kind}:${mutation.trackId}:${mutation.targetId}`;
        const current = records.get(key) ?? null;
        if ((current?.version ?? null) !== mutation.expectedVersion) { conflicts.push({ mutationId: mutation.mutationId, code: "version_conflict", current }); continue; }
        const next: ProgressRecord = { kind: mutation.kind, trackId: mutation.trackId, targetId: mutation.targetId, version: (current?.version ?? 0) + 1, state: mutation.state, lastMutationId: mutation.mutationId, updatedAt: "2026-08-21T00:00:00.000Z" };
        records.set(key, next);
        mutationIds.add(mutation.mutationId);
        applied.push(next);
      }
      return { applied, duplicates, conflicts };
    },
  };
  const entitlements: EntitlementStore = { async read() { return [] as readonly EntitlementView[]; } };
  const tracks: TrackStore = { async readAccess() { return [] as readonly TrackAccessView[]; } };
  const content: ContentVersionStore = { async readCurrent() { return [] as readonly ContentVersionView[]; } };
  const devices: DeviceStore = { async touch() { return "device-id"; } };
  return { users, devices, progress, entitlements, tracks, content };
}

export const testEnvironment = {
  nodeEnv: "test" as const,
  port: 8080,
  host: "127.0.0.1",
  logLevel: "silent",
  databaseUrl: undefined,
  firebaseProjectId: "patternly-app-sandbox",
  firebaseAuthIssuer: "https://securetoken.google.com/patternly-app-sandbox",
  revenueCatApiBaseUrl: "https://api.revenuecat.com",
  revenueCatSecretName: undefined,
  contentCatalogOrigin: undefined,
};
