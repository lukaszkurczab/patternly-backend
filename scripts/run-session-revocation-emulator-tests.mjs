import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.exitCode = await runIsolatedEmulatorTests({
  backendRoot,
  projectId: "demo-patternly-sec07",
  command: 'node --import tsx --test --test-concurrency=1 --test-name-pattern="SEC-07|session revocation|session revoke|same-operation replay|deletion|account-owned writers" tests/firestore.emulator.test.ts tests/sec07SessionRevocation.emulator.test.ts',
});
