import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("initial migration contains the canonical persistence domains and constraints", async () => {
  const sql = await readFile(resolve(process.cwd(), "migrations/0000_initial.sql"), "utf8");
  for (const table of ["users", "identities", "devices", "subscriptions", "entitlements", "track_access", "node_progress", "item_progress", "sync_mutations", "content_versions"]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"));
  assert.match(sql, /identities_provider_subject_unique/u);
  assert.match(sql, /sync_mutations_user_mutation_unique/u);
  assert.match(sql, /PRIMARY KEY \(user_id, track_id, node_id\)/u);
  assert.match(sql, /PRIMARY KEY \(user_id, track_id, item_id\)/u);
});
