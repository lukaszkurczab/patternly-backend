import assert from "node:assert/strict";
import test from "node:test";
import { LOCAL_ADMIN_CONTRACT, LOCAL_ADMIN_DELETION_PSEUDONYM_KEYS_JSON, buildLocalAdminEnvironment } from "./localAdminEnvironment.mjs";

const values = {
  adminEmail: "admin@local.patternly.test",
  adminContentRoot: "/workspace/patternly-content/artifacts",
  adminContentReleaseId: "patternly-launch-2026-08-25-01",
};

test("local admin launcher pins one local deletion pseudonym key and ignores ambient override", () => {
  const ambientKeyRing = JSON.stringify([{ version: "ambient-v1", status: "active", keyBase64: Buffer.alloc(32, 0xaa).toString("base64") }]);
  const environment = buildLocalAdminEnvironment({
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    FIREBASE_PROJECT_ID: "production-project",
    DELETION_PSEUDONYM_KEYS_JSON: ambientKeyRing,
  }, values);

  assert.equal(Object.isFrozen(LOCAL_ADMIN_CONTRACT), true);
  assert.equal(environment.NODE_ENV, "development");
  assert.equal(environment.HOST, "127.0.0.1");
  assert.equal(environment.FIREBASE_PROJECT_ID, LOCAL_ADMIN_CONTRACT.project);
  assert.equal(environment.FIREBASE_AUTH_EMULATOR_HOST, LOCAL_ADMIN_CONTRACT.authEmulatorHost);
  assert.equal(environment.FIRESTORE_EMULATOR_HOST, LOCAL_ADMIN_CONTRACT.firestoreEmulatorHost);
  assert.equal(environment.ADMIN_WEB_ORIGIN, LOCAL_ADMIN_CONTRACT.webOrigin);
  assert.equal(environment.DELETION_PSEUDONYM_KEYS_JSON, LOCAL_ADMIN_DELETION_PSEUDONYM_KEYS_JSON);
  assert.notEqual(environment.DELETION_PSEUDONYM_KEYS_JSON, ambientKeyRing);

  const keyRing = JSON.parse(environment.DELETION_PSEUDONYM_KEYS_JSON);
  assert.equal(keyRing.length, 1);
  assert.equal(keyRing[0].version, "local-v1");
  assert.equal(keyRing[0].status, "active");
  assert.equal(Buffer.from(keyRing[0].keyBase64, "base64").length >= 32, true);
});
