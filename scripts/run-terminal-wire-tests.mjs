import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.exitCode = await runIsolatedEmulatorTests({
  backendRoot, projectId: "demo-patternly-terminal-wire",
  command: "node --import tsx --test --test-concurrency=1 scripts/qa/terminal-wire-client.test.mjs tests/dataExport.test.ts tests/progressContracts.test.ts tests/merge.test.ts tests/adoptionTransfer.test.ts tests/syncMutationReceipts.emulator.test.ts tests/progressStorage.emulator.test.ts",
});
