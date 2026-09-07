import { randomBytes } from "node:crypto";
import { Timestamp, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../../infrastructure/firestore/paths.js";
import { asIsoString, asRecord, now } from "../../infrastructure/firestore/values.js";
import {
  DATA_EXPORT_AUDIT_RETENTION_DAYS,
  DATA_EXPORT_INCLUDED,
  DATA_EXPORT_OMITTED,
  DATA_EXPORT_SCHEMA_VERSION,
  DataExportRateLimitError,
  DataExportTooLargeError,
  type DataExportContentReport,
  type DataExportDocument,
  type DataExportOptions,
  type DataExportProgressRecord,
  type DataExportResult,
  type DataExportStatus,
  type DataExportStore,
} from "./contracts.js";
import { projectContentReportContext } from "../content-reports/contracts.js";

const USER_COLLECTIONS = Object.freeze({
  progress: "progress",
  devices: "devices",
  trackAccess: "trackAccess",
  entitlements: "entitlements",
  legalAcceptances: "legalAcceptances",
  purchaseConfirmations: "purchaseConfirmations",
  syncMetadata: "syncMetadata",
} as const);

const EXPORT_HISTORY_LIMIT = 100;
const SAFE_SYNC_METADATA_FIELDS = Object.freeze([
  "accountRevision",
  "updatedAt",
  "lastSyncAt",
  "lastSyncedAt",
  "lastSuccessfulSyncAt",
  "syncStatus",
  "lastErrorCode",
] as const);
const DEVICE_TIME_FIELDS = Object.freeze(["createdAt", "firstSeenAt", "lastSeenAt", "updatedAt"] as const);
const DATA_EXPORT_STATUSES = new Set<DataExportStatus>(["started", "completed", "rate_limited", "too_large", "failed"]);

function timestampPortable(record: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(Object.entries(record).map(([key, value]) => [key, value instanceof Timestamp || value instanceof Date ? asIsoString(value, key) : value])));
}

type ExportAuditData = Readonly<{
  exportId: string;
  userId: string;
  createdAt: Timestamp;
  status: DataExportStatus;
  schemaVersion: typeof DATA_EXPORT_SCHEMA_VERSION;
  scope: readonly string[];
  expiresAt: Timestamp;
}>;

type ExportSnapshot = Readonly<{
  profile: DataExportDocument["portable"]["profile"];
  progress: readonly DataExportProgressRecord[];
  linkedContentReports: readonly DataExportContentReport[];
  trackAccess: readonly Readonly<Record<string, unknown>>[];
  entitlements: readonly Readonly<Record<string, unknown>>[];
  legalAcceptances: readonly Readonly<Record<string, unknown>>[];
  purchaseConfirmations: readonly Readonly<Record<string, unknown>>[];
  consumerCases: readonly Readonly<Record<string, unknown>>[];
  devices: readonly Readonly<Record<string, unknown>>[];
  syncMetadata: Readonly<Record<string, unknown>>;
  exportHistory: readonly Readonly<Record<string, unknown>>[];
}>;

/**
 * Aggregates only the account-owned, user-facing projections that are part of
 * the export contract.  It deliberately does not read credentials, raw sync
 * journals, product content or collections that are not listed below.
 */
export class FirestoreDataExportStore implements DataExportStore {
  public constructor(private readonly db: Firestore, private readonly options: DataExportOptions) {}

  public async create(userId: string, stableExportId?: string, onCompleted?: (result: DataExportResult) => Promise<void>): Promise<DataExportResult> {
    const exportId = stableExportId ?? createExportId();
    if (!/^export_[A-Za-z0-9_-]{32}$/u.test(exportId)) throw new Error("account_data_export_id_invalid");
    const createdAt = now();
    const auditRef = this.auditRef(exportId);

    let retryFailedAudit = false;
    if (stableExportId) {
      const existing = await auditRef.get();
      if (existing.exists) {
        const audit = asRecord(existing.data(), "account_data_export_audit");
        if (audit.userId !== userId) throw new Error("account_data_export_operation_conflict");
        if (audit.status === "failed") retryFailedAudit = true;
        else throw new Error(audit.status === "completed" ? "account_data_export_already_completed" : "account_data_export_operation_conflict");
      }
    }

    if (retryFailedAudit) await auditRef.update({ status: "started", createdAt });
    else await this.claimRateLimitAndCreateAudit(userId, exportId, createdAt, auditRef);

    try {
      const result = await this.buildResult(userId, exportId, createdAt);
      await onCompleted?.(result);
      await this.updateAudit(auditRef, "completed");
      return result;
    } catch (error) {
      await this.updateAudit(auditRef, error instanceof DataExportTooLargeError ? "too_large" : "failed").catch(() => undefined);
      throw error;
    }
  }

