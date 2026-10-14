import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedEmulatorTests } from "./isolated-emulator-test-runner.mjs";
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.exitCode = await runIsolatedEmulatorTests({
  backendRoot, projectId: "demo-patternly-receipts",
  command: "node --import tsx --test --test-concurrency=1 tests/purchaseReceiptDelivery.emulator.test.ts tests/revenuecatWebhook.emulator.test.ts tests/revenuecatWebhook.test.ts tests/smtpPrivacyEmailSender.test.ts tests/purchaseReceiptSmtp.test.ts",
});
