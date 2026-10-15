import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.exitCode = await runIsolatedEmulatorTests({
  backendRoot, projectId: "demo-patternly-premium",
  command: "node --import tsx --test --test-concurrency=1 tests/revenuecatWebhook.emulator.test.ts tests/purchaseReceiptDelivery.emulator.test.ts tests/revenuecatEntitlements.emulator.test.ts tests/dataExport.test.ts tests/retentionPurge.emulator.test.ts && node --import tsx --test --test-concurrency=1 --test-name-pattern='purchase confirmation|legal acceptance and purchase confirmation|account deletion removes owned Firestore' tests/firestore.emulator.test.ts",
});
