import { spawnSync } from "node:child_process";

import { config } from "./check-firestore-ttl.mjs";

const projectArgumentIndex = process.argv.indexOf("--project");
const projectId = projectArgumentIndex >= 0 ? process.argv[projectArgumentIndex + 1] : process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? process.env.PROJECT_ID;
if (!projectId) throw new Error("Provide --project <gcp-project-id> or FIREBASE_PROJECT_ID");
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
