import { resolve } from "node:path";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";

const related = process.argv.length === 3 && process.argv[2] === "--related";
if (process.argv.length !== 2 && !related) throw new Error("arguments_rejected");
const PROJECT_ID = related ? "demo-patternly-rc-regression" : "demo-patternly-rc-customer-deletion";
const backendRoot = resolve(import.meta.dirname, "..");
const exitCode = await runIsolatedEmulatorTests({
  backendRoot,
  projectId: PROJECT_ID,
  command: related
    ? "node --import tsx --test --test-concurrency=1 tests/firestore.emulator.test.ts tests/revenuecatClient.test.ts tests/revenuecatSafetyRegression.test.ts tests/recoveryRouteGuards.test.ts"
    : "node --import tsx --test --test-concurrency=1 tests/rcCustomerDeletion.emulator.ts",
  environment: {
    RC_CUSTOMER_DELETION_EMULATOR_TESTS: "1",
    FIREBASE_PROJECT_ID: PROJECT_ID,
    GOOGLE_CLOUD_PROJECT: PROJECT_ID,
    GCLOUD_PROJECT: PROJECT_ID,
    GOOGLE_APPLICATION_CREDENTIALS: "",
    GOOGLE_APPLICATION_CREDENTIALS_JSON: "",
  },
});
process.exitCode = exitCode;
