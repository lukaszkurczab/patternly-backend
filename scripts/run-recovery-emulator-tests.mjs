import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontendRoot = resolve(process.env.PATTERNLY_FRONTEND_ROOT ?? join(backendRoot, "../patternly"));
const expectedSha = process.env.PATTERNLY_FRONTEND_EXPECTED_SHA;
if (!expectedSha || !/^[a-f0-9]{40}$/u.test(expectedSha)) throw new Error("recovery_gate_frontend_sha_required");
const actualSha = execFileSync("git", ["-C", frontendRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (actualSha !== expectedSha) throw new Error("recovery_gate_frontend_sha_mismatch");
const frontendRequire = createRequire(join(frontendRoot, "package.json"));
frontendRequire.resolve("firebase/app");
frontendRequire.resolve("firebase/auth");
console.log(`Recovery gate: backend=${execFileSync("git", ["rev-parse", "HEAD"], { cwd: backendRoot, encoding: "utf8" }).trim()} mobile=${actualSha}`);
process.exitCode = await runIsolatedEmulatorTests({
  backendRoot,
  projectId: "demo-patternly-aud08-recovery",
  command: "node --import tsx --test --test-concurrency=1 tests/aud08Recovery.emulator.test.ts",
  environment: {
    PATTERNLY_FRONTEND_ROOT: frontendRoot,
    PATTERNLY_FRONTEND_EXPECTED_SHA: expectedSha,
    AUD08_RECOVERY_EMULATOR_TESTS: "1",
  },
});
