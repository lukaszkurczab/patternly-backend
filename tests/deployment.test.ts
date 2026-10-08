import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("TTL publication uses every approved policy and stops after a failed cloud operation", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "patternly-ttl-deploy-"));
  try {
    const fakeCloud = resolve(directory, "gcloud");
    const calls = resolve(directory, "calls.jsonl");
    await writeFile(fakeCloud, `#!/usr/bin/env node\nconst fs = require("node:fs"); const args = process.argv.slice(2); fs.appendFileSync(process.env.TTL_TEST_CALLS, JSON.stringify(args) + "\\n"); if (process.env.TTL_TEST_FAIL === "true") process.exit(1);\n`, { mode: 0o700 });
    const script = resolve(process.cwd(), "scripts/apply-firestore-ttl.mjs");
    const env = { ...process.env, GCLOUD_BIN: fakeCloud, TTL_TEST_CALLS: calls };
    const applied = spawnSync(process.execPath, [script, "--project", "demo-patternly-ttl"], { env, encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stderr);
    const invocations = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const config = JSON.parse(await readFile(resolve(process.cwd(), "config/firestore-ttl.json"), "utf8")) as { policies: { collectionGroup: string }[] };
    assert.deepEqual(invocations.map((args) => args.find((arg) => arg.startsWith("--collection-group="))), config.policies.map((policy) => `--collection-group=${policy.collectionGroup}`));
    assert.equal(invocations.every((args) => args.includes("--project=demo-patternly-ttl") && args.includes("--enable-ttl")), true);
    await writeFile(calls, "");
    const failed = spawnSync(process.execPath, [script, "--project", "demo-patternly-ttl"], { env: { ...env, TTL_TEST_FAIL: "true" }, encoding: "utf8" });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /TTL update failed for accountDataExportAudits/u);
    assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
    { collectionGroup: "accountRecoveryOperations", fieldPath: "expiresAt" },
    { collectionGroup: "accountRecoveryOperationResults", fieldPath: "expiresAt" },
    { collectionGroup: "rateLimitBuckets", fieldPath: "expiresAt" },
    { collectionGroup: "deletedIdentities", fieldPath: "expiresAt" },
    { collectionGroup: "audit", fieldPath: "expiresAt" },
  ]);
  assert.equal(ttl.policies.length, 34);
  const indexes = JSON.parse(await readFile(resolve(process.cwd(), "firestore.indexes.json"), "utf8")) as { indexes?: readonly { collectionGroup?: unknown; queryScope?: unknown; fields?: readonly { fieldPath?: unknown; order?: unknown }[] }[] };
  assert.equal(indexes.indexes?.every((index) => (index.fields?.length ?? 0) >= 2), true, "Single-field indexes belong in fieldOverrides; Firestore rejects them as composite indexes");
  assert.equal(indexes.indexes?.some((index) => index.collectionGroup === "accountDataExportAudits" && index.queryScope === "COLLECTION" && index.fields?.[0]?.fieldPath === "userId" && index.fields?.[0]?.order === "ASCENDING" && index.fields?.[1]?.fieldPath === "createdAt" && index.fields?.[1]?.order === "DESCENDING"), true);
  assert.equal(indexes.indexes?.some((index) => index.collectionGroup === "accountRecoveryOperations" && index.queryScope === "COLLECTION" && index.fields?.map((field) => field.fieldPath).join(",") === "userId,kind,generationId"), true, "Orphaned recovery-code generations resolve their exact reissue operation before replacement");
  const packageJson = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
  assert.match(String(packageJson.scripts?.["firestore:ttl:check"] ?? ""), /check-firestore-ttl\.mjs/u);
  assert.match(String(packageJson.scripts?.["firestore:ttl:apply"] ?? ""), /apply-firestore-ttl\.mjs/u);
  assert.match(String(packageJson.scripts?.["retention:purge"] ?? ""), /retention-purge\.ts/u);
  assert.match(String(packageJson.scripts?.ci ?? ""), /firestore:ttl:check/u);
  assert.match(String(packageJson.scripts?.["ci:cloud"] ?? ""), /firestore:ttl:check/u);
});
