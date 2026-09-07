import { createHash } from "node:crypto";
import type { ProgressMutation } from "../../modules/progress/contracts.js";

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
});

export function identityDocumentId(provider: string, subject: string): string {
  return createHash("sha256").update(`${provider}:${subject}`, "utf8").digest("hex");
}

export function progressDocumentId(mutation: Pick<ProgressMutation, "kind" | "recordType" | "targetId">): string {
  return createHash("sha256").update(`${mutation.kind}:${mutation.recordType}:${mutation.targetId}`, "utf8").digest("hex");
}

export function contentVersionDocumentId(trackId: string, version: string): string {
  return createHash("sha256").update(`${trackId}:${version}`, "utf8").digest("hex");
}

export function deviceDocumentId(deviceKey: string): string {
  return createHash("sha256").update(deviceKey, "utf8").digest("hex");
}
