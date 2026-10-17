import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { loadEnvironment } from "../src/config/environment.js";
import { createFirestoreStores } from "../src/infrastructure/firestore/stores.js";
import { SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID, SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID, SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID } from "../src/config/sandboxPromotionalAccess.js";

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
  REVENUECAT_PROJECT_ID: "proj8ae78267",
  REVENUECAT_APP_ID: "app7b06e9a4c1",
  REVENUECAT_ENTITLEMENT_ID: "premium",
  REVENUECAT_PRODUCT_ID: "prod8d07384c8c",
  REVENUECAT_WEBHOOK_ENVIRONMENT: "PRODUCTION",
} as const;

test("production rejects either Firebase emulator host before runtime configuration is returned", () => {
  const configured = loadEnvironment(production);
  assert.equal(configured.premiumMap?.version, "premium-map-v1");
  assert.deepEqual(configured.premiumMap?.bindings.map((binding) => binding.platform), ["ios"]);
  assert.throws(() => loadEnvironment({ ...production, REVENUECAT_PROJECT_ID: "projforeign" }), { message: "production_premium_map_required" });
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
  assert.throws(() => loadEnvironment({ ...production, CONTENT_PACKAGE_LOCAL_ROOT: "/var/lib/patternly/packages" }), { message: "local_content_package_transport_removed" });
});

test("sandbox promotional runtime pins Firebase and RevenueCat project, app, and environment while allowing expired policy boot", () => {
  const policyJson = (expiresAt: string) => JSON.stringify({
    firebaseProjectId: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID,
    revenueCatProjectId: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID,
    revenueCatAppId: SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID,
    customerId: "sandbox-test-account",
    expiresAt,
  });
  const configured = {
    ...production,
    FIREBASE_PROJECT_ID: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID,
    REVENUECAT_PROJECT_ID: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID,
    REVENUECAT_APP_ID: SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID,
    REVENUECAT_WEBHOOK_ENVIRONMENT: "SANDBOX",
    REVENUECAT_SANDBOX_PROMOTIONAL_ACCESS_JSON: policyJson("2026-10-18T12:00:00Z"),
  };
  assert.equal(loadEnvironment(configured).sandboxPromotionalAccess?.customerId, "sandbox-test-account");
  for (const invalid of [
    { ...configured, FIREBASE_PROJECT_ID: "patternly-app" },
    { ...configured, REVENUECAT_PROJECT_ID: "projWrong42" },
    { ...configured, REVENUECAT_APP_ID: "app-wrong" },
    { ...configured, REVENUECAT_WEBHOOK_ENVIRONMENT: "PRODUCTION" },
  ]) assert.throws(() => loadEnvironment(invalid), { message: "invalid_sandbox_promotional_access_runtime" });

  const expired = loadEnvironment({ ...configured, REVENUECAT_SANDBOX_PROMOTIONAL_ACCESS_JSON: policyJson("2020-01-01T00:00:00Z") });
  assert.equal(expired.sandboxPromotionalAccess?.expiresAt, "2020-01-01T00:00:00.000Z");
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

test("production requires the RevenueCat project namespace used for global transaction identity", () => {
  assert.throws(() => loadEnvironment({ ...production, REVENUECAT_PROJECT_ID: undefined }), { message: "production_revenuecat_config_required" });
});


test("content readiness target is explicit, paired and requires GCS; no local transport", () => {
  assert.equal(loadEnvironment(production).contentPackageReadiness, null);
  const config = { ...production, CONTENT_PACKAGE_BUCKET: "patternly-private-content", CONTENT_PACKAGE_READINESS_TRACK_ID: "accepted-track", CONTENT_PACKAGE_READINESS_NODE_ID: "accepted-node" };
  assert.deepEqual(loadEnvironment(config).contentPackageReadiness, { trackId: "accepted-track", nodeId: "accepted-node" });
  for (const invalid of [{ ...production, CONTENT_PACKAGE_READINESS_NODE_ID: "node" }, { ...production, CONTENT_PACKAGE_READINESS_TRACK_ID: "track", CONTENT_PACKAGE_READINESS_NODE_ID: "node" }, { ...config, CONTENT_PACKAGE_READINESS_NODE_ID: "../bad" }]) assert.throws(() => loadEnvironment(invalid));
});
