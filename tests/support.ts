import { randomUUID } from "node:crypto";
import { getFirestore } from "firebase-admin/firestore";
import { buildApplication } from "../src/api/app.js";
import { loadEnvironment, type Environment } from "../src/config/environment.js";
import { createFirebaseAppCheckVerifier } from "../src/infrastructure/firebase/appCheckVerifier.js";
import { createFirestoreRuntime } from "../src/infrastructure/firestore/client.js";
import { createFirestoreStores, type BackendStores } from "../src/infrastructure/firestore/stores.js";
import { createFirebaseTokenVerifier } from "../src/infrastructure/firebase/verifier.js";

const projectId = "patternly-app-sandbox";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (!firestoreHost || !authHost) throw new Error("firebase_emulator_suite_required");

export const testEnvironment: Environment = loadEnvironment({
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "8080",
  LOG_LEVEL: "silent",
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_AUTH_ISSUER: `https://securetoken.google.com/${projectId}`,
  ADMINISTRATOR_EMAIL: "lukasz.kurczab@gmail.com",
  ADMIN_WEB_ORIGIN: "http://127.0.0.1:4173",
  REPORT_RATE_LIMIT_HASH_SECRET: "test-only-report-rate-limit-secret-0123456789",
  REPORT_RATE_LIMIT_MAX: "2",
  REPORT_RATE_LIMIT_WINDOW_SECONDS: "3600",
});

export type EmulatorContext = Readonly<{
  app: ReturnType<typeof buildApplication>;
  stores: BackendStores;
  close: () => Promise<void>;
}>;

export function createEmulatorContext(): EmulatorContext {
  const runtime = createFirestoreRuntime(testEnvironment);
  const stores = createFirestoreStores(runtime, testEnvironment);
  const app = buildApplication({
    environment: testEnvironment,
    firestore: runtime,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: createFirebaseAppCheckVerifier(testEnvironment),
    stores,
  });
  return Object.freeze({ app, stores, close: async () => { await app.close(); await runtime.close(); } });
}

export async function clearFirestore(): Promise<void> {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error(`firestore_clear_failed:${response.status}`);
}

export async function createAuthUser(email = `emulator-${randomUUID()}@example.com`): Promise<Readonly<{ email: string; idToken: string; localId: string }>> {
  const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=patternly-emulator`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Patternly-test-123!", returnSecureToken: true }),
  });
  if (!response.ok) throw new Error(`auth_emulator_signup_failed:${response.status}:${await response.text()}`);
  const payload = await response.json() as { email: string; idToken: string; localId: string };
  if (!payload.email || !payload.idToken || !payload.localId) throw new Error("auth_emulator_signup_invalid");
  return Object.freeze(payload);
}

export function firestore() {
  return getFirestore();
}
