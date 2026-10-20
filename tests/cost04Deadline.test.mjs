import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runIsolatedEmulatorTests } from "../scripts/isolated-emulator-test-runner.mjs";

test("bounded runner kills its process group and removes temporary config on deadline", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "cost04-deadline-"));
  const marker = join(directory, "marker.json"); const executable = join(directory, "fixture-cli.mjs");
  const prior = process.env.FIREBASE_CLI;
  try {
    await writeFile(executable, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {stdio:'inherit'});
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({childPid:child.pid, config:process.argv[process.argv.indexOf('--config')+1]}));
setInterval(()=>{},1000);
`);
    await chmod(executable, 0o700); process.env.FIREBASE_CLI = executable;
    const result = await runIsolatedEmulatorTests({ backendRoot: resolve(import.meta.dirname, ".."), projectId: "demo-patternly-cost04", command: "unused", timeoutMs: 3_000 });
    assert.equal(result, 124);
    const record = JSON.parse(await readFile(marker, "utf8"));
    await assert.rejects(access(record.config), { code: "ENOENT" });
    // Allow the OS to reap the child after group SIGKILL.
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try { process.kill(record.childPid, 0); await new Promise((accept) => setTimeout(accept, 50)); }
      catch (error) { assert.equal(error.code, "ESRCH"); alive = false; }
    }
    assert.equal(alive, false, "emulator-like child cannot outlive deadline");
  } finally {
    if (prior === undefined) delete process.env.FIREBASE_CLI; else process.env.FIREBASE_CLI = prior;
    await rm(directory, { recursive: true, force: true });
  }
});
