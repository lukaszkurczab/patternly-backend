/**
 * The public account-data export contract is intentionally versioned.  Keep
 * the value stable once clients have started downloading this document.
 */
export const DATA_EXPORT_SCHEMA_VERSION = "account-data-export-v1" as const;

export const DATA_EXPORT_AUDIT_RETENTION_DAYS = 30 as const;

export const DATA_EXPORT_INCLUDED = Object.freeze([
  "portable.profile",
  "portable.progress",
  "portable.linkedContentReports",
  "accountContext.trackAccess",
  "accountContext.entitlements",
  "accountContext.legalAcceptances",
  "accountContext.purchaseConfirmations",
  "accountContext.consumerCases",
  "accountContext.devices",
  "accountContext.syncMetadata",
  "accountContext.exportHistory",
] as const);

export const DATA_EXPORT_OMITTED = Object.freeze([
  Object.freeze({
    category: "credentials",
    reason: "Authentication, App Check, recovery-code and operation credentials are never exported.",
  }),
  Object.freeze({
    category: "encryptionKeys",
    reason: "Encryption, pseudonymization and internal bucket keys are security material.",
  }),
  Object.freeze({
    category: "otherUsersData",
    reason: "Data belonging to other accounts and unlinked anonymous reports is outside this account export.",
  }),
  Object.freeze({
    category: "productContent",
    reason: "Question banks and other product content are not personal data supplied by this account.",
  }),
  Object.freeze({
    category: "internalSecurityData",
    reason: "Internal security controls are omitted where disclosure could weaken account security.",
  }),
  Object.freeze({
    category: "syncJournals",
    reason: "Raw sync journals, internal operations, mutation logs, bucket identifiers and non-user-facing technical data are omitted.",
  }),
] as const);

export type DataExportStatus = "started" | "completed" | "rate_limited" | "too_large" | "failed";

export type DataExportProfile = Readonly<{
  createdAt: string;
  identity: Readonly<{
    provider: string;
    email: string | null;
    emailVerified: boolean;
  }>;
}>;

export type DataExportProgressRecord = Readonly<{
  kind: "node" | "item";
  recordType: string;
  trackId: string;
  targetId: string;
  version: number;
  fingerprint: string;
  state: Readonly<Record<string, unknown>>;
  lastMutationId: string;
  updatedAt: string;
}>;

export type DataExportContentReport = Readonly<{
  id: string;
  clientSubmissionId: string;
  trackId: string;
  contentVersion: string;
  itemId: string;
  reason: string;
  description: string;
  context: Readonly<Record<string, unknown>>;
  linkage: "account" | "account_and_contact";
  status: string;
  createdAt: string;
  updatedAt: string;
}>;

export type DataExportDocument = Readonly<{
  schemaVersion: typeof DATA_EXPORT_SCHEMA_VERSION;
  exportId: string;
  exportedAt: string;
  scope: Readonly<{
    portable: "user_data_and_activity";
    accountContext: "user_visible_account_context";
  }>;
  article15Information: Readonly<{
    purposes: readonly string[];
    dataCategories: readonly string[];
    recipientCategories: readonly string[];
    retentionCriteria: readonly string[];
    dataSources: readonly string[];
    internationalTransfers: string;
    automatedDecisionMaking: string;
    rightsAndComplaint: string;
  }>;
  portable: Readonly<{
    profile: DataExportProfile;
    progress: readonly DataExportProgressRecord[];
    linkedContentReports: readonly DataExportContentReport[];
  }>;
  accountContext: Readonly<{
    trackAccess: readonly Readonly<Record<string, unknown>>[];
    entitlements: readonly Readonly<Record<string, unknown>>[];
    legalAcceptances: readonly Readonly<Record<string, unknown>>[];
    purchaseConfirmations: readonly Readonly<Record<string, unknown>>[];
    consumerCases: readonly Readonly<Record<string, unknown>>[];
    devices: readonly Readonly<Record<string, unknown>>[];
    syncMetadata: Readonly<Record<string, unknown>>;
    exportHistory: readonly Readonly<Record<string, unknown>>[];
  }>;
  manifest: Readonly<{
    included: readonly string[];
    omitted: readonly Readonly<{ category: string; reason: string }>[];
  }>;
}>;

export type DataExportResult = Readonly<{
  exportId: string;
  serialized: string;
  serializedBytes: number;
}>;

export type DataExportOptions = Readonly<{
  rateLimitMax: number;
  rateLimitWindowSeconds: number;
  maxSerializedBytes: number;
}>;

export class DataExportRateLimitError extends Error {
  public readonly code = "data_export_rate_limited" as const;

  public constructor(public readonly retryAfterSeconds: number) {
    super("data_export_rate_limited");
    this.name = "DataExportRateLimitError";
  }
}

export class DataExportTooLargeError extends Error {
  public readonly code = "data_export_too_large" as const;

  public constructor(public readonly serializedBytes: number, public readonly maxSerializedBytes: number) {
    super("data_export_too_large");
    this.name = "DataExportTooLargeError";
  }
}

export interface DataExportStore {
  create(userId: string, stableExportId?: string, onCompleted?: (result: DataExportResult) => Promise<void>): Promise<DataExportResult>;
}