  private async buildResult(userId: string, exportId: string, createdAt: Timestamp): Promise<DataExportResult> {
    const snapshot = await this.readSnapshot(userId, exportId);
    const serialized = JSON.stringify(buildExportDocument(exportId, createdAt.toDate().toISOString(), snapshot));
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    if (serializedBytes > this.options.maxSerializedBytes) throw new DataExportTooLargeError(serializedBytes, this.options.maxSerializedBytes);
    return Object.freeze({ exportId, serialized, serializedBytes });
  }

  private auditRef(exportId: string): DocumentReference {
    return this.db.collection(COLLECTIONS.accountDataExportAudits).doc(exportId);
  }

  private rateLimitRef(userId: string): DocumentReference {
    return this.db.collection(COLLECTIONS.accountDataExportRateLimits).doc(userId);
  }

  private async claimRateLimitAndCreateAudit(userId: string, exportId: string, createdAt: Timestamp, auditRef: DocumentReference): Promise<void> {
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const rateLimitRef = this.rateLimitRef(userId);
    try {
      await this.db.runTransaction(async (transaction) => {
        const [userSnapshot, rateLimitSnapshot] = await transaction.getAll(userRef, rateLimitRef);
        if (!userSnapshot || !rateLimitSnapshot) throw new Error("account_data_export_snapshot_missing");
        if (!userSnapshot.exists || asRecord(userSnapshot.data(), "user").deletedAt !== undefined) throw new Error("account_deleted");

        const rateLimit = rateLimitSnapshot.exists ? asRecord(rateLimitSnapshot.data(), "account_data_export_rate_limit") : null;
        const windowStartedAt = asOptionalTimestamp(rateLimit?.windowStartedAt);
        const count = asNonNegativeInteger(rateLimit?.count);
        const windowMillis = this.options.rateLimitWindowSeconds * 1_000;
        const withinWindow = windowStartedAt !== null && createdAt.toMillis() - windowStartedAt.toMillis() < windowMillis;
        if (withinWindow && count >= this.options.rateLimitMax) {
          const retryAfterSeconds = Math.max(1, Math.ceil((windowStartedAt!.toMillis() + windowMillis - createdAt.toMillis()) / 1_000));
          throw new DataExportRateLimitError(retryAfterSeconds);
        }

        const nextWindowStartedAt = withinWindow ? windowStartedAt! : createdAt;
        const nextCount = withinWindow ? count + 1 : 1;
        transaction.set(rateLimitRef, {
          windowStartedAt: nextWindowStartedAt,
          count: nextCount,
          updatedAt: createdAt,
          expiresAt: Timestamp.fromMillis(nextWindowStartedAt.toMillis() + windowMillis),
        }, { merge: true });
        transaction.create(auditRef, auditData(exportId, userId, createdAt, "started"));
      });
    } catch (error) {
      if (error instanceof DataExportRateLimitError) {
        await this.writeRateLimitedAudit(auditRef, exportId, userId, createdAt);
      }
      throw error;
    }
  }

  private async writeRateLimitedAudit(auditRef: DocumentReference, exportId: string, userId: string, createdAt: Timestamp): Promise<void> {
    await auditRef.create(auditData(exportId, userId, createdAt, "rate_limited")).catch(() => undefined);
  }

  private async updateAudit(auditRef: DocumentReference, status: DataExportStatus): Promise<void> {
    await auditRef.update({ status });
  }

  private async readSnapshot(userId: string, currentExportId: string): Promise<ExportSnapshot> {
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const [userSnapshot, identitiesSnapshot, progressSnapshot, devicesSnapshot, trackAccessSnapshot, entitlementsSnapshot, legalAcceptancesSnapshot, purchaseConfirmationsSnapshot, syncMetadataSnapshot, reportsSnapshot, consumerCasesSnapshot, auditSnapshot] = await Promise.all([
      userRef.get(),
      this.db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId).get(),
      userRef.collection(USER_COLLECTIONS.progress).get(),
      userRef.collection(USER_COLLECTIONS.devices).get(),
      userRef.collection(USER_COLLECTIONS.trackAccess).get(),
      userRef.collection(USER_COLLECTIONS.entitlements).get(),
      userRef.collection(USER_COLLECTIONS.legalAcceptances).get(),
      userRef.collection(USER_COLLECTIONS.purchaseConfirmations).get(),
      userRef.collection(USER_COLLECTIONS.syncMetadata).get(),
      this.db.collection(COLLECTIONS.contentReports).where("accountId", "==", userId).get(),
      this.db.collection("legalRequests").where("userId", "==", userId).get(),
      this.db.collection(COLLECTIONS.accountDataExportAudits).where("userId", "==", userId).orderBy("createdAt", "desc").limit(EXPORT_HISTORY_LIMIT + 1).get(),
    ]);

