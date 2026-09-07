import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const configPath = resolve(process.cwd(), "config/firestore-ttl.json");
const expectedPolicies = [
  { collectionGroup: "accountDataExportAudits", fieldPath: "expiresAt" },
  { collectionGroup: "accountDataExportRateLimits", fieldPath: "expiresAt" },
  { collectionGroup: "privacyRequests", fieldPath: "expiresAt" },
  { collectionGroup: "privacyRequestSecrets", fieldPath: "expiresAt" },
  { collectionGroup: "privacyResponseArtifacts", fieldPath: "expiresAt" },
  { collectionGroup: "privacyResponseChunks", fieldPath: "expiresAt" },
  { collectionGroup: "privacyRequestRateLimits", fieldPath: "expiresAt" },
  { collectionGroup: "securityIncidents", fieldPath: "expiresAt" },
  { collectionGroup: "legalRequests", fieldPath: "expiresAt" },
  { collectionGroup: "legalRequestRateLimits", fieldPath: "expiresAt" },
  { collectionGroup: "securityIncidentSecrets", fieldPath: "expiresAt" },
  { collectionGroup: "securityIncidentArtifacts", fieldPath: "expiresAt" },
  { collectionGroup: "securityIncidentDeliveries", fieldPath: "expiresAt" },
  { collectionGroup: "securityIncidentDeliveryKeys", fieldPath: "expiresAt" },
  { collectionGroup: "securityIncidentReminders", fieldPath: "expiresAt" },
  { collectionGroup: "syncOperations", fieldPath: "expiresAt" },
  { collectionGroup: "syncMutations", fieldPath: "expiresAt" },
  { collectionGroup: "contentReports", fieldPath: "expiresAt" },
  { collectionGroup: "deletionProofs", fieldPath: "expiresAt" },
  { collectionGroup: "accountDeletionOperations", fieldPath: "expiresAt" },
  { collectionGroup: "deletedIdentities", fieldPath: "expiresAt" },
  { collectionGroup: "audit", fieldPath: "expiresAt" },
];

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  throw new Error(`cannot read ${configPath}: ${error instanceof Error ? error.message : "invalid JSON"}`);
}

if (config?.database !== "(default)" || !Array.isArray(config?.policies)) throw new Error("Firestore TTL config must declare the default database and policies");
const policies = config.policies;
if (JSON.stringify(policies) !== JSON.stringify(expectedPolicies)) throw new Error("Firestore TTL config must contain exactly the approved expiresAt policies");

process.stdout.write(`Firestore TTL config OK (${policies.length} policies)\n`);
