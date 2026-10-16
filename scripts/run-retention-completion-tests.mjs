import { fileURLToPath } from "node:url";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";
const backendRoot = fileURLToPath(new URL("..", import.meta.url));
process.exitCode = await runIsolatedEmulatorTests({ backendRoot, projectId: "demo-patternly-ops-b2", environment: { OPS_B2_EMULATOR_TESTS: "1" }, command: "node --import tsx --test --test-concurrency=1 tests/retentionCompletion.emulator.test.ts tests/privacyRequests.test.ts tests/securityIncidents.test.ts tests/legalRequests.emulator.test.ts tests/firestore.emulator.test.ts tests/opsOperator.emulator.test.ts" });
