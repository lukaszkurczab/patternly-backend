import type { FirestoreRuntime } from "./client.js";
import { FirestoreContentVersionStore, type ContentVersionStore } from "../../modules/content/store.js";
import { FirestoreContentReportStore } from "../../modules/content-reports/store.js";
import type { ContentReportStore } from "../../modules/content-reports/contracts.js";
import { FirestoreDeviceStore, type DeviceStore } from "../../modules/devices/store.js";
import { FirestoreEntitlementStore, type EntitlementStore } from "../../modules/entitlements/store.js";
import { FirestoreProgressStore } from "../../modules/progress/store.js";
import type { ProgressStore } from "../../modules/progress/contracts.js";
import { FirestoreTrackStore, type TrackStore } from "../../modules/tracks/store.js";
import { FirestoreUserStore, type UserStore } from "../../modules/users/store.js";
import type { Environment } from "../../config/environment.js";

export type BackendStores = Readonly<{
  users: UserStore;
  devices: DeviceStore;
  progress: ProgressStore;
  entitlements: EntitlementStore;
  tracks: TrackStore;
  content: ContentVersionStore;
  contentReports: ContentReportStore;
}>;

export function createFirestoreStores(runtime: FirestoreRuntime, environment: Environment): BackendStores {
  return Object.freeze({
    users: new FirestoreUserStore(runtime.db),
    devices: new FirestoreDeviceStore(runtime.db),
    progress: new FirestoreProgressStore(runtime.db),
    entitlements: new FirestoreEntitlementStore(runtime.db),
    tracks: new FirestoreTrackStore(runtime.db),
    content: new FirestoreContentVersionStore(runtime.db),
    contentReports: new FirestoreContentReportStore(runtime.db, {
      rateLimitHashSecret: environment.reportRateLimitHashSecret,
      rateLimitMax: environment.reportRateLimitMax,
      rateLimitWindowSeconds: environment.reportRateLimitWindowSeconds,
    }),
  });
}
