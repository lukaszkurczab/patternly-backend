import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { buildApplication } from "../src/api/app.js";
import { OPENAPI_DOCUMENT } from "../src/api/openapi.js";
import { loadEnvironment } from "../src/config/environment.js";
import { COLLECTIONS } from "../src/infrastructure/firestore/paths.js";
import { FirestoreDataExportStore } from "../src/modules/data-export/store.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("firebase_emulator_suite_required");

const firebaseApp = initializeApp({ projectId: `data-export-${randomUUID()}` }, `data-export-${randomUUID()}`);
const db = getFirestore(firebaseApp);
const now = Timestamp.fromMillis(Date.now());
const userId = "account-a";
const otherUserId = "account-b";
const authTime = Math.floor(Date.now() / 1_000);
const environment = loadEnvironment({
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "8080",
  LOG_LEVEL: "silent",
  REPORT_RATE_LIMIT_HASH_SECRET: "test-only-report-rate-limit-secret-0123456789",
  DELETION_PSEUDONYM_KEYS_JSON: JSON.stringify([{ version: "test-v1", status: "active", keyBase64: Buffer.alloc(32, 7).toString("base64") }]),
  ACCOUNT_DATA_EXPORT_RATE_LIMIT_MAX: "10",
  ACCOUNT_DATA_EXPORT_RATE_LIMIT_WINDOW_SECONDS: "3600",
  ACCOUNT_DATA_EXPORT_MAX_SERIALIZED_BYTES: "5242880",
  PRIVACY_RESPONSE_KEY_BASE64: Buffer.alloc(32, 11).toString("base64"),
  PRIVACY_AUDIT_HMAC_SECRET: "test-only-privacy-audit-hmac-secret-0123456789",
});

function exportStore(options: Readonly<{ rateLimitMax?: number; maxSerializedBytes?: number }> = {}): FirestoreDataExportStore {
  return new FirestoreDataExportStore(db, {
    rateLimitMax: options.rateLimitMax ?? environment.accountDataExportRateLimitMax,
    rateLimitWindowSeconds: environment.accountDataExportRateLimitWindowSeconds,
    maxSerializedBytes: options.maxSerializedBytes ?? environment.accountDataExportMaxSerializedBytes,
  });
}

function application(store: FirestoreDataExportStore, subject = "firebase-subject-a", currentUser = userId, currentAuthTime = authTime) {
  return buildApplication({
    environment,
    firestore: null,
    verifier: { verify: async () => ({ provider: "firebase", subject, email: `${currentUser}@example.com`, emailVerified: true, authTime: currentAuthTime }) },
    appCheckVerifier: null,
    stores: {
      users: { ensureUser: async () => ({ userId: currentUser }) },
      dataExport: store,
    } as never,
  });
}

