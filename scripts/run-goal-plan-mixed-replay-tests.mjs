import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.exitCode = await runIsolatedEmulatorTests({ backendRoot, projectId: "demo-patternly-mixed-replay",
  command: "node --import tsx --test --test-concurrency=1 tests/goalPlanMixedReplay.emulator.test.ts tests/progressStorage.emulator.test.ts tests/syncMutationReceipts.emulator.test.ts tests/progressContracts.test.ts",
});
