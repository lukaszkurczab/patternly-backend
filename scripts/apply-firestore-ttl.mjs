import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const config = JSON.parse(readFileSync(resolve(process.cwd(), "config/firestore-ttl.json"), "utf8"));
const projectArgumentIndex = process.argv.indexOf("--project");
const projectId = projectArgumentIndex >= 0 ? process.argv[projectArgumentIndex + 1] : process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? process.env.PROJECT_ID;
if (!projectId) throw new Error("Provide --project <gcp-project-id> or FIREBASE_PROJECT_ID");
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
  { collectionGroup: "syncBatches", fieldPath: "expiresAt" },
  { collectionGroup: "adoptionTransfers", fieldPath: "expiresAt" },
  { collectionGroup: "adoptionTransferIdempotency", fieldPath: "expiresAt" },
  { collectionGroup: "records", fieldPath: "expiresAt" },
  { collectionGroup: "chunks", fieldPath: "expiresAt" },
  { collectionGroup: "decisions", fieldPath: "expiresAt" },
  { collectionGroup: "results", fieldPath: "expiresAt" },
  { collectionGroup: "markers", fieldPath: "expiresAt" },
  { collectionGroup: "progressGenerations", fieldPath: "expiresAt" },
  { collectionGroup: "contentReports", fieldPath: "expiresAt" },
  { collectionGroup: "deletionProofs", fieldPath: "expiresAt" },
  { collectionGroup: "accountDeletionOperations", fieldPath: "expiresAt" },
  { collectionGroup: "deletedIdentities", fieldPath: "expiresAt" },
  { collectionGroup: "audit", fieldPath: "expiresAt" },
];
if (config?.database !== "(default)" || !Array.isArray(config?.policies) || JSON.stringify(config.policies) !== JSON.stringify(expectedPolicies)) throw new Error("Firestore TTL config is invalid");

const gcloud = process.env.GCLOUD_BIN ?? "gcloud";
for (const policy of config.policies) {
  const result = spawnSync(gcloud, [
    "firestore",
    "fields",
    "ttls",
    "update",
    policy.fieldPath,
    `--collection-group=${policy.collectionGroup}`,
    `--database=${config.database}`,
    "--enable-ttl",
    `--project=${projectId}`,
    "--quiet",
  ], { stdio: "inherit" });
  if (result.error) throw new Error(`unable to run ${gcloud}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`TTL update failed for ${policy.collectionGroup}`);
}

process.stdout.write(`Firestore TTL policies applied to ${projectId}\n`);
