import { FirestorePurchaseCorrelation } from "../../modules/billing/purchaseCorrelation.js";
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
import { createRevenueCatCustomerDeletionClient } from "../revenuecat/customerDeletion.js";
import { FirestoreLegalRequestStore, type LegalRequestStore } from "../../modules/legal-requests/store.js";

export type BackendStores = Readonly<{
  firebaseAuth: FirebaseAdminAuth;
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
  purchases: FirestorePurchaseCorrelation;
  revenueCatWebhook: import("../../modules/billing/revenuecatWebhookStore.js").RevenueCatWebhookStore;
  legalRequests: LegalRequestStore;
}>;

export function createFirestoreStores(runtime: FirestoreRuntime, environment: Environment, authOverride?: FirebaseAdminAuth, deletionOverride?: import("../../modules/account-lifecycle/store.js").RevenueCatDeletionRuntime): BackendStores {
  const pseudonymKeyRing = parsePseudonymKeyRing(environment.deletionPseudonymKeysJson);
  const firebaseAuth = authOverride ?? createFirebaseAdminAuth(runtime.app);
  const contentReports = new FirestoreContentReportStore(runtime.db, {
    rateLimitHashSecret: environment.reportRateLimitHashSecret,
    rateLimitMax: environment.reportRateLimitMax,
    rateLimitWindowSeconds: environment.reportRateLimitWindowSeconds,
  });
  const purchaseScope = environment.premiumMap ?? (environment.nodeEnv === "test" && environment.revenueCatProjectId && environment.revenueCatAppId && environment.revenueCatProductId && environment.revenueCatWebhookEnvironment ? { projectId: environment.revenueCatProjectId, appId: environment.revenueCatAppId, productId: environment.revenueCatProductId, environment: environment.revenueCatWebhookEnvironment } : null);
  const deletionProjectId = environment.premiumMap?.projectId;
  const revenueCatDeletion = deletionProjectId ? {
    projectId: deletionProjectId,
    client: environment.revenueCatV2DeleteApiKey ? createRevenueCatCustomerDeletionClient({
      baseUrl: environment.revenueCatApiBaseUrl,
      apiKey: environment.revenueCatV2DeleteApiKey,
      projectId: deletionProjectId,
    }) : null,
  } : null;
  return Object.freeze({
    firebaseAuth,
    users: new FirestoreUserStore(runtime.db, pseudonymKeyRing, purchaseScope),
    devices: new FirestoreDeviceStore(runtime.db),
    progress: new FirestoreProgressStore(runtime.db),
    entitlements: new FirestoreEntitlementStore(runtime.db),
    tracks: new FirestoreTrackStore(runtime.db),
    content: new FirestoreContentVersionStore(runtime.db),
    contentReports,
    accountLifecycle: new FirestoreAccountLifecycleStore(runtime.db, firebaseAuth, pseudonymKeyRing, deletionOverride ?? revenueCatDeletion),
    admin: new FirestoreAdminStore(runtime.db, environment.adminContentRoot, environment.adminContentReleaseId),
    dataExport: new FirestoreDataExportStore(runtime.db, {
      rateLimitMax: environment.accountDataExportRateLimitMax,
      rateLimitWindowSeconds: environment.accountDataExportRateLimitWindowSeconds,
      maxSerializedBytes: environment.accountDataExportMaxSerializedBytes,
    }),
    privacyRequests: new FirestorePrivacyRequestStore(runtime.db, environment.privacyResponseKeyBase64, environment.privacyAuditHmacSecret),
    securityIncidents: new FirestoreSecurityIncidentStore(runtime.db, environment.privacyResponseKeyBase64, environment.privacyAuditHmacSecret),
    purchases: new FirestorePurchaseCorrelation(runtime.db, purchaseScope),
    revenueCatWebhook: new FirestoreRevenueCatWebhookStore(runtime.db, environment.premiumMap ?? (environment.nodeEnv === "test" ? environment.revenueCatProjectId : undefined)),
    legalRequests: new FirestoreLegalRequestStore(runtime.db, environment.privacyAuditHmacSecret),
  });
}
