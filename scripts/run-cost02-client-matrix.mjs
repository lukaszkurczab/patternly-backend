import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontendRoot = resolve(process.env.PATTERNLY_FRONTEND_ROOT ?? resolve(backendRoot, "../patternly"));
if (!process.env.PATTERNLY_FRONTEND_EXPECTED_SHA) throw new Error("cost02_frontend_pin_required");
process.exitCode = await runIsolatedEmulatorTests({
  backendRoot,
  projectId: "demo-patternly-cost02-client",
  command: "node --import tsx scripts/qa/measure-cost02-client-matrix.mjs",
  environment: { PATTERNLY_FRONTEND_ROOT: frontendRoot },
});