async function seedDataset(): Promise<void> {
  await db.collection(COLLECTIONS.users).doc(userId).set({ createdAt: now, updatedAt: now, password: "must-not-export" });
  await db.collection(COLLECTIONS.users).doc(otherUserId).set({ createdAt: now, updatedAt: now });
  await db.collection(COLLECTIONS.identityMappings).doc("identity-a").set({ userId, provider: "firebase", subject: "raw-subject-a", email: "account-a@example.com", emailVerified: true, createdAt: now });
  await db.collection(COLLECTIONS.identityMappings).doc("identity-b").set({ userId: otherUserId, provider: "firebase", subject: "raw-subject-b", email: "account-b@example.com", emailVerified: true, createdAt: now });
  await db.collection(COLLECTIONS.users).doc(userId).collection("progress").doc("progress-a").set({ kind: "item", recordType: "training_attempt", trackId: "track-a", targetId: "item-a", version: 2, fingerprint: "a".repeat(64), state: { nestedTimestamp: now, mastery: "learning" }, lastMutationId: "mutation-a", updatedAt: now });
  await db.collection(COLLECTIONS.users).doc(otherUserId).collection("progress").doc("progress-b").set({ kind: "item", recordType: "training_attempt", trackId: "track-b", targetId: "item-b", version: 1, fingerprint: "b".repeat(64), state: { private: true }, lastMutationId: "mutation-b", updatedAt: now });
  await db.collection(COLLECTIONS.users).doc(userId).collection("devices").doc("device-hash-a").set({ deviceKey: "raw-device-key-a", platform: "ios", appVersion: "1.2.3", lastSeenAt: now, updatedAt: now });
  await db.collection(COLLECTIONS.users).doc(userId).collection("trackAccess").doc("track-a").set({ trackId: "track-a", source: "subscription", status: "active", updatedAt: now });
  await db.collection(COLLECTIONS.users).doc(userId).collection("entitlements").doc("premium").set({ entitlement: "premium", status: "active", source: "revenuecat", expiresAt: now, updatedAt: now });
  await db.collection(COLLECTIONS.users).doc(userId).collection("legalAcceptances").doc("terms-v1").set({ kind: "terms_and_minimum_age", termsVersion: "v1", minimumAgeConfirmed: 18, acceptedAt: now });
  await db.collection(COLLECTIONS.users).doc(userId).collection("purchaseConfirmations").doc("confirmation-a").set({ confirmationId: "confirmation-a", productIdentifier: "com.lkurczab.patternly.premium.monthly", storefrontPrice: "29,99 zł", immediateStartRequested: true, acceptedAt: now });
  await db.collection(COLLECTIONS.users).doc(userId).collection("syncMetadata").doc("account").set({ accountRevision: 2, updatedAt: now, internalSecret: "must-not-export" });
  await db.collection(COLLECTIONS.users).doc(userId).collection("syncOperations").doc("operation-a").set({ payload: "must-not-export" });
  await db.collection(COLLECTIONS.users).doc(userId).collection("syncMutations").doc("mutation-a").set({ state: "must-not-export" });
  await db.collection(COLLECTIONS.users).doc(userId).collection("security").doc("recoveryCodes").set({ codeHash: "must-not-export" });
  await db.collection(COLLECTIONS.contentReports).doc("report-a").set({ id: "report-a", clientSubmissionId: "submission-a", trackId: "track-a", contentVersion: "v1", itemId: "item-a", reason: "other", description: "A user-provided report", context: { releasePackageId: "patternly-launch-2026-08-25-01", trackNode: "complexity_and_constraints", modeRoute: "answer_review", locale: "en", appBuild: "1.2.3", platform: "ios", occurredAt: now, legacyNestedContext: { subject: "must-not-export" } }, status: "resolved", accountId: userId, contactEmail: "account-a@example.com", createdAt: now, updatedAt: now, expiresAt: Timestamp.fromMillis(Date.now() + 86_400_000) });
  await db.collection(COLLECTIONS.contentReports).doc("report-b").set({ id: "report-b", clientSubmissionId: "submission-b", trackId: "track-b", contentVersion: "v1", itemId: "item-b", reason: "other", description: "Other account report", context: {}, status: "open", accountId: otherUserId, createdAt: now, updatedAt: now });
  await db.collection(COLLECTIONS.contentReports).doc("report-anonymous").set({ id: "report-anonymous", clientSubmissionId: "submission-anonymous", trackId: "track-c", contentVersion: "v1", itemId: "item-c", reason: "other", description: "Anonymous report", context: {}, status: "open", createdAt: now, updatedAt: now });
}

async function seedMinimalAccount(id: string, subject: string): Promise<void> {
  await db.collection(COLLECTIONS.users).doc(id).set({ createdAt: now, updatedAt: now });
  await db.collection(COLLECTIONS.identityMappings).doc(`identity-${id}`).set({ userId: id, provider: "firebase", subject, email: `${id}@example.com`, emailVerified: true, createdAt: now });
}

test.before(seedDataset);

test.after(async () => {
  await db.recursiveDelete(db.collection(COLLECTIONS.users).doc(userId));
  await db.recursiveDelete(db.collection(COLLECTIONS.users).doc(otherUserId));
  await db.recursiveDelete(db.collection(COLLECTIONS.users).doc("account-c"));
  await db.recursiveDelete(db.collection(COLLECTIONS.contentReports).doc("report-a"));
  await db.recursiveDelete(db.collection(COLLECTIONS.contentReports).doc("report-b"));
  await db.recursiveDelete(db.collection(COLLECTIONS.contentReports).doc("report-anonymous"));
  await db.recursiveDelete(db.collection(COLLECTIONS.accountDataExportAudits).doc("unused"));
  await db.terminate();
  await deleteApp(firebaseApp);
});

