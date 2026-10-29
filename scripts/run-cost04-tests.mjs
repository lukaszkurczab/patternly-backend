import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { validateIsolatedEmulatorRuntime } from "./isolated-emulator-test-runner.mjs";
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontendRoot = resolve(process.env.PATTERNLY_FRONTEND_ROOT ?? resolve(backendRoot, "../patternly"));
const expected = process.env.PATTERNLY_FRONTEND_EXPECTED_SHA;
if (!/^[a-f0-9]{40}$/u.test(expected ?? "") || execFileSync("git", ["-C", frontendRoot, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 }).trim() !== expected) throw new Error("cost04_frontend_pin_mismatch");
// The remaining test uses only real APP fetch against its own IPv4 loopback server.
// Retain the demo runtime guard without starting unused Auth/Firestore emulators.
const environment = {
  ...process.env, PATTERNLY_FRONTEND_ROOT: frontendRoot,
  PATTERNLY_ISOLATED_TEST_PORT_BASE: "", FIREBASE_PROJECT_ID: "demo-patternly-cost04",
  GOOGLE_CLOUD_PROJECT: "demo-patternly-cost04", GCLOUD_PROJECT: "demo-patternly-cost04",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:19119", FIRESTORE_EMULATOR_HOST: "127.0.0.1:18119",
};
validateIsolatedEmulatorRuntime(environment, "demo-patternly-cost04");
const result = spawnSync(process.execPath, [
  "--import", "tsx", "--experimental-test-isolation=none", "--test", "--test-concurrency=1", "--test-timeout=15000",
  "tests/cost04Local.emulator.test.mjs",
], {
  cwd: backendRoot, env: environment, stdio: "inherit", timeout: 20_000, killSignal: "SIGKILL",
});
// With isolation=none the test and its server live in this single watched child.
// SIGKILL also releases the listener if a stalled test cannot reach its finally.
if (result.error || result.signal) console.error(result.error?.code === "ETIMEDOUT" ? "cost04_deadline_exceeded" : "cost04_test_process_failed");
process.exitCode = result.error?.code === "ETIMEDOUT" ? 124 : result.status ?? 1;