    if (!userSnapshot.exists || asRecord(userSnapshot.data(), "user").deletedAt !== undefined) throw new Error("account_deleted");
    const user = asRecord(userSnapshot.data(), "user");
    const identity = readSafeIdentity(identitiesSnapshot.docs.map((document) => ({ id: document.id, data: asRecord(document.data(), "identity_mapping") })));
    const progress = progressSnapshot.docs
      .map((document) => readProgressRecord(asRecord(document.data(), "progress")))
      .sort(compareBy((record) => `${record.recordType}:${record.targetId}:${record.trackId}`));
    const linkedContentReports = reportsSnapshot.docs
      .map((document) => readLinkedContentReport(asRecord(document.data(), "content_report")))
      .sort(compareBy((report) => `${report.createdAt}:${report.id}`));

    return Object.freeze({
      profile: Object.freeze({ createdAt: asIsoString(user.createdAt, "user_created_at"), identity }),
      progress: Object.freeze(progress),
      linkedContentReports: Object.freeze(linkedContentReports),
      trackAccess: Object.freeze(trackAccessSnapshot.docs.map((document) => readTrackAccess(asRecord(document.data(), "track_access"))).sort(compareBy((row) => String(row.trackId)))),
      entitlements: Object.freeze(entitlementsSnapshot.docs.map((document) => readEntitlement(asRecord(document.data(), "entitlement"))).sort(compareBy((row) => String(row.entitlement)))),
      legalAcceptances: Object.freeze(legalAcceptancesSnapshot.docs.map((document) => timestampPortable(asRecord(document.data(), "legal_acceptance")))),
      purchaseConfirmations: Object.freeze(purchaseConfirmationsSnapshot.docs.map((document) => timestampPortable(asRecord(document.data(), "purchase_confirmation")))),
      consumerCases: Object.freeze(consumerCasesSnapshot.docs.map((document) => {
        const row = timestampPortable(asRecord(document.data(), "legal_request"));
        return Object.freeze(Object.fromEntries(Object.entries(row).filter(([key]) => !["subjectKey", "lastActorPseudonym"].includes(key))));
      })),
      devices: Object.freeze(devicesSnapshot.docs.map((document) => readDevice(asRecord(document.data(), "device"))).sort(compareBy((row) => `${String(row.platform)}:${String(row.appVersion)}:${String(row.lastSeenAt ?? row.updatedAt ?? "")}`))),
      syncMetadata: readSyncMetadata(syncMetadataSnapshot.docs.map((document) => ({ ...asRecord(document.data(), "sync_metadata"), id: document.id }))),
      exportHistory: Object.freeze(auditSnapshot.docs
        .map((document) => readAuditHistory(asRecord(document.data(), "account_data_export_audit")))
        .filter((history): history is Readonly<Record<string, unknown>> => history !== null && history.exportId !== currentExportId)
        .sort((left, right) => String(right.exportedAt).localeCompare(String(left.exportedAt)) || String(right.exportId).localeCompare(String(left.exportId)))
        .slice(0, EXPORT_HISTORY_LIMIT)),
    });
  }
}

function createExportId(): string {
  return `export_${randomBytes(24).toString("base64url")}`;
}

function auditData(exportId: string, userId: string, createdAt: Timestamp, status: DataExportStatus): ExportAuditData {
  return Object.freeze({
    exportId,
    userId,
    createdAt,
    status,
    schemaVersion: DATA_EXPORT_SCHEMA_VERSION,
    scope: DATA_EXPORT_INCLUDED,
    expiresAt: Timestamp.fromMillis(createdAt.toMillis() + DATA_EXPORT_AUDIT_RETENTION_DAYS * 86_400_000),
  });
}

