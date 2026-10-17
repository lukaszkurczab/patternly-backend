import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";

// Dedicated disposable demo project: never clears the device's sandbox database.
process.exitCode = await runIsolatedEmulatorTests({
  backendRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  projectId: "demo-patternly-premium-local",
  command: "node --import tsx --test --test-concurrency=1 tests/revenuecatWebhook.emulator.test.ts tests/revenuecatEntitlements.emulator.test.ts tests/purchaseReceiptDelivery.emulator.test.ts tests/premiumDualStore.emulator.test.ts tests/contentPackages.emulator.test.ts && FIREBASE_PROJECT_ID=patternly-app-sandbox GCLOUD_PROJECT=patternly-app-sandbox GOOGLE_CLOUD_PROJECT=patternly-app-sandbox node --import tsx --test tests/sandboxPromotionalPackages.emulator.test.ts",
});
