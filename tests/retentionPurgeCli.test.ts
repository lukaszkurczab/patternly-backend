import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("retention purge CLI requires an explicit target and emits only structured non-sensitive JSON on failure", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", resolve(process.cwd(), "scripts/retention-purge.ts")], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { error: "retention_purge_failed" });
});

test("retention purge CLI contract keeps dry-run default, explicit execute, target, page and delete-budget arguments", async () => {
  const source = await import("node:fs/promises").then(async ({ readFile }) => readFile(resolve(process.cwd(), "scripts/retention-purge.ts"), "utf8"));
  assert.match(source, /let execute = false/u);
  assert.match(source, /value === "--execute"/u);
  assert.match(source, /value === "--project"/u);
  assert.match(source, /value === "--database"/u);
  assert.match(source, /value === "--page-size"/u);
  assert.match(source, /value === "--max-deletes"/u);
  assert.doesNotMatch(source, /--scope/u);
});
