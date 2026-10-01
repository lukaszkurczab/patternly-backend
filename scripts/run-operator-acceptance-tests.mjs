import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";

process.exitCode = await runIsolatedEmulatorTests({
  backendRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  projectId: "demo-patternly-ops-b4",
  command: "node --import tsx --test --test-concurrency=1 tests/opsAcceptance.emulator.test.ts",
  environment: { OPS_B4_EMULATOR_TESTS: "1" },
});
