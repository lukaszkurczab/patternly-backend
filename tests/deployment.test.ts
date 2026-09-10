import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("Cloud Run container contract is immutable-image and non-root", async () => {
  const dockerfile = await readFile(resolve(process.cwd(), "Dockerfile"), "utf8");
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS build/u);
  assert.match(dockerfile, /npm ci --omit=dev/u);
  assert.match(dockerfile, /USER node/u);
  assert.match(dockerfile, /CMD \["node", "dist\/index\.js"\]/u);
  const cloudbuild = await readFile(resolve(process.cwd(), "cloudbuild.yaml"), "utf8");
  assert.match(cloudbuild, /\$\{COMMIT_SHA\}/u);
  assert.match(cloudbuild, /CLOUD_LOGGING_ONLY/u);
});

test("Firestore export retention and history indexes are repository-deployable", async () => {
  const ttl = JSON.parse(await readFile(resolve(process.cwd(), "config/firestore-ttl.json"), "utf8")) as { database?: unknown; policies?: readonly { collectionGroup?: unknown; fieldPath?: unknown }[] };
  assert.equal(ttl.database, "(default)");
  assert.deepEqual(ttl.policies, [
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
  ]);
  assert.equal(ttl.policies.length, 31);
  const indexes = JSON.parse(await readFile(resolve(process.cwd(), "firestore.indexes.json"), "utf8")) as { indexes?: readonly { collectionGroup?: unknown; queryScope?: unknown; fields?: readonly { fieldPath?: unknown; order?: unknown }[] }[] };
  assert.equal(indexes.indexes?.some((index) => index.collectionGroup === "accountDataExportAudits" && index.queryScope === "COLLECTION" && index.fields?.[0]?.fieldPath === "userId" && index.fields?.[0]?.order === "ASCENDING" && index.fields?.[1]?.fieldPath === "createdAt" && index.fields?.[1]?.order === "DESCENDING"), true);
  const packageJson = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
  assert.match(String(packageJson.scripts?.["firestore:ttl:check"] ?? ""), /check-firestore-ttl\.mjs/u);
  assert.match(String(packageJson.scripts?.["firestore:ttl:apply"] ?? ""), /apply-firestore-ttl\.mjs/u);
  assert.match(String(packageJson.scripts?.["retention:purge"] ?? ""), /retention-purge\.ts/u);
  assert.match(String(packageJson.scripts?.ci ?? ""), /firestore:ttl:check/u);
  assert.match(String(packageJson.scripts?.["ci:cloud"] ?? ""), /firestore:ttl:check/u);
});
