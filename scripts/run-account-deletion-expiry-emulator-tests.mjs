import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";

if (process.argv.length !== 2) throw Error("arguments_rejected");
process.exitCode = await runIsolatedEmulatorTests({
  backendRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  projectId: "demo-patternly-deletion-expiry",
  command: "node --import tsx --test --test-concurrency=1 --test-name-pattern='live deletion retry uses its original checkpoint after tombstone TTL removal' tests/firestore.emulator.test.ts",
});
