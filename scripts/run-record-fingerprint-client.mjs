import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.exitCode = await runIsolatedEmulatorTests({
  backendRoot,
  projectId: "demo-patternly-record-fingerprint",
  command: "node --import tsx --test scripts/qa/record-fingerprint-client.test.mjs",
});
