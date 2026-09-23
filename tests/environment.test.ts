import assert from "node:assert/strict";
import test from "node:test";
import { loadEnvironment } from "../src/config/environment.js";

const production = {
  NODE_ENV: "production",
  FIREBASE_PROJECT_ID: "patternly-app-sandbox",
  FIREBASE_AUTH_ISSUER: "https://securetoken.google.com/patternly-app-sandbox",
  REPORT_RATE_LIMIT_HASH_SECRET: "test-only-report-rate-limit-secret-0123456789",
  DELETION_PSEUDONYM_KEYS_JSON: "[]",
  PRIVACY_RESPONSE_KEY_BASE64: "test-only-privacy-response-key",
  PRIVACY_AUDIT_HMAC_SECRET: "test-only-privacy-audit-secret-0123456789",
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "465",
  SMTP_USERNAME: "sender@example.test",
  SMTP_PASSWORD: "test-only-password",
  SMTP_FROM_EMAIL: "sender@example.test",
  SMTP_FROM_NAME: "Patternly",
  REVENUECAT_WEBHOOK_SECRET: "test-only-revenuecat-secret",
  REVENUECAT_APP_ID: "patternly-test-app",
  REVENUECAT_ENTITLEMENT_ID: "premium",
  REVENUECAT_PRODUCT_ID: "premium-monthly",
  REVENUECAT_WEBHOOK_ENVIRONMENT: "PRODUCTION",
} as const;

test("production rejects either Firebase emulator host before runtime configuration is returned", () => {
  assert.doesNotThrow(() => loadEnvironment(production));
  for (const value of ["127.0.0.1:19099", "remote.example.test:19099", ""]) {
    assert.throws(
      () => loadEnvironment({ ...production, FIREBASE_AUTH_EMULATOR_HOST: value }),
      { message: "production_firebase_emulator_config_forbidden" },
    );
    assert.throws(
      () => loadEnvironment({ ...production, FIRESTORE_EMULATOR_HOST: value }),
      { message: "production_firebase_emulator_config_forbidden" },
    );
    assert.throws(
      () => loadEnvironment({ ...production, FIREBASE_AUTH_EMULATOR_HOST: value, FIRESTORE_EMULATOR_HOST: value }),
      { message: "production_firebase_emulator_config_forbidden" },
    );
  }
});

test("explicit local emulator configuration remains accepted outside production", () => {
  const local = loadEnvironment({
    NODE_ENV: "test",
    FIREBASE_PROJECT_ID: "patternly-app-sandbox",
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:19099",
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:18081",
    REPORT_RATE_LIMIT_HASH_SECRET: "test-only-report-rate-limit-secret-0123456789",
    DELETION_PSEUDONYM_KEYS_JSON: "[]",
    PRIVACY_RESPONSE_KEY_BASE64: "test-only-privacy-response-key",
    PRIVACY_AUDIT_HMAC_SECRET: "test-only-privacy-audit-secret-0123456789",
  });
  assert.equal(local.nodeEnv, "test");
  assert.equal(local.firebaseProjectId, "patternly-app-sandbox");
});
