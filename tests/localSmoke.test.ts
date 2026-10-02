import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildApplication } from "../src/api/app.js";
import { localAppCheckVerifier, localSmokeRevenueCatEntitlementReader, smokeEndpoints, smokeEnvironment } from "../scripts/localSmoke.js";
const keys = { appCheckToken: "a".repeat(64), storageKey: "b".repeat(64), hmacKey: "c".repeat(64), recoveryOperationKey: "d".repeat(64) };
const source = { FIREBASE_PROJECT_ID: smokeEndpoints.project, FIREBASE_AUTH_EMULATOR_HOST: smokeEndpoints.auth, FIRESTORE_EMULATOR_HOST: smokeEndpoints.firestore };
test("smoke launcher requires existing local emulator configuration and excludes remote integrations", () => {
  const env = smokeEnvironment({ ...source, SMTP_HOST: "remote.invalid", REVENUECAT_READ_API_KEY: "remote", HOST: "0.0.0.0" }, keys);
  assert.equal(env.host, "127.0.0.1"); assert.equal(env.port, 8080);
  assert.equal(env.smtp, null); assert.equal(env.revenueCatReadApiKey, undefined);
  assert.equal(Object.hasOwn(env, "recoveryOperationTerminalRetentionMs"), false);
  assert.notEqual(Buffer.from(JSON.parse(env.recoveryOperationKeysJson!).keys[0].keyBase64, "base64").toString("hex"), keys.storageKey);
  for (const change of [{ NODE_ENV: "production" }, { FIREBASE_PROJECT_ID: "production" }, { FIREBASE_AUTH_EMULATOR_HOST: "remote:19099" }, { FIRESTORE_EMULATOR_HOST: "" }]) {
    assert.throws(() => smokeEnvironment({ ...source, ...change }, keys));
  }
});
test("local App Check fixture rejects missing/wrong tokens and never substitutes user identity", async () => {
  const verifier = localAppCheckVerifier(keys.appCheckToken);
  await verifier.verify(keys.appCheckToken);
  for (const token of ["", "firebase-user-token", "d".repeat(64)]) await assert.rejects(verifier.verify(token), /app_check_invalid/);
});

test("local smoke entitlement fixture defaults to the mobile identity with an expired state", async () => {
  const reader = localSmokeRevenueCatEntitlementReader();
  const result = await reader.read("local-smoke-user");
  assert.deepEqual(result, {
    entitlement: "premium",
    productId: "com.lkurczab.patternly.premium.monthly",
    state: "expired",
    providerExpiresAt: null,
    providerGraceExpiresAt: null,
    providerObservedAt: result.providerObservedAt,
  });
  assert.ok(Number.isFinite(Date.parse(result.providerObservedAt)));
});

test("local smoke active entitlement passes the ordinary GET /v1/entitlements route", async () => {
  const reader = localSmokeRevenueCatEntitlementReader("active");
  const result = await reader.read("local-smoke-user");
  assert.equal(result.entitlement, "premium");
  assert.equal(result.productId, "com.lkurczab.patternly.premium.monthly");
  assert.equal(result.state, "active");
  assert.ok(result.providerExpiresAt);
  const expiry = Date.parse(result.providerExpiresAt);
  assert.ok(Number.isFinite(expiry) && expiry > Date.now());
  assert.ok(expiry <= Date.now() + 31 * 24 * 60 * 60 * 1000);
  assert.equal(result.providerGraceExpiresAt, null);
  assert.ok(Number.isFinite(Date.parse(result.providerObservedAt)));

  const app = buildApplication({
    environment: smokeEnvironment(source, keys),
    firestore: null,
    stores: { users: { resolveExistingUser: async () => ({ userId: "local-smoke-user", authorizationGeneration: 1 }) } } as never,
    verifier: { verify: async () => ({ provider: "firebase", subject: "local-smoke-subject", emailVerified: true, authTime: Math.floor(Date.now() / 1000) }) },
    appCheckVerifier: localAppCheckVerifier(keys.appCheckToken),
    revenueCatEntitlementReader: reader,
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/entitlements",
      headers: { authorization: "Bearer local-smoke-token", "x-firebase-appcheck": keys.appCheckToken },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().entitlements[0].accountId, "local-smoke-user");
    assert.equal(response.json().entitlements[0].entitlement, "premium");
    assert.equal(response.json().entitlements[0].productId, "com.lkurczab.patternly.premium.monthly");
    assert.equal(response.json().entitlements[0].state, "active");
    assert.ok(Date.parse(response.json().entitlements[0].providerExpiresAt) > Date.now());
  } finally {
    await app.close();
  }
});

test("local smoke rejects unknown entitlement state and remains isolated from production", async () => {
  assert.throws(() => localSmokeRevenueCatEntitlementReader("enabled"), /invalid_local_smoke_entitlement_state/u);

  const [launcher, production] = await Promise.all([
    readFile(new URL("../scripts/dev-smoke.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
  ]);
  assert.match(launcher, /localSmokeRevenueCatEntitlementReader\(process\.env\[localSmokeEntitlementStateEnvironmentKey\]\)/u);
  assert.match(launcher, /if \(typeof secrets\.recoveryOperationKey !== "string"\)[\s\S]*?secrets = \{ \.\.\.secrets, recoveryOperationKey: randomBytes\(32\)\.toString\("hex"\) \}[\s\S]*?writeFile\(path, JSON\.stringify\(secrets\), \{ mode: 0o600 \}\)/u);
  assert.match(launcher, /revenueCatEntitlementReader/u);
  assert.match(launcher, /Local smoke API:.*entitlement fixture \(not provider attestation\); SMTP and remote RevenueCat disabled/u);
  assert.doesNotMatch(production, /localSmokeRevenueCatEntitlementReader|localSmokeEntitlementStateEnvironmentKey|com\.lkurczab\.patternly\.premium\.monthly/u);
});
