import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.exitCode = await runIsolatedEmulatorTests({ backendRoot, projectId: "demo-patternly-content19", command: "node --import tsx scripts/qa/serve-content19-native.mjs" });