function buildExportDocument(exportId: string, exportedAt: string, snapshot: ExportSnapshot): DataExportDocument {
  return Object.freeze({
    schemaVersion: DATA_EXPORT_SCHEMA_VERSION,
    exportId,
    exportedAt,
    scope: Object.freeze({ portable: "user_data_and_activity", accountContext: "user_visible_account_context" }),
    article15Information: Object.freeze({
      purposes: Object.freeze(["utrzymanie konta", "realizacja usługi nauki", "synchronizacja postępu", "obsługa zakupionego dostępu", "bezpieczeństwo i obsługa zgłoszeń"]),
      dataCategories: Object.freeze(["dane konta i identyfikacji", "postęp i aktywność w nauce", "uprawnienia do treści", "dane urządzenia ograniczone do obsługi synchronizacji", "zgłoszenia powiązane z kontem"]),
      recipientCategories: Object.freeze(["dostawcy infrastruktury chmurowej i uwierzytelniania", "Apple jako niezależny operator App Store i płatności", "podmioty uprawnione na podstawie prawa"]),
      retentionCriteria: Object.freeze(["czas trwania konta i świadczenia usługi", "okres wymagany do rozliczeń, bezpieczeństwa i dochodzenia roszczeń", "krótsze okresy wskazane w polityce prywatności dla danych technicznych i zgłoszeń"]),
      dataSources: Object.freeze(["osoba korzystająca z aplikacji", "urządzenie i aplikacja podczas korzystania z usługi", "Apple w zakresie potwierdzenia uprawnienia do zakupionej usługi"]),
      internationalTransfers: "Transfery poza EOG mogą wystąpić wyłącznie przez wskazanych dostawców i z zastosowaniem mechanizmu wymaganego przez RODO; aktualne szczegóły znajdują się w Polityce prywatności.",
      automatedDecisionMaking: "Patternly nie podejmuje wobec użytkownika decyzji wywołujących skutki prawne lub podobnie istotne wyłącznie w sposób zautomatyzowany.",
      rightsAndComplaint: "Przysługują Ci prawa wynikające z RODO, w tym prawo do sprostowania, usunięcia, ograniczenia, sprzeciwu i przenoszenia w odpowiednim zakresie, oraz prawo wniesienia skargi do Prezesa Urzędu Ochrony Danych Osobowych.",
    }),
    portable: Object.freeze({
      profile: snapshot.profile,
      progress: snapshot.progress,
      linkedContentReports: snapshot.linkedContentReports,
    }),
    accountContext: Object.freeze({
      trackAccess: snapshot.trackAccess,
      entitlements: snapshot.entitlements,
      legalAcceptances: snapshot.legalAcceptances,
      purchaseConfirmations: snapshot.purchaseConfirmations,
      consumerCases: snapshot.consumerCases,
      devices: snapshot.devices,
      syncMetadata: snapshot.syncMetadata,
      exportHistory: snapshot.exportHistory,
    }),
    manifest: Object.freeze({ included: DATA_EXPORT_INCLUDED, omitted: DATA_EXPORT_OMITTED }),
  });
}

function readSafeIdentity(documents: readonly Readonly<{ id: string; data: Record<string, unknown> }>[]): DataExportDocument["portable"]["profile"]["identity"] {
  const identity = [...documents].sort((left, right) => left.id.localeCompare(right.id))[0]?.data;
  if (!identity || typeof identity.provider !== "string" || identity.provider.length === 0 || typeof identity.emailVerified !== "boolean") throw new Error("identity_mapping_invalid");
  return Object.freeze({
    provider: identity.provider,
    email: typeof identity.email === "string" ? identity.email : null,
    emailVerified: identity.emailVerified,
  });
}

function readProgressRecord(row: Record<string, unknown>): DataExportProgressRecord {
  const kind = row.kind;
  const recordType = row.recordType;
  const trackId = row.trackId;
  const targetId = row.targetId;
  const version = row.version;
  const fingerprint = row.fingerprint;
  const lastMutationId = row.lastMutationId;
  if ((kind !== "node" && kind !== "item") || typeof recordType !== "string" || typeof trackId !== "string" || typeof targetId !== "string" || typeof version !== "number" || !Number.isSafeInteger(version) || version < 0 || typeof fingerprint !== "string" || typeof lastMutationId !== "string") throw new Error("progress_record_invalid");
  const state = row.state;
  if (!isRecordLike(state)) throw new Error("progress_state_record_invalid");
  return Object.freeze({
    kind,
    recordType,
    trackId,
    targetId,
    version,
    fingerprint,
    state: asJsonRecord(state, "progress_state"),
    lastMutationId,
    updatedAt: asIsoString(row.updatedAt, "progress_updated_at"),
  });
}

