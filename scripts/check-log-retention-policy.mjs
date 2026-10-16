import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const policy = JSON.parse(await readFile(new URL("../config/log-retention-policy.json", import.meta.url), "utf8"));
assert.equal(policy.schemaVersion, 1);
assert.equal(policy.status, "desired_unapplied");
assert.deepEqual(policy.buckets.map(({ id, retentionDays }) => [id, retentionDays]), [["_Default", 30], ["patternly-security", 90]]);
assert.equal(new Set(policy.buckets.map(({ id }) => id)).size, policy.buckets.length);
for (const bucket of policy.buckets) assert.ok(typeof bucket.purpose === "string" && bucket.purpose.length > 0);
console.log("Desired Cloud Logging retention policy is internally consistent; no cloud settings were read or changed.");
