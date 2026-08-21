import { buildApplication } from "./api/app.js";
import { loadEnvironment } from "./config/environment.js";
import { createDatabase } from "./infrastructure/database/client.js";
import { createFirebaseTokenVerifier } from "./infrastructure/firebase/verifier.js";
import { createStores } from "./infrastructure/database/stores.js";

const environment = loadEnvironment(process.env);
const database = createDatabase(environment);
const app = buildApplication({
  environment,
  database,
  verifier: createFirebaseTokenVerifier(environment),
  stores: database ? createStores(database) : null,
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "shutting_down");
  await app.close();
  await database?.close();
};

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void shutdown(signal); });

try {
  await app.listen({ host: environment.host, port: environment.port });
} catch (error) {
  app.log.error({ err: error }, "startup_failed");
  await database?.close();
  process.exitCode = 1;
}
