import type { DatabaseRuntime } from "./client.js";
import { DrizzleContentVersionStore, type ContentVersionStore } from "../../modules/content/store.js";
import { DrizzleContentReportStore } from "../../modules/content-reports/store.js";
import type { ContentReportStore } from "../../modules/content-reports/contracts.js";
import { DrizzleDeviceStore, type DeviceStore } from "../../modules/devices/store.js";
import { DrizzleEntitlementStore, type EntitlementStore } from "../../modules/entitlements/store.js";
import { DrizzleProgressStore } from "../../modules/progress/store.js";
import type { ProgressStore } from "../../modules/progress/contracts.js";
import { DrizzleTrackStore, type TrackStore } from "../../modules/tracks/store.js";
import { DrizzleUserStore, type UserStore } from "../../modules/users/store.js";

export type BackendStores = Readonly<{
  users: UserStore;
  devices: DeviceStore;
  progress: ProgressStore;
  entitlements: EntitlementStore;
  tracks: TrackStore;
  content: ContentVersionStore;
  contentReports: ContentReportStore;
}>;

export function createStores(runtime: DatabaseRuntime): BackendStores {
  const { db } = runtime;
  return Object.freeze({
    users: new DrizzleUserStore(db),
    devices: new DrizzleDeviceStore(db),
    progress: new DrizzleProgressStore(db),
    entitlements: new DrizzleEntitlementStore(db),
    tracks: new DrizzleTrackStore(db),
    content: new DrizzleContentVersionStore(db),
    contentReports: new DrizzleContentReportStore(db),
  });
}