test("account export contract is complete, isolated, timestamp-portable and redact-free", async () => {
  const app = application(exportStore());
  try {
    const response = await app.inject({ method: "GET", url: "/v1/account-data/export", headers: { authorization: "Bearer valid" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.match(String(response.headers["content-disposition"] ?? ""), /^attachment; filename="patternly-account-data\.json"$/u);
    assert.match(String(response.headers["content-type"] ?? ""), /^application\/json; charset=utf-8/u);
    const body = response.json() as Record<string, unknown>;
    assert.equal(body.schemaVersion, "account-data-export-v1");
    assert.match(String(body.exportId), /^export_[A-Za-z0-9_-]{32}$/u);
    assert.match(String(body.exportedAt), /^\d{4}-\d{2}-\d{2}T/u);
    const article15 = body.article15Information as Record<string, unknown>;
    assert.equal(Array.isArray(article15.purposes), true);
    assert.equal(Array.isArray(article15.dataCategories), true);
    assert.equal(Array.isArray(article15.recipientCategories), true);
    assert.equal(Array.isArray(article15.retentionCriteria), true);
    assert.equal(Array.isArray(article15.dataSources), true);
    assert.match(String(article15.rightsAndComplaint), /Prezes/u);
    const portable = body.portable as Record<string, unknown>;
    const profile = portable.profile as Record<string, unknown>;
    assert.deepEqual(profile.identity, { provider: "firebase", email: "account-a@example.com", emailVerified: true });
    assert.equal("subject" in (profile.identity as Record<string, unknown>), false);
    assert.deepEqual((portable.progress as Array<Record<string, unknown>>)[0]?.state, { nestedTimestamp: now.toDate().toISOString(), mastery: "learning" });
    assert.equal((portable.linkedContentReports as Array<Record<string, unknown>>).length, 1);
    const report = (portable.linkedContentReports as Array<Record<string, unknown>>)[0] ?? {};
    assert.equal("contactEmail" in report, false);
    assert.deepEqual(report.context, { releasePackageId: "patternly-launch-2026-08-25-01", trackNode: "complexity_and_constraints", modeRoute: "answer_review", locale: "en", appBuild: "1.2.3", platform: "ios", occurredAt: now.toDate().toISOString() });
    assert.equal("legacyNestedContext" in (report.context as Record<string, unknown>), false);
    const context = body.accountContext as Record<string, unknown>;
    assert.deepEqual((context.devices as Array<Record<string, unknown>>)[0], { platform: "ios", appVersion: "1.2.3", lastSeenAt: now.toDate().toISOString(), updatedAt: now.toDate().toISOString() });
    assert.equal("deviceKey" in ((context.devices as Array<Record<string, unknown>>)[0] ?? {}), false);
    assert.deepEqual(context.syncMetadata, { accountRevision: 2, updatedAt: now.toDate().toISOString() });
    assert.deepEqual((context.legalAcceptances as Array<Record<string, unknown>>)[0], { kind: "terms_and_minimum_age", termsVersion: "v1", minimumAgeConfirmed: 18, acceptedAt: now.toDate().toISOString() });
    assert.equal((context.purchaseConfirmations as Array<Record<string, unknown>>)[0]?.acceptedAt, now.toDate().toISOString());
    assert.deepEqual(context.consumerCases, []);
    const serialized = JSON.stringify(body);
    for (const forbidden of ["raw-subject-a", "raw-subject-b", "raw-device-key-a", "must-not-export", "Other account report", "Anonymous report"]) assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    const manifest = body.manifest as Record<string, unknown>;
    assert.deepEqual(manifest.included, ["portable.profile", "portable.progress", "portable.linkedContentReports", "accountContext.trackAccess", "accountContext.entitlements", "accountContext.legalAcceptances", "accountContext.purchaseConfirmations", "accountContext.consumerCases", "accountContext.devices", "accountContext.syncMetadata", "accountContext.exportHistory"]);
    assert.equal((manifest.omitted as Array<Record<string, unknown>>).some((entry) => entry.category === "credentials"), true);
    assert.equal((await db.collection(COLLECTIONS.accountDataExportAudits).where("userId", "==", userId).get()).size, 1);
    const audit = (await db.collection(COLLECTIONS.accountDataExportAudits).where("userId", "==", userId).get()).docs[0]?.data() ?? {};
    assert.equal(audit.status, "completed");
    assert.equal(audit.schemaVersion, "account-data-export-v1");
    assert.ok(audit.expiresAt);
    for (const forbiddenField of ["payload", "serialized", "subject", "email", "deviceKey"]) assert.equal(forbiddenField in audit, false, forbiddenField);
  } finally {
    await app.close();
  }

  const unauthenticatedApp = application(exportStore());
  try {
    const unauthenticated = await unauthenticatedApp.inject({ method: "GET", url: "/v1/account-data/export" });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.headers["cache-control"], "private, no-store");
  } finally {
    await unauthenticatedApp.close();
  }
});

test("recent authentication, concurrent account rate limiting and whole-export size limit are enforced", async () => {
  await seedMinimalAccount("account-c", "raw-subject-c");
  const limitedStore = exportStore({ rateLimitMax: 1 });
  const app = application(limitedStore, "firebase-subject-c", "account-c");
  try {
    const [first, second] = await Promise.all([
      app.inject({ method: "GET", url: "/v1/account-data/export", headers: { authorization: "Bearer valid" } }),
      app.inject({ method: "GET", url: "/v1/account-data/export", headers: { authorization: "Bearer valid" } }),
    ]);
    assert.deepEqual(new Set([first.statusCode, second.statusCode]), new Set([200, 429]));
    const rateLimited = first.statusCode === 429 ? first : second;
    assert.match(String(rateLimited.headers["retry-after"] ?? ""), /^[1-9][0-9]*$/u);
  } finally {
    await app.close();
  }

  const staleApp = application(exportStore(), "firebase-subject-stale", userId, authTime - 301);
  try {
    const stale = await staleApp.inject({ method: "GET", url: "/v1/account-data/export", headers: { authorization: "Bearer stale" } });
    assert.equal(stale.statusCode, 401);
    assert.equal(stale.headers["cache-control"], "private, no-store");
    assert.deepEqual(stale.json(), { error: { code: "recent_reauthentication_required" } });
  } finally {
    await staleApp.close();
  }

  const oversizedApp = application(exportStore({ maxSerializedBytes: 100 }));
  try {
    const oversized = await oversizedApp.inject({ method: "GET", url: "/v1/account-data/export", headers: { authorization: "Bearer valid" } });
    assert.equal(oversized.statusCode, 413);
    assert.deepEqual(oversized.json(), { error: { code: "data_export_too_large" } });
  } finally {
    await oversizedApp.close();
  }
});

test("export history is ordered by createdAt, excludes the current export and caps at 100", async () => {
  const historyUserId = "account-history";
  await seedMinimalAccount(historyUserId, "raw-subject-history");
  const historyBase = Date.now() - 10_000;
  for (let index = 0; index < 105; index += 1) {
    const createdAt = Timestamp.fromMillis(historyBase - index * 1_000);
    await db.collection(COLLECTIONS.accountDataExportAudits).doc(`history-${String(index).padStart(3, "0")}`).set({
      exportId: `history-${String(index).padStart(3, "0")}`,
      userId: historyUserId,
      createdAt,
      status: "completed",
      schemaVersion: "account-data-export-v1",
      scope: [],
      expiresAt: Timestamp.fromMillis(createdAt.toMillis() + 30 * 86_400_000),
    });
  }

  const result = await exportStore().create(historyUserId);
  const body = JSON.parse(result.serialized) as Record<string, unknown>;
  const history = ((body.accountContext as Record<string, unknown>).exportHistory as Array<Record<string, unknown>>);
  assert.equal(history.length, 100);
  assert.equal(history[0]?.exportId, "history-000");
  assert.equal(history[99]?.exportId, "history-099");
  assert.equal(history.some((entry) => entry.exportId === result.exportId), false);
  assert.equal(history.some((entry) => entry.exportId === "history-100"), false);
  for (let index = 1; index < history.length; index += 1) assert.ok(String(history[index - 1]?.exportedAt) >= String(history[index]?.exportedAt));
});

test("stable exports complete only after their consumer and never rebuild after completion", async () => {
  const store = exportStore();
  const exportId = `export_${"s".repeat(32)}`;
  let statusDuringCallback = "";
  await assert.rejects(store.create(userId, exportId, async () => {
    statusDuringCallback = String((await db.collection(COLLECTIONS.accountDataExportAudits).doc(exportId).get()).data()?.status);
    throw new Error("consumer_unavailable");
  }), /consumer_unavailable/u);
  assert.equal(statusDuringCallback, "started");
  assert.equal((await db.collection(COLLECTIONS.accountDataExportAudits).doc(exportId).get()).data()?.status, "failed");

  const completed = await store.create(userId, exportId, async () => undefined);
  assert.equal(completed.exportId, exportId);
  assert.equal((await db.collection(COLLECTIONS.accountDataExportAudits).doc(exportId).get()).data()?.status, "completed");
  await assert.rejects(store.create(userId, exportId, async () => undefined), /account_data_export_already_completed/u);
});

test("OpenAPI describes the versioned attachment contract and protected route", () => {
  const path = OPENAPI_DOCUMENT.paths["/v1/account-data/export"] as Record<string, unknown>;
  assert.ok(path);
  assert.ok((path.get as Record<string, unknown>).responses);
  const schemas = OPENAPI_DOCUMENT.components.schemas as Record<string, unknown>;
  assert.equal((schemas.AccountDataExport as Record<string, unknown>).type, "object");
  assert.equal((schemas.AccountDataExport as Record<string, unknown>).additionalProperties, false);
});
