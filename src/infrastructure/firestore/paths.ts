import { createHash } from "node:crypto";
import type { ProgressMutation } from "../../modules/progress/contracts.js";
import { canonicalJson } from "../identity/canonicalJson.js";

export const COLLECTIONS = Object.freeze({
  contentReports: "contentReports",
  contentReportAudit: "audit",
  contentVersions: "contentVersions",
  accountDeletionOperations: "accountDeletionOperations",
  deletionProofs: "deletionProofs",
  deletedIdentities: "deletedIdentities",
  identityMappings: "identityMappings",
  rateLimitBuckets: "rateLimitBuckets",
  recoveryCodeIndex: "recoveryCodeIndex",
  sessionRevocationOperations: "sessionRevocationOperations",
  accountDataExportAudits: "accountDataExportAudits",
  accountDataExportRateLimits: "accountDataExportRateLimits",
  privacyRequests: "privacyRequests",
  privacyRequestSecrets: "privacyRequestSecrets",
  privacyResponseArtifacts: "privacyResponseArtifacts",
  privacyResponseChunks: "privacyResponseChunks",
  privacyRequestRateLimits: "privacyRequestRateLimits",
  privacyRequestAudit: "audit",
  securityIncidents: "securityIncidents",
  securityIncidentSecrets: "securityIncidentSecrets",
  securityIncidentArtifacts: "securityIncidentArtifacts",
  securityIncidentDeliveries: "securityIncidentDeliveries",
  securityIncidentDeliveryKeys: "securityIncidentDeliveryKeys",
  securityIncidentReminders: "securityIncidentReminders",
  users: "users",
  accounts: "accounts",
});

export function identityDocumentId(provider: string, subject: string): string {
  return createHash("sha256").update(`${provider}:${subject}`, "utf8").digest("hex");
}

export function progressDocumentId(mutation: Pick<ProgressMutation, "kind" | "recordType" | "targetId"> & Partial<Pick<ProgressMutation, "trackId">>): string {
  // Include the complete logical identity. The fallback keeps historical
  // callers that only have the pre-v3 shape deterministic while all writes in
  // the progress store pass trackId explicitly.
  const identity = mutation.trackId === undefined
    ? `${mutation.kind}:${mutation.recordType}:${mutation.targetId}`
    : canonicalJson({ kind: mutation.kind, recordType: mutation.recordType, targetId: mutation.targetId, trackId: mutation.trackId });
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

export function contentVersionDocumentId(trackId: string, version: string): string {
  return createHash("sha256").update(`${trackId}:${version}`, "utf8").digest("hex");
}

export function deviceDocumentId(deviceKey: string): string {
  return createHash("sha256").update(deviceKey, "utf8").digest("hex");
}

/** Stable Firestore ids for protocol-v3 adoption children. */
export function adoptionTransferRecordDocumentId(record: Readonly<{ recordType: string; recordId: string; trackId: string }>): string {
  return createHash("sha256").update(canonicalJson({ recordType: record.recordType, recordId: record.recordId, trackId: record.trackId }), "utf8").digest("hex");
}

export function adoptionTransferChunkDocumentId(chunkId: string): string {
  return createHash("sha256").update(chunkId, "utf8").digest("hex");
}

export function adoptionTransferDecisionDocumentId(decisionFingerprint: string): string {
  return createHash("sha256").update(decisionFingerprint, "utf8").digest("hex");
}

/** Stable account-scoped index for protocol-v3 start idempotency keys. */
export function adoptionTransferIdempotencyDocumentId(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
}
