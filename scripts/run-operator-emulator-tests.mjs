import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";

process.exitCode = await runIsolatedEmulatorTests({
  backendRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  projectId: "demo-patternly-ops-b2",
  command: "node --import tsx --test --test-concurrency=1 tests/opsOperator.emulator.test.ts",
  environment: { OPS_B2_EMULATOR_TESTS: "1" },
});