function readLinkedContentReport(row: Record<string, unknown>): DataExportContentReport {
  if (typeof row.id !== "string" || typeof row.clientSubmissionId !== "string" || typeof row.trackId !== "string" || typeof row.contentVersion !== "string" || typeof row.itemId !== "string" || typeof row.reason !== "string" || typeof row.description !== "string" || typeof row.status !== "string" || !isRecordLike(row.context)) throw new Error("content_report_record_invalid");
  const linkage = typeof row.contactEmail === "string" ? "account_and_contact" : "account";
  return Object.freeze({
    id: row.id,
    clientSubmissionId: row.clientSubmissionId,
    trackId: row.trackId,
    contentVersion: row.contentVersion,
    itemId: row.itemId,
    reason: row.reason,
    description: row.description,
    context: projectContentReportContext(row.context),
    linkage,
    status: row.status,
    createdAt: asIsoString(row.createdAt, "content_report_created_at"),
    updatedAt: asIsoString(row.updatedAt, "content_report_updated_at"),
  });
}

function readTrackAccess(row: Record<string, unknown>): Readonly<Record<string, unknown>> {
  if (typeof row.trackId !== "string" || typeof row.source !== "string" || typeof row.status !== "string") throw new Error("track_access_record_invalid");
  return Object.freeze({ trackId: row.trackId, source: row.source, status: row.status, updatedAt: asIsoString(row.updatedAt, "track_access_updated_at") });
}

function readEntitlement(row: Record<string, unknown>): Readonly<Record<string, unknown>> {
  if (typeof row.entitlement !== "string" || typeof row.status !== "string" || typeof row.source !== "string") throw new Error("entitlement_record_invalid");
  return Object.freeze({
    entitlement: row.entitlement,
    status: row.status,
    source: row.source,
    expiresAt: row.expiresAt === null || row.expiresAt === undefined ? null : asIsoString(row.expiresAt, "entitlement_expires_at"),
    updatedAt: asIsoString(row.updatedAt, "entitlement_updated_at"),
  });
}

function readDevice(row: Record<string, unknown>): Readonly<Record<string, unknown>> {
  if (typeof row.platform !== "string" || typeof row.appVersion !== "string") throw new Error("device_record_invalid");
  const result: Record<string, unknown> = { platform: row.platform, appVersion: row.appVersion };
  for (const field of DEVICE_TIME_FIELDS) {
    if (row[field] !== undefined && row[field] !== null) result[field] = asIsoString(row[field], `device_${field}`);
  }
  return Object.freeze(result);
}

function readSyncMetadata(rows: readonly Record<string, unknown>[]): Readonly<Record<string, unknown>> {
  const account = rows.find((row) => row.id === "account") ?? rows[0] ?? {};
  const result: Record<string, unknown> = { accountRevision: readAccountRevision(account.accountRevision), updatedAt: account.updatedAt === undefined || account.updatedAt === null ? null : asIsoString(account.updatedAt, "sync_metadata_updated_at") };
  for (const field of SAFE_SYNC_METADATA_FIELDS) {
    if (field === "accountRevision" || field === "updatedAt" || account[field] === undefined || account[field] === null) continue;
    result[field] = field.endsWith("At") ? asIsoString(account[field], `sync_metadata_${field}`) : toJsonValue(account[field]);
  }
  return Object.freeze(result);
}

function readAccountRevision(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("account_revision_invalid");
  return value;
}

function readAuditHistory(row: Record<string, unknown>): Readonly<Record<string, unknown>> | null {
  if (typeof row.exportId !== "string" || typeof row.status !== "string" || !DATA_EXPORT_STATUSES.has(row.status as DataExportStatus) || row.schemaVersion !== DATA_EXPORT_SCHEMA_VERSION) throw new Error("account_data_export_audit_invalid");
  const expiresAt = asOptionalTimestamp(row.expiresAt);
  if (expiresAt === null || expiresAt.toMillis() <= Date.now()) return null;
  return Object.freeze({ exportId: row.exportId, exportedAt: asIsoString(row.createdAt, "account_data_export_created_at"), status: row.status, schemaVersion: DATA_EXPORT_SCHEMA_VERSION });
}

function asOptionalTimestamp(value: unknown): Timestamp | null {
  if (value instanceof Timestamp) return value;
  if (value instanceof Date) return Timestamp.fromDate(value);
  return null;
}

function asNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof Timestamp) && !Buffer.isBuffer(value);
}

function asJsonRecord(value: Record<string, unknown>, field: string): Readonly<Record<string, unknown>> {
  try {
    return Object.freeze(toJsonValue(value) as Record<string, unknown>);
  } catch {
    throw new Error(`${field}_not_serializable`);
  }
}

function toJsonValue(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item));
  if (isRecordLike(value)) return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => item === undefined ? [] : [[key, toJsonValue(item)]]));
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

function compareBy<T>(selector: (value: T) => string): (left: T, right: T) => number {
  return (left, right) => selector(left).localeCompare(selector(right));
}

export { FirestoreDataExportStore as FirestoreAccountDataExportStore };
