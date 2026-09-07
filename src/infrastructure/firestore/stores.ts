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
import { createFirebaseAdminAuth } from "../firebase/adminAuth.js";
import type { FirebaseAdminAuth } from "../firebase/adminAuth.js";
import { FirestoreAccountLifecycleStore, type AccountLifecycleStore } from "../../modules/account-lifecycle/store.js";
import { FirestoreAdminStore, type AdminStore } from "../../modules/admin/store.js";
import { parsePseudonymKeyRing } from "../security/pseudonymKeyRing.js";
import { FirestoreDataExportStore } from "../../modules/data-export/store.js";
import type { DataExportStore } from "../../modules/data-export/contracts.js";
import { FirestorePrivacyRequestStore, type PrivacyRequestStore } from "../../modules/privacy-requests/store.js";
import { FirestoreSecurityIncidentStore, type SecurityIncidentStore } from "../../modules/security-incidents/store.js";
import { FirestoreRevenueCatWebhookStore } from "../../modules/billing/revenuecatWebhookStore.js";
import { FirestoreLegalRequestStore, type LegalRequestStore } from "../../modules/legal-requests/store.js";

export type BackendStores = Readonly<{
  users: UserStore;
  devices: DeviceStore;
  progress: ProgressStore;
  entitlements: EntitlementStore;
  tracks: TrackStore;
  content: ContentVersionStore;
  contentReports: ContentReportStore;
  accountLifecycle: AccountLifecycleStore;
  admin: AdminStore;
  dataExport: DataExportStore;
  privacyRequests: PrivacyRequestStore;
  securityIncidents: SecurityIncidentStore;
  revenueCatWebhook: import("../../modules/billing/revenuecatWebhookStore.js").RevenueCatWebhookStore;
  legalRequests: LegalRequestStore;
}>;

export function createFirestoreStores(runtime: FirestoreRuntime, environment: Environment, authOverride?: FirebaseAdminAuth): BackendStores {
  const pseudonymKeyRing = parsePseudonymKeyRing(environment.deletionPseudonymKeysJson);
  const contentReports = new FirestoreContentReportStore(runtime.db, {
    rateLimitHashSecret: environment.reportRateLimitHashSecret,
    rateLimitMax: environment.reportRateLimitMax,
    rateLimitWindowSeconds: environment.reportRateLimitWindowSeconds,
  });
  return Object.freeze({
    users: new FirestoreUserStore(runtime.db, pseudonymKeyRing),
    devices: new FirestoreDeviceStore(runtime.db),
    progress: new FirestoreProgressStore(runtime.db),
    entitlements: new FirestoreEntitlementStore(runtime.db),
    tracks: new FirestoreTrackStore(runtime.db),
    content: new FirestoreContentVersionStore(runtime.db),
    contentReports,
    accountLifecycle: new FirestoreAccountLifecycleStore(runtime.db, authOverride ?? createFirebaseAdminAuth(runtime.app), pseudonymKeyRing),
    admin: new FirestoreAdminStore(runtime.db, environment.adminContentRoot, environment.adminContentReleaseId),
    dataExport: new FirestoreDataExportStore(runtime.db, {
      rateLimitMax: environment.accountDataExportRateLimitMax,
      rateLimitWindowSeconds: environment.accountDataExportRateLimitWindowSeconds,
      maxSerializedBytes: environment.accountDataExportMaxSerializedBytes,
    }),
    privacyRequests: new FirestorePrivacyRequestStore(runtime.db, environment.privacyResponseKeyBase64, environment.privacyAuditHmacSecret),
    securityIncidents: new FirestoreSecurityIncidentStore(runtime.db, environment.privacyResponseKeyBase64, environment.privacyAuditHmacSecret),
    revenueCatWebhook: new FirestoreRevenueCatWebhookStore(runtime.db),
    legalRequests: new FirestoreLegalRequestStore(runtime.db, environment.privacyAuditHmacSecret),
  });
}
