import assert from "node:assert/strict";
import test from "node:test";
import { localAppCheckVerifier, smokeEndpoints, smokeEnvironment } from "../scripts/localSmoke.js";
const keys = { appCheckToken: "a".repeat(64), storageKey: "b".repeat(64), hmacKey: "c".repeat(64) };
const source = { FIREBASE_PROJECT_ID: smokeEndpoints.project, FIREBASE_AUTH_EMULATOR_HOST: smokeEndpoints.auth, FIRESTORE_EMULATOR_HOST: smokeEndpoints.firestore };
test("smoke launcher requires existing local emulator configuration and excludes remote integrations", () => {
  const env = smokeEnvironment({ ...source, SMTP_HOST: "remote.invalid", REVENUECAT_READ_API_KEY: "remote", HOST: "0.0.0.0" }, keys);
  assert.equal(env.host, "127.0.0.1"); assert.equal(env.port, 8080);
  assert.equal(env.smtp, null); assert.equal(env.revenueCatReadApiKey, undefined);
  for (const change of [{ NODE_ENV: "production" }, { FIREBASE_PROJECT_ID: "production" }, { FIREBASE_AUTH_EMULATOR_HOST: "remote:19099" }, { FIRESTORE_EMULATOR_HOST: "" }]) {
    assert.throws(() => smokeEnvironment({ ...source, ...change }, keys));
  }
});
test("local App Check fixture rejects missing/wrong tokens and never substitutes user identity", async () => {
  const verifier = localAppCheckVerifier(keys.appCheckToken);
  await verifier.verify(keys.appCheckToken);
  for (const token of ["", "firebase-user-token", "d".repeat(64)]) await assert.rejects(verifier.verify(token), /app_check_invalid/);
});
