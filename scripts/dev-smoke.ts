import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { buildApplication } from "../src/api/app.js";
import { createFirestoreRuntime } from "../src/infrastructure/firestore/client.js";
import { createFirestoreStores } from "../src/infrastructure/firestore/stores.js";
import { createFirebaseTokenVerifier } from "../src/infrastructure/firebase/verifier.js";
import { localAppCheckVerifier, smokeEndpoints, smokeEnvironment, type SmokeSecrets } from "./localSmoke.js";

const directory = new URL("../.local/smoke/", import.meta.url);
await mkdir(directory, { recursive: true, mode: 0o700 });
const path = new URL("secrets.json", directory);
let secrets: SmokeSecrets;
try { secrets = JSON.parse(await readFile(path, "utf8")) as SmokeSecrets; }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  secrets = { appCheckToken: randomBytes(32).toString("hex"), storageKey: randomBytes(32).toString("hex"), hmacKey: randomBytes(32).toString("hex") };
  await writeFile(path, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
}
await chmod(path, 0o600);
const environment = smokeEnvironment(process.env, secrets);
for (const host of [smokeEndpoints.auth, smokeEndpoints.firestore]) {
  await fetch(`http://${host}/`, { signal: AbortSignal.timeout(3000) });
}
const firestore = createFirestoreRuntime(environment);
const app = buildApplication({ environment, firestore, stores: createFirestoreStores(firestore, environment),
  verifier: createFirebaseTokenVerifier(environment), appCheckVerifier: localAppCheckVerifier(secrets.appCheckToken) });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  void app.close().then(() => firestore.close());
});
console.info("Local smoke API: emulator identity + local test App Check (not provider attestation); SMTP and RevenueCat disabled.");
await app.listen({ host: environment.host, port: environment.port });
