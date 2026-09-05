import { randomUUID } from "node:crypto";
import { getAuth } from "firebase-admin/auth";
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
  PUBLIC_DELETION_ORIGIN: "http://127.0.0.1:4173",
  REPORT_RATE_LIMIT_HASH_SECRET: "test-only-report-rate-limit-secret-0123456789",
  REPORT_RATE_LIMIT_MAX: "2",
  REPORT_RATE_LIMIT_WINDOW_SECONDS: "3600",
});

export type EmulatorContext = Readonly<{
  app: ReturnType<typeof buildApplication>;
  stores: BackendStores;
  close: () => Promise<void>;
  deletionLinks: readonly Readonly<{ recipient: string; requestId: string; token: string; link: string }>[];
  customTokenSubjects: readonly string[];
  revokedSubjects: readonly string[];
  deletedSubjects: readonly string[];
}>;

export function createEmulatorContext(): EmulatorContext {
  const runtime = createFirestoreRuntime(testEnvironment);
  const deletionLinks: Array<Readonly<{ recipient: string; requestId: string; token: string; link: string }>> = [];
  const customTokenSubjects: string[] = [];
  const revokedSubjects: string[] = [];
  const deletedSubjects: string[] = [];
  const stores = createFirestoreStores(runtime, testEnvironment, {
    createCustomToken: async (subject) => { customTokenSubjects.push(subject); return "fixture-custom-token"; },
    revokeRefreshTokens: async (subject) => { revokedSubjects.push(subject); },
    deleteUser: async (subject) => {
      deletedSubjects.push(subject);
      try {
        await getAuth().deleteUser(subject);
      } catch (error: unknown) {
        const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
        if (code !== "auth/user-not-found" && code !== "user-not-found") throw error;
      }
    },
  });
  const app = buildApplication({
    environment: testEnvironment,
    firestore: runtime,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: createFirebaseAppCheckVerifier(testEnvironment),
    stores,
    deletionEmailSender: { send: async (input) => { deletionLinks.push(input); } },
  });
  return Object.freeze({ app, stores, deletionLinks, customTokenSubjects, revokedSubjects, deletedSubjects, close: async () => { await app.close(); await runtime.close(); } });
}

export async function clearFirestore(): Promise<void> {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error(`firestore_clear_failed:${response.status}`);
}

const emulatorPassword = "Patternly-test-123!";

export async function createAuthUser(email = `emulator-${randomUUID()}@example.com`): Promise<Readonly<{ email: string; idToken: string; localId: string }>> {
  const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=patternly-emulator`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: emulatorPassword, returnSecureToken: true }),
  });
  if (!response.ok) throw new Error(`auth_emulator_signup_failed:${response.status}:${await response.text()}`);
  const payload = await response.json() as { email: string; idToken: string; localId: string };
  if (!payload.email || !payload.idToken || !payload.localId) throw new Error("auth_emulator_signup_invalid");
  return Object.freeze(payload);
}

export async function createVerifiedAuthUser(email = `emulator-${randomUUID()}@example.com`): Promise<Readonly<{ email: string; idToken: string; localId: string }>> {
  const user = await createAuthUser(email);
  return verifyAuthUser(user);
}

export async function verifyAuthUser(user: Readonly<{ email: string; idToken: string; localId: string }>): Promise<Readonly<{ email: string; idToken: string; localId: string }>> {
  await getAuth().updateUser(user.localId, { emailVerified: true });
  const signIn = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=patternly-emulator`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: emulatorPassword, returnSecureToken: true }),
  });
  if (!signIn.ok) throw new Error(`auth_emulator_signin_failed:${signIn.status}:${await signIn.text()}`);
  const refreshed = await signIn.json() as { email: string; idToken: string; localId: string };
  if (!refreshed.email || !refreshed.idToken || !refreshed.localId) throw new Error("auth_emulator_signin_invalid");
  return Object.freeze(refreshed);
}

export function firestore() {
  return getFirestore();
}
