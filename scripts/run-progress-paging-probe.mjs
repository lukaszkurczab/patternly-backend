import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.exitCode = await runIsolatedEmulatorTests({ backendRoot, projectId: "demo-patternly-perf05-probe", command: "node --import tsx scripts/qa/probe-progress-paging.ts" });
