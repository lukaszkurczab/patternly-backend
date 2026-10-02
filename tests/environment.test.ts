import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { loadEnvironment } from "../src/config/environment.js";
import { createFirestoreStores } from "../src/infrastructure/firestore/stores.js";

const production = {
  NODE_ENV: "production",
  FIREBASE_PROJECT_ID: "patternly-app-sandbox",
  FIREBASE_AUTH_ISSUER: "https://securetoken.google.com/patternly-app-sandbox",
  REPORT_RATE_LIMIT_HASH_SECRET: "test-only-report-rate-limit-secret-0123456789",
  DELETION_PSEUDONYM_KEYS_JSON: JSON.stringify([{ version: "test-v1", status: "active", keyBase64: Buffer.alloc(32, 7).toString("base64") }]),
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

test("recovery cipher configuration remains independent from fixed terminal retention", () => {
  const configured = loadEnvironment(production);
  assert.equal(configured.recoveryOperationKeysJson, undefined);
  assert.equal(Object.hasOwn(configured, "recoveryOperationTerminalRetentionMs"), false);
  assert.equal(configured.recoveryOperationRateLimitMax, 30);
  assert.equal(configured.recoveryOperationRateLimitWindowSeconds, 60);

  const explicit = loadEnvironment({
    ...production,
    RECOVERY_OPERATION_KEYS_JSON: JSON.stringify({ version: 1, keys: [{ version: "v1", status: "active", keyBase64: Buffer.alloc(32, 17).toString("base64") }] }),
    RECOVERY_OPERATION_RATE_LIMIT_MAX: "120",
    RECOVERY_OPERATION_RATE_LIMIT_WINDOW_SECONDS: "60",
  });
  assert.ok(explicit.recoveryOperationKeysJson);
  assert.equal(Object.hasOwn(explicit, "recoveryOperationTerminalRetentionMs"), false);
  assert.equal(explicit.recoveryOperationRateLimitMax, 120);

  for (const [field, value] of [["RECOVERY_OPERATION_RATE_LIMIT_MAX", "601"], ["RECOVERY_OPERATION_RATE_LIMIT_WINDOW_SECONDS", "3601"]] as const) {
    assert.throws(() => loadEnvironment({ ...production, [field]: value }));
  }
});

test("store wiring rejects recovery key reuse against the privacy encryption key, including retained keys", () => {
  const privacyKey = Buffer.alloc(32, 17).toString("base64");
  const environment = loadEnvironment({
    ...production,
    PRIVACY_RESPONSE_KEY_BASE64: privacyKey,
    RECOVERY_OPERATION_KEYS_JSON: JSON.stringify({ version: 1, keys: [
      { version: "v2", status: "active", keyBase64: Buffer.alloc(32, 18).toString("base64") },
      { version: "v1", status: "decrypt_only", keyBase64: privacyKey },
    ] }),
  });
  assert.throws(() => createFirestoreStores({ app: null, db: null } as never, environment, {} as never), { message: "recovery_operation_key_reuse_forbidden" });
});


test("shared emulator fixture uses the explicit runner project and rejects malformed overrides", () => {
  const verify = (project: string | undefined, expected: string | null) => {
    const env: NodeJS.ProcessEnv = { ...process.env, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:19119", FIRESTORE_EMULATOR_HOST: "127.0.0.1:18119" };
    if (project === undefined) delete env.FIREBASE_PROJECT_ID;
    else env.FIREBASE_PROJECT_ID = project;
    const script = `import {testEnvironment} from './tests/support.ts'; if (testEnvironment.firebaseProjectId !== ${JSON.stringify(expected)} || testEnvironment.firebaseAuthIssuer !== 'https://securetoken.google.com/' + testEnvironment.firebaseProjectId) process.exit(2);`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env, encoding: "utf8" });
    if (expected === null) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /firebase_test_project_invalid/);
    } else assert.equal(result.status, 0, result.stderr);
  };
  verify(undefined, "patternly-app-sandbox");
  verify("demo-patternly-aud08-suite", "demo-patternly-aud08-suite");
  verify("", null);
  verify("invalid/project", null);
});
