import { buildApplication } from "./api/app.js";
import { loadEnvironment } from "./config/environment.js";
import { createFirestoreRuntime } from "./infrastructure/firestore/client.js";
import { createFirestoreStores } from "./infrastructure/firestore/stores.js";
import { createFirebaseAppCheckVerifier } from "./infrastructure/firebase/appCheckVerifier.js";
import { createFirebaseTokenVerifier } from "./infrastructure/firebase/verifier.js";
import { createBootstrapLogger } from "./infrastructure/logging/logger.js";
import { createSmtpLegalRequestEmailSender, createSmtpPrivacyEmailSender, createSmtpPurchaseReceiptEmailSender, createSmtpSecurityIncidentEmailSender } from "./infrastructure/email/smtpPrivacyEmailSender.js";

async function main(): Promise<void> {
  const bootstrapLogger = createBootstrapLogger();
  let firestore: ReturnType<typeof createFirestoreRuntime> | undefined;
  let app: ReturnType<typeof buildApplication> | undefined;
  try {
    const environment = loadEnvironment(process.env);
    firestore = createFirestoreRuntime(environment);
    const privacyRequestEmailSender = environment.smtp ? createSmtpPrivacyEmailSender(environment.smtp) : null;
    const legalRequestEmailSender = environment.smtp ? createSmtpLegalRequestEmailSender(environment.smtp) : null;
    const purchaseReceiptEmailSender = environment.smtp ? createSmtpPurchaseReceiptEmailSender(environment.smtp) : null;
    let securityIncidentEmailSender: import("./modules/security-incidents/store.js").SecurityIncidentEmailSender | null = null;
    if (environment.smtp) {
      try { securityIncidentEmailSender = createSmtpSecurityIncidentEmailSender(environment.smtp); } catch { securityIncidentEmailSender = null; }
    }
    app = buildApplication({
      environment,
      firestore,
      verifier: createFirebaseTokenVerifier(environment),
      appCheckVerifier: createFirebaseAppCheckVerifier(environment),
      stores: createFirestoreStores(firestore, environment),
      privacyRequestEmailSender,
      legalRequestEmailSender,
      purchaseReceiptEmailSender,
      securityIncidentEmailSender,
    });
    const shutdown = async (signal: string): Promise<void> => {
      try {
        app!.log.info({ event: "shutting_down", signal }, "shutting_down");
        await app!.close();
        await firestore!.close();
      } catch {
        bootstrapLogger.error({ event: "shutdown_failed", code: "internal_error" }, "shutdown_failed");
      }
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void shutdown(signal); });
    await app.listen({ host: environment.host, port: environment.port });
  } catch {
    (app?.log ?? bootstrapLogger).error({ event: "bootstrap_failed", code: "internal_error" }, "bootstrap_failed");
    try { await app?.close(); } catch {}
    try { await firestore?.close(); } catch {}
    process.exitCode = 1;
  }
}

void main();
