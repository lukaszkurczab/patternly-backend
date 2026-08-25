import { buildApplication } from "./api/app.js";
import { loadEnvironment } from "./config/environment.js";
import { createFirestoreRuntime } from "./infrastructure/firestore/client.js";
import { createFirestoreStores } from "./infrastructure/firestore/stores.js";
import { createFirebaseAppCheckVerifier } from "./infrastructure/firebase/appCheckVerifier.js";
import { createFirebaseTokenVerifier } from "./infrastructure/firebase/verifier.js";

const environment = loadEnvironment(process.env);
const firestore = createFirestoreRuntime(environment);
const app = buildApplication({
  environment,
  firestore,
  verifier: createFirebaseTokenVerifier(environment),
  appCheckVerifier: createFirebaseAppCheckVerifier(environment),
  stores: createFirestoreStores(firestore, environment),
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "shutting_down");
  await app.close();
  await firestore.close();
};

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void shutdown(signal); });

try {
  await app.listen({ host: environment.host, port: environment.port });
} catch (error) {
  app.log.error({ err: error }, "startup_failed");
  await firestore.close();
  process.exitCode = 1;
}
