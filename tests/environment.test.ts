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
  assert.throws(() => loadEnvironment({ ...production, CONTENT_PACKAGE_LOCAL_ROOT: "/var/lib/patternly/packages" }), { message: "production_local_content_package_storage_forbidden" });
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

test("operator OIDC configuration is optional, all-or-none, pinned to safe HTTPS, and strict", () => {
  assert.equal(loadEnvironment(production).operatorAccess, null);
  const configured = {
    ...production,
    OPERATOR_OIDC_ISSUER: "https://accounts.example.test",
    OPERATOR_OIDC_AUDIENCE: "patternly-operators",
    OPERATOR_OIDC_JWKS_URL: "https://keys.example.test/.well-known/jwks.json",
    OPERATOR_ALLOWLIST_JSON: JSON.stringify([{ subject: "operator-1", role: "content_operator", actions: ["content_reports:read", "content_reports:transition"] }]),
  };
  const access = loadEnvironment(configured).operatorAccess;
  assert.equal(access?.issuer, configured.OPERATOR_OIDC_ISSUER);
  assert.equal(access?.operators[0]?.subject, "operator-1");
  for (const key of ["OPERATOR_OIDC_ISSUER", "OPERATOR_OIDC_AUDIENCE", "OPERATOR_OIDC_JWKS_URL", "OPERATOR_ALLOWLIST_JSON"] as const) {
    const partial = { ...configured } as Record<string, string>;
    delete partial[key];
    assert.throws(() => loadEnvironment(partial), { message: "invalid_operator_oidc_config" });
  }
  for (const unsafe of ["http://keys.example.test/jwks", "https://localhost/jwks", "https://127.0.0.1/jwks", "https://[::1]/jwks", "https://user:password@keys.example.test/jwks", "https://keys.example.test/"]) {
    assert.throws(() => loadEnvironment({ ...configured, OPERATOR_OIDC_JWKS_URL: unsafe }), { message: "invalid_operator_oidc_jwks_url" });
  }
  for (const allowlist of [
    [{ subject: "operator-1", role: "operator", actions: ["*"] }],
    [{ subject: "operator-1", role: "operator", actions: ["content_reports:read", "content_reports:read"] }],
    [{ subject: "operator-1", role: "operator", actions: ["content_reports:read"] }, { subject: "operator-1", role: "other", actions: ["legal_requests:read"] }],
    [{ subject: "operator-1", role: "operator", actions: ["content_reports:read"], extra: true }],
  ]) {
    assert.throws(() => loadEnvironment({ ...configured, OPERATOR_ALLOWLIST_JSON: JSON.stringify(allowlist) }), { message: "invalid_operator_allowlist" });
  }
});
