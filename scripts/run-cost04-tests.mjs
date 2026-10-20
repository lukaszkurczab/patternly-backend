import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontendRoot = resolve(process.env.PATTERNLY_FRONTEND_ROOT ?? resolve(backendRoot, "../patternly"));
const expected = process.env.PATTERNLY_FRONTEND_EXPECTED_SHA;
if (!/^[a-f0-9]{40}$/u.test(expected ?? "") || execFileSync("git", ["-C", frontendRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== expected) throw new Error("cost04_frontend_pin_mismatch");
process.exitCode = await runIsolatedEmulatorTests({ backendRoot, projectId: "demo-patternly-cost04", timeoutMs: 180_000,
  command: "node --import tsx --test --test-concurrency=1 tests/cost04Local.emulator.test.mjs",
  environment: { PATTERNLY_FRONTEND_ROOT: frontendRoot },
});
