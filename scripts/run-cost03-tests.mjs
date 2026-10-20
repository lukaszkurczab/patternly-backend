import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!/^[a-f0-9]{40}$/u.test(process.env.PATTERNLY_FRONTEND_EXPECTED_SHA ?? "")) throw new Error("cost03_frontend_pin_required");
process.exitCode = await runIsolatedEmulatorTests({
  backendRoot, projectId: "demo-patternly-cost03",
  command: "node --import tsx --test --test-concurrency=1 tests/progressPaging.emulator.test.ts tests/progressStorage.emulator.test.ts tests/appObservability.test.ts tests/cost03Client.emulator.test.mjs",
  environment: { PATTERNLY_FRONTEND_ROOT: resolve(process.env.PATTERNLY_FRONTEND_ROOT ?? resolve(backendRoot, "../patternly")) },
});
