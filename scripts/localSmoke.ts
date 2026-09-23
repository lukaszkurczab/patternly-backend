import { timingSafeEqual } from "node:crypto";
import { loadEnvironment } from "../src/config/environment.js";

export const smokeEndpoints = Object.freeze({
  project: "patternly-app-sandbox", auth: "127.0.0.1:19099", firestore: "127.0.0.1:18081", port: 8080,
});
export type SmokeSecrets = { appCheckToken: string; storageKey: string; hmacKey: string };

export function smokeEnvironment(source: NodeJS.ProcessEnv, secrets: SmokeSecrets) {
  if (source.NODE_ENV === "production") throw new Error("local_smoke_forbidden_in_production");
  if (source.FIREBASE_AUTH_EMULATOR_HOST !== smokeEndpoints.auth
    || source.FIRESTORE_EMULATOR_HOST !== smokeEndpoints.firestore
    || source.FIREBASE_PROJECT_ID !== smokeEndpoints.project) throw new Error("local_smoke_emulator_configuration_required");
  if (Object.values(secrets).some((value) => !/^[a-f0-9]{64}$/.test(value))
    || !secrets.appCheckToken || !secrets.storageKey || !secrets.hmacKey) throw new Error("invalid_local_smoke_keys");
  // Allowlist: never inherit SMTP, RevenueCat, remote catalogs or admin credentials.
  return loadEnvironment({
    NODE_ENV: "development", HOST: "127.0.0.1", PORT: String(smokeEndpoints.port),
    FIREBASE_PROJECT_ID: smokeEndpoints.project,
    FIREBASE_AUTH_ISSUER: `https://securetoken.google.com/${smokeEndpoints.project}`,
    FIREBASE_AUTH_EMULATOR_HOST: smokeEndpoints.auth, FIRESTORE_EMULATOR_HOST: smokeEndpoints.firestore,
    REPORT_RATE_LIMIT_HASH_SECRET: secrets.hmacKey, PRIVACY_AUDIT_HMAC_SECRET: secrets.hmacKey,
    PRIVACY_RESPONSE_KEY_BASE64: Buffer.from(secrets.storageKey, "hex").toString("base64"),
    DELETION_PSEUDONYM_KEYS_JSON: JSON.stringify([{ version: "local-v1", status: "active", keyBase64: Buffer.from(secrets.storageKey, "hex").toString("base64") }]),
  });
}

/** Test fixture only; imported by dev:smoke, never by src/index.ts. */
export function localAppCheckVerifier(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid_local_smoke_token");
  const expected = Buffer.from(token);
  return { async verify(value: string): Promise<void> {
    const supplied = Buffer.from(value);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("app_check_invalid");
  } };
}
