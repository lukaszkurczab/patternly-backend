import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";

const [kind, ...extra] = process.argv.slice(2);
if (extra.length || (kind && !["revoke", "deletion"].includes(kind))) throw Error("arguments_rejected");
process.exitCode = await runIsolatedEmulatorTests({
  backendRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  projectId: "demo-patternly-b4-crash",
  command: `node --import tsx --test --test-concurrency=1 ${kind ? `--test-name-pattern=${kind}` : ""} tests/accountLifecycleCrash.emulator.test.ts`,
  environment: { B4_CRASH_TESTS: "1" },
});
