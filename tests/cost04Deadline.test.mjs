import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runIsolatedEmulatorTests } from "../scripts/isolated-emulator-test-runner.mjs";
import { execFileSync, spawnSync } from "node:child_process";

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

test("COST04 rejects a wrong APP pin before starting its test or HTTP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cost04-pin-"));
  const observer = join(directory, "observe.mjs");
  const marker = join(directory, "http-started");
  try {
    // Observe the real entry point, rather than replacing the runner under test.
    await writeFile(observer, `import http from 'node:http';import {syncBuiltinESMExports} from 'node:module';import {writeFileSync} from 'node:fs';
http.createServer=()=>{writeFileSync(${JSON.stringify(marker)},'unexpected');throw new Error('unexpected_http');};syncBuiltinESMExports();
globalThis.fetch=()=>{writeFileSync(${JSON.stringify(marker)},'unexpected');throw new Error('unexpected_fetch');};`);
    const result = spawnSync(process.execPath, ["scripts/run-cost04-tests.mjs"], {
      cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, PATTERNLY_FRONTEND_EXPECTED_SHA: "0".repeat(40), NODE_OPTIONS: `--import=${observer}` },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cost04_frontend_pin_mismatch/u);
    assert.doesNotMatch(result.stdout, /TAP|loopback_http_429/u);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("COST04 entry deadline kills its single test process and releases its listener", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "cost04-entry-deadline-"));
  const fixture = join(directory, "stall.mjs");
  const marker = join(directory, "listener.json");
  const backendRoot = resolve(import.meta.dirname, "..");
  const frontendRoot = resolve(process.env.PATTERNLY_FRONTEND_ROOT ?? resolve(backendRoot, "../patternly"));
  const expected = execFileSync("git", ["-C", frontendRoot, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 }).trim();
  try {
    // Stall module loading in the actual single watched child. No APP or SDK call.
    await writeFile(fixture, `import {createServer} from 'node:net';import {writeFileSync} from 'node:fs';
if(process.execArgv.includes('--experimental-test-isolation=none')){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,port:server.address().port}));await new Promise(()=>{});}`);
    const start = Date.now();
    const result = spawnSync(process.execPath, ["scripts/run-cost04-tests.mjs"], {
      cwd: backendRoot, encoding: "utf8", timeout: 25_000, killSignal: "SIGKILL",
      env: { ...process.env, PATTERNLY_FRONTEND_ROOT: frontendRoot, PATTERNLY_FRONTEND_EXPECTED_SHA: expected, NODE_OPTIONS: `--import=${fixture}` },
    });
    assert.equal(result.error, undefined, "entry point finishes within its own deadline");
    assert.equal(result.status, 124);
    assert.match(result.stderr, /cost04_deadline_exceeded/u);
    assert.ok(Date.now() - start < 25_000);
    const record = JSON.parse(await readFile(marker, "utf8"));
    assert.throws(() => process.kill(record.pid, 0), { code: "ESRCH" });
    const { createConnection } = await import("node:net");
    await new Promise((accept, reject) => {
      const connection = createConnection({ host: "127.0.0.1", port: record.port });
      connection.once("connect", () => { connection.destroy(); reject(new Error("cost04_listener_survived_deadline")); });
      connection.once("error", (error) => error.code === "ECONNREFUSED" ? accept() : reject(error));
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
