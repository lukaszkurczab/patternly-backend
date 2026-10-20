import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DocumentReference, Query, Timestamp, Transaction, WriteBatch } from "firebase-admin/firestore";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createEmulatorContext, createRegisteredAuthUser, TEST_APP_CHECK_TOKEN } from "../../tests/support.js";
import { progressDocumentId } from "../../src/infrastructure/firestore/paths.js";
import { createMergeRecordFingerprint } from "../../src/modules/users/merge.js";
import { attemptState } from "../../tests/progressFixtures.js";
import { ContentPackageService, FirestoreContentPackagePointerStore, contentNodePackagePath, CONTENT_PACKAGE_SCHEMA } from "../../src/modules/content/packages.js";
import { gcsPackageFixture } from "../../tests/fixtures/gcsPackageFixture.js";
import { validateIsolatedEmulatorRuntime } from "../isolated-emulator-test-runner.mjs";

validateIsolatedEmulatorRuntime(process.env, "demo-patternly-cost02-client");
const authEmulatorOrigin = "http://127.0.0.1:19119";
const frontendRoot = process.env.PATTERNLY_FRONTEND_ROOT;
const frontendSha = process.env.PATTERNLY_FRONTEND_EXPECTED_SHA;
if (!frontendRoot || !/^[a-f0-9]{40}$/u.test(frontendSha ?? "")) throw new Error("cost02_frontend_pin_required");
const pinnedSha = (await import("node:child_process")).execFileSync("git", ["-C", frontendRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (pinnedSha !== frontendSha) throw new Error("cost02_frontend_pin_mismatch");

const frontendRequire = createRequire(resolve(frontendRoot, "package.json"));
const appLoad = (path) => frontendRequire(resolve(frontendRoot, path));
const { createPatternlyApiClient } = appLoad("src/infrastructure/clients/PatternlyApiClientAdapter.ts");
const { MemoryKeyValueStorage, installKeyValueStorageForTests, setActiveProfileLeaseForTests } = appLoad("src/infrastructure/storage/mmkvClient.ts");
const accountData = appLoad("src/storage/repositories/accountDataRepository.ts");
const guest = appLoad("src/storage/repositories/guestInstallationRepository.ts");
const { productionLearningDataAdmissionContext: dataAdmission, productionTrackAdmissionContext: trackAdmission } = appLoad("src/application/tracks/trackAdmissionContext.ts");
const { session, attempt } = appLoad("src/testing/journalTestSupport.ts");
const { createTrainingSessionResult, createFamilyEnvelope } = appLoad("src/domain/index.ts");
const { loadAccountDataSession, retryAccountDataSync, retryPendingAccountDataSync, retryLearningPlanRecovery } = appLoad("src/application/account/accountDataService.ts");
const { getMeWithExchangedSession } = appLoad("src/application/account/accountSessionExchange.ts");
const { commitTrainingOutcome, commitTrainingSessionStart, commitSessionCompletion } = appLoad("src/application/learningMutations/index.ts");
const { installLearningStateResetBarrier } = appLoad("src/application/learningMutations/index.ts");
installLearningStateResetBarrier(async (run) => run());

const sizes = (process.env.COST02_HISTORY_SIZES ?? "0,100,1000,10000").split(",").map(Number);
if (sizes.some((size) => ![0, 100, 1000, 10000].includes(size))) throw new Error("cost02_history_size_invalid");
const signedPackage = gcsPackageFixture();
let entitlementState = "active";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const packageFixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/cost02-package");
const manifest = JSON.parse(await readFile(resolve(packageFixtureDirectory, "manifest.json"), "utf8"));
const packageProvenance = JSON.parse(await readFile(resolve(packageFixtureDirectory, "provenance.json"), "utf8"));
const compressed = await readFile(resolve(packageFixtureDirectory, "package.gzip"));
const contentBytes = await (async () => { const { gunzipSync } = await import("node:zlib"); return gunzipSync(compressed); })();
assert.equal(manifest.schemaVersion, CONTENT_PACKAGE_SCHEMA);
assert.equal(manifest.packagePath, contentNodePackagePath(manifest.trackId, manifest.nodeId, manifest.packageSha256));
assert.equal(manifest.packageSha256, sha(compressed), "local package fixture SHA must match its manifest");
assert.equal(manifest.artifactSha256, sha(contentBytes), "local artifact fixture SHA must match its manifest");
assert.equal(packageProvenance.packageSha256, manifest.packageSha256, "fixture provenance package SHA must match manifest");
assert.equal(packageProvenance.compressedSizeBytes, compressed.length, "fixture provenance package size must match bytes");
assert.equal(packageProvenance.artifactSha256, manifest.artifactSha256, "fixture provenance artifact SHA must match manifest");
const context = createEmulatorContext({
  revenueCatEntitlementReader: { read: async () => ({ entitlement: "premium", productId: "cost02-fixture", state: entitlementState, providerExpiresAt: "2099-01-01T00:00:00.000Z", providerGraceExpiresAt: "2099-01-02T00:00:00.000Z", providerObservedAt: new Date().toISOString() }) },
  createContentPackages: (db) => new ContentPackageService(new FirestoreContentPackagePointerStore(db), signedPackage.storage),
});

const counters = {
  httpAttempts: 0, httpSuccesses: 0, httpErrors: 0, httpStatuses: {}, requestBodyBytes: 0, responseBodyBytes: 0,
  authSdkRpcAttempts: 0, gcsDownloadAttempts: 0, gcsDownloadSuccesses: 0, gcsDownloadErrors: 0, sdkQueries: 0, queryDocuments: 0, queryResultSizes: [], directReadCalls: 0, directReadDocuments: 0, missingDocuments: 0,
  transactionCalls: 0, transactionAttempts: 0, transactionReadDocuments: 0, transactionMissingDocuments: 0, firestoreWrites: 0, firestoreDeletes: 0,
  writeBatchEnqueuedWrites: 0, writeBatchEnqueuedDeletes: 0, committedWriteOperations: 0, successfulWriteCommits: 0,
  writeBatchResetCount: 0,
  signedPackageFixtureBytes: 0,
};
let failNextSync = false;
const resetCounters = () => { for (const key of Object.keys(counters)) counters[key] = key === "httpStatuses" ? {} : key === "queryResultSizes" ? [] : 0; };
const originalQueryGet = Query.prototype.get;
const originalTransactionGet = Transaction.prototype.get;
const originalTransactionGetAll = Transaction.prototype.getAll;
const originalBatchWrites = Object.fromEntries(["set", "create", "update", "delete"].map((key) => [key, WriteBatch.prototype[key]]));
const originalBatchCommitInternal = WriteBatch.prototype._commit;
const originalBatchReset = WriteBatch.prototype._reset;
if (typeof originalBatchCommitInternal !== "function" || typeof originalBatchReset !== "function") throw new Error("cost02_firestore_write_batch_commit_hook_unavailable");
const batchMutationCounts = new WeakMap();
const committedBatches = new WeakSet();
const originalDbGetAll = context.db.getAll.bind(context.db);
const originalRunTransaction = context.db.runTransaction.bind(context.db);
const countSnapshots = (value, target, missingTarget) => {
  for (const snapshot of Array.isArray(value) ? value : [value]) {
    if (!snapshot || typeof snapshot.exists !== "boolean") throw new Error("cost02_sdk_snapshot_shape_invalid");
    target();
    if (!snapshot.exists) missingTarget();
  }
};
Query.prototype.get = async function (...args) {
  const snapshot = await Reflect.apply(originalQueryGet, this, args);
  counters.sdkQueries += 1;
  counters.queryDocuments += snapshot.size;
  counters.queryResultSizes.push(snapshot.size);
  return snapshot;
};
Transaction.prototype.get = async function (...args) {
  const snapshot = await Reflect.apply(originalTransactionGet, this, args);
  countSnapshots(snapshot, () => { counters.transactionReadDocuments += 1; }, () => { counters.transactionMissingDocuments += 1; });
  return snapshot;
};
Transaction.prototype.getAll = async function (...args) {
  const snapshots = await Reflect.apply(originalTransactionGetAll, this, args);
  countSnapshots(snapshots, () => { counters.transactionReadDocuments += 1; }, () => { counters.transactionMissingDocuments += 1; });
  return snapshots;
};
for (const key of Object.keys(originalBatchWrites)) WriteBatch.prototype[key] = function (...args) {
  const counts = batchMutationCounts.get(this) ?? { writes: 0, deletes: 0 };
  if (key === "delete") { counts.deletes += 1; counters.writeBatchEnqueuedDeletes += 1; }
  else { counts.writes += 1; counters.writeBatchEnqueuedWrites += 1; }
  batchMutationCounts.set(this, counts);
  return Reflect.apply(originalBatchWrites[key], this, args);
};
WriteBatch.prototype._commit = async function (...args) {
  const counts = batchMutationCounts.get(this) ?? { writes: 0, deletes: 0 };
  const result = await Reflect.apply(originalBatchCommitInternal, this, args);
  const writeResults = result?.writeResults ?? [];
  if (!Array.isArray(writeResults) || writeResults.length !== counts.writes + counts.deletes) throw new Error("cost02_firestore_commit_result_count_mismatch");
  if (!committedBatches.has(this)) {
    counters.firestoreWrites += counts.writes;
    counters.firestoreDeletes += counts.deletes;
    counters.committedWriteOperations += writeResults.length;
    counters.successfulWriteCommits += 1;
    committedBatches.add(this);
  }
  return result;
};
WriteBatch.prototype._reset = function (...args) {
  counters.writeBatchResetCount += 1;
  batchMutationCounts.set(this, { writes: 0, deletes: 0 });
  committedBatches.delete(this);
  return Reflect.apply(originalBatchReset, this, args);
};
context.db.getAll = async (...args) => {
  const snapshots = await originalDbGetAll(...args);
  counters.directReadCalls += 1;
  counters.directReadDocuments += snapshots.length;
  counters.missingDocuments += snapshots.filter((snapshot) => !snapshot.exists).length;
  return snapshots;
};
context.db.runTransaction = async (callback, ...options) => {
  counters.transactionCalls += 1;
  return Reflect.apply(originalRunTransaction, context.db, [async (transaction) => { counters.transactionAttempts += 1; return callback(transaction); }, ...options]);
};

const auth = await createRegisteredAuthUser(context);
// Firestore Admin's DocumentReference.get delegates through this.db.getAll.
// Assert the SDK call graph here so an emulator counter never double-counts it.
resetCounters();
const counterProbe = context.db.collection("users").doc(auth.userId);
await counterProbe.get();
assert.equal(counters.directReadDocuments, 1, "DocumentReference.get must count once through Firestore.getAll");
const instrumentationProbes = [{ kind: "read", operation: "DocumentReference.get", observedSnapshots: counters.directReadDocuments, counterBoundary: "Firestore.getAll" }];
resetCounters();
await context.db.getAll(counterProbe);
assert.equal(counters.directReadDocuments, 1, "Firestore.getAll must count each returned document once");
instrumentationProbes.push({ kind: "read", operation: "Firestore.getAll", observedSnapshots: counters.directReadDocuments, counterBoundary: "Firestore.getAll" });
resetCounters();
const writeProbeCollection = context.db.collection("users").doc(auth.userId).collection("cost02-write-probe");
await writeProbeCollection.doc("document-reference").set({ kind: "document-reference" });
assert.equal(counters.firestoreWrites, 1, "DocumentReference.set must count once at the successful SDK commit boundary");
assert.equal(counters.committedWriteOperations, 1);
instrumentationProbes.push({ kind: "write", operation: "DocumentReference.set", enqueued: counters.writeBatchEnqueuedWrites, committed: counters.firestoreWrites, commitCount: counters.successfulWriteCommits });
resetCounters();
const writeProbeBatch = context.db.batch();
writeProbeBatch.set(writeProbeCollection.doc("batch"), { kind: "batch" });
await writeProbeBatch.commit();
assert.equal(counters.firestoreWrites, 1, "WriteBatch.set must count once at the successful SDK commit boundary");
assert.equal(counters.committedWriteOperations, 1);
instrumentationProbes.push({ kind: "write", operation: "WriteBatch.set", enqueued: counters.writeBatchEnqueuedWrites, committed: counters.firestoreWrites, commitCount: counters.successfulWriteCommits });
resetCounters();
await context.db.runTransaction(async (transaction) => {
  transaction.set(writeProbeCollection.doc("transaction"), { kind: "transaction" });
});
assert.equal(counters.firestoreWrites, 1, "Transaction.set must count once through WriteBatch._commit");
assert.equal(counters.committedWriteOperations, 1);
assert.equal(counters.transactionCalls, 1);
assert.equal(counters.transactionAttempts, 1);
instrumentationProbes.push({ kind: "write", operation: "Transaction.set", enqueued: counters.writeBatchEnqueuedWrites, committed: counters.firestoreWrites, commitCount: counters.successfulWriteCommits, transactionAttempts: counters.transactionAttempts });
resetCounters();
await assert.rejects(context.db.runTransaction(async (transaction) => {
  transaction.set(writeProbeCollection.doc("aborted-transaction"), { kind: "aborted" });
  throw new Error("cost02_abort_probe");
}), /cost02_abort_probe/u);
assert.equal(counters.transactionAttempts, 1);
assert.equal(counters.writeBatchEnqueuedWrites, 1);
assert.equal(counters.firestoreWrites, 0, "aborted transaction callback must not count an uncommitted write");
assert.equal(counters.successfulWriteCommits, 0);
instrumentationProbes.push({ kind: "write", operation: "Transaction.set then callback abort", enqueued: counters.writeBatchEnqueuedWrites, committed: counters.firestoreWrites, commitCount: counters.successfulWriteCommits, transactionAttempts: counters.transactionAttempts });
resetCounters();
const retryProbeRef = writeProbeCollection.doc("transaction-retry");
let retryProbeCallbackAttempts = 0;
await context.db.runTransaction(async (transaction) => {
  retryProbeCallbackAttempts += 1;
  if (retryProbeCallbackAttempts === 1) {
    transaction.set(retryProbeRef, { attempt: retryProbeCallbackAttempts });
    throw Object.assign(new Error("cost02_fixture_aborted_retry_probe"), { code: 10 });
  }
  await transaction.get(retryProbeRef);
  transaction.set(retryProbeRef, { attempt: retryProbeCallbackAttempts });
});
const retryProbeCounters = { transactionCalls: counters.transactionCalls, transactionAttempts: counters.transactionAttempts,
  transactionRetries: counters.transactionAttempts - counters.transactionCalls, enqueued: counters.writeBatchEnqueuedWrites,
  committed: counters.firestoreWrites, committedOperations: counters.committedWriteOperations,
  successfulCommits: counters.successfulWriteCommits, batchResets: counters.writeBatchResetCount };
assert.equal(retryProbeCounters.transactionCalls, 1);
assert.equal(retryProbeCounters.transactionAttempts, 2, "retryable ABORTED callback must retry once through installed SDK");
assert.equal(retryProbeCounters.transactionRetries, 1);
assert.equal(retryProbeCounters.enqueued, 2, "both callback attempts must be visible as enqueued operations");
assert.equal(retryProbeCounters.committed, 1, "only the final transaction attempt is a committed write");
assert.equal(retryProbeCounters.committedOperations, 1);
assert.equal(retryProbeCounters.successfulCommits, 1);
assert.equal(retryProbeCounters.batchResets, 2, "SDK resets the WriteBatch before each callback attempt");
const retryProbeReadback = await retryProbeRef.get();
assert.equal(retryProbeReadback.get("attempt"), 2, "only the successful retry's final value may be stored");
instrumentationProbes.push({ kind: "write", operation: "Transaction.set with one SDK ABORTED retry", ...retryProbeCounters, finalReadbackAttempt: retryProbeReadback.get("attempt") });
await context.db.recursiveDelete(writeProbeCollection);
resetCounters();
const lifecycleTools = await import(pathToFileURL(resolve(frontendRoot, "scripts/qa/measureCost02LifecycleTriggers.mjs")).href);
const authSdkRpcLog = [];
const authFixture = lifecycleTools.createCost02FirebaseAuthClient({
  projectId: "demo-patternly-cost02-client",
  authOrigin: authEmulatorOrigin,
  onRpc: (call) => { counters.authSdkRpcAttempts += 1; authSdkRpcLog.push(call); },
});
await authFixture.auth.signIn(auth.email, "Patternly-test-123!");
assert.ok(authSdkRpcLog.length > 0, "instrumented Firebase Auth SDK transport must observe sign-in RPC");
assert.equal(authFixture.auth.getSnapshot()?.uid, auth.localId, "Firebase Auth SDK must sign in as the registered local Firebase identity");
assert.equal(await authFixture.auth.getAuthorizationGeneration(), 1, "Auth emulator token must carry authorization generation");
const authSignInSetupRoutes = authSdkRpcLog.map(({ route, method }) => ({ route, method }));
resetCounters();
const pkgService = new ContentPackageService(new FirestoreContentPackagePointerStore(context.db), signedPackage.storage);
await pkgService.publish(manifest, compressed);
const requestLog = [];
const api = createPatternlyApiClient({
  apiOrigin: "http://127.0.0.1:19001",
  allowLocalHttpForSimulator: true,
  getIdToken: async () => authFixture.auth.getIdToken(),
  getAppCheckToken: async () => TEST_APP_CHECK_TOKEN,
  fetchImplementation: async (url, init = {}) => {
    const parsed = new URL(String(url));
    const requestStartedAt = performance.now();
    counters.requestBodyBytes += typeof init.body === "string" ? Buffer.byteLength(init.body, "utf8") : 0;
    const route = parsed.hostname === "storage.googleapis.com" ? "fixture_download" : parsed.pathname;
    const isGcsFixture = route === "fixture_download";
    if (isGcsFixture) counters.gcsDownloadAttempts += 1;
    else counters.httpAttempts += 1;
    const logEntry = { method: init.method ?? "GET", route, status: null, requestBytes: typeof init.body === "string" ? Buffer.byteLength(init.body, "utf8") : 0 };
    requestLog.push(logEntry);
    const finishRequest = () => { logEntry.elapsedMs = performance.now() - requestStartedAt; };
    if (failNextSync && parsed.pathname === "/v1/progress/sync") { failNextSync = false; counters.httpErrors += 1; finishRequest(); throw new Error("cost02_transient_fixture_transport_failure"); }
    let response;
    if (parsed.hostname === "storage.googleapis.com") {
      const packagePath = parsed.pathname.split("/").slice(2).join("/");
      const bytes = signedPackage.bytes.get(packagePath);
      if (!bytes) { finishRequest(); counters.gcsDownloadErrors += 1; throw new Error("cost02_signed_download_fixture_missing"); }
      counters.signedPackageFixtureBytes += bytes.length;
      response = new Response(bytes, { status: 200, headers: { "content-type": "application/gzip" } });
    } else {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const injected = await context.app.inject({ method: init.method ?? "GET", url: parsed.pathname + parsed.search, headers: Object.fromEntries(new Headers(init.headers).entries()), ...(body === undefined ? {} : { payload: body }) });
      response = new Response(injected.body, { status: injected.statusCode, headers: { "content-type": String(injected.headers["content-type"] ?? "application/json") } });
    }
    const bodyBytes = Buffer.from(await response.clone().arrayBuffer()).length;
    counters.responseBodyBytes += bodyBytes;
    counters.httpStatuses[response.status] = (counters.httpStatuses[response.status] ?? 0) + 1;
    logEntry.status = response.status;
    logEntry.responseBytes = bodyBytes;
    if (isGcsFixture) {
      if (response.ok) counters.gcsDownloadSuccesses += 1;
      else counters.gcsDownloadErrors += 1;
    } else if (response.ok) counters.httpSuccesses += 1;
    else counters.httpErrors += 1;
    finishRequest();
    return response;
  },
});

const scenarios = [];
async function measure(name, metadata, work) {
  if (typeof metadata === "function") {
    work = metadata;
    metadata = { identity: name.endsWith("_guest") ? "guest" : "registered_account", source: "production account lifecycle helper" };
  }
  resetCounters();
  requestLog.length = 0;
  authSdkRpcLog.length = 0;
  const cpuStart = process.cpuUsage();
  const rssBeforeBytes = process.memoryUsage().rss;
  const start = performance.now();
  let result;
  let error = null;
  try { result = await work(); }
  catch (caught) { error = caught instanceof Error ? caught.message : "unknown"; }
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  const stats = {
    ...counters,
    appHttpAttempts: counters.httpAttempts,
    authSdkRequests: counters.authSdkRpcAttempts,
    authSdkRpcLog: [...authSdkRpcLog],
    requestsIncludingAuthSdk: counters.httpAttempts + counters.authSdkRpcAttempts,
    httpServiceTimeMsSum: requestLog.filter((call) => call.route !== "fixture_download").reduce((sum, call) => sum + (call.elapsedMs ?? 0), 0),
    httpServiceTimeMsMax: Math.max(0, ...requestLog.filter((call) => call.route !== "fixture_download").map((call) => call.elapsedMs ?? 0)),
    transactionRetries: counters.transactionAttempts - counters.transactionCalls,
    observedSdkReadDocuments: counters.queryDocuments + counters.directReadDocuments + counters.transactionReadDocuments,
    nodeCpuUserMs: cpu.user / 1000,
    nodeCpuSystemMs: cpu.system / 1000,
    rssBeforeBytes,
    rssAfterBytes: process.memoryUsage().rss,
    elapsedMs,
  };
  scenarios.push({ name, metadata, result: result === undefined ? null : result, error, metrics: stats, requests: [...requestLog] });
  return scenarios.at(-1);
};

async function resetAppStorage(accountId = null) {
  // A fresh storage instance separates Guest and bound-account observations.
  const next = new MemoryKeyValueStorage();
  installKeyValueStorageForTests(next);
  setActiveProfileLeaseForTests({ id: "cost02-matrix-profile", kind: "guest", accountId });
  await guest.provisionGuestInstallation({ async create() { return { installationId: "66666666-6666-4666-8666-666666666666", localDatasetId: "77777777-7777-4777-8777-777777777777" }; } });
  if (accountId) await guest.bindGuestInstallationToAccount(accountId);
  return next;
}
const completedSession = (id) => ({ ...session("completed", id), modeId: "coding-interview-guided-practice", configurationSnapshot: { kind: "practice" } });
const responseAttempt = (id, sessionId) => ({ ...attempt(id, sessionId), modeId: "coding-interview-guided-practice", response: { type: "choice_single", optionId: "a" } });

try {
  const seedHistory = async (size) => {
    const user = context.db.collection("users").doc(auth.userId);
    const records = user.collection("progress");
    await context.db.recursiveDelete(records);
    for (let start = 0; start < size; start += 400) {
      const batch = context.db.batch();
      for (let index = start; index < Math.min(start + 400, size); index += 1) {
        const targetId = `cost02-attempt-${String(index).padStart(5, "0")}`;
        const trackId = "coding-interview-dsa-problem-solving";
        const state = attemptState(targetId, trackId);
        const record = { kind: "item", recordType: "training_attempt", trackId, targetId, version: 1, fingerprint: createMergeRecordFingerprint({ recordId: targetId, recordType: "training_attempt", state, trackId }), state, lastMutationId: `cost02-mutation-${String(index).padStart(16, "0")}`, updatedAt: Timestamp.fromDate(new Date("2026-10-12T00:00:00.000Z")) };
        batch.set(records.doc(progressDocumentId(record)), record);
      }
      await batch.commit();
    }
    await user.collection("syncMetadata").doc("account").set({ accountRevision: size, generation: 0 });
  };

  for (const size of sizes) {
    await seedHistory(size);
    const row = await measure(`account_history_${size}`, { identity: "registered_account", historyRecords: size, source: "real APP adapter GET /v1/progress via app.inject and AdminSDK/Firestore emulator" }, async () => {
      const result = await api.getProgress();
      assert.equal(result.records.length, size);
      assert.equal(result.accountRevision, size);
      return { records: result.records.length, accountRevision: result.accountRevision, pages: requestLog.filter((call) => call.route === "/v1/progress").length };
    });
    assert.equal(row.error, null, `cost02_history_failed:${size}`);
  }

  await seedHistory(0);
  const me = await measure("account_me_refresh", { identity: "registered_account", source: "real APP adapter + backend route/store" }, async () => (await api.getMe()).user.id);
  assert.equal(me.result, auth.userId);
  const entitlements = await measure("account_entitlements_refresh", { identity: "registered_account", entitlementProvider: "explicit deterministic RevenueCat reader fixture" }, async () => {
    const value = await api.getEntitlements();
    return { entitlementCount: value.entitlements.length, serverObservedAt: value.serverObservedAt };
  });
  assert.equal(entitlements.error, null);
  entitlementState = "unavailable";
  const entitlementError = await measure("account_entitlements_provider_error", { identity: "registered_account", entitlementProvider: "fixture unavailable response" }, async () => api.getEntitlements());
  assert.ok(entitlementError.error || entitlementError.metrics.httpErrors > 0);
  entitlementState = "active";
  const packageResult = await measure("account_content_package_download", { identity: "registered_account", backendPath: "real content descriptor route + Firestore pointer; signed object transport intercepted by explicit GCS fixture", packageFixture: "versioned historical package fixture copied from patternly-content dist; read-only, not current APP-compatible acceptance or deployable content" }, async () => {
    const result = await api.getContentPackage(manifest.trackId, manifest.nodeId);
    assert.equal(result.status, 200);
    assert.deepEqual(Buffer.from(result.bytes), compressed);
    return { status: result.status, compressedBytes: result.bytes.length, fixtureDownloadBytes: counters.signedPackageFixtureBytes };
  });
  assert.equal(packageResult.error, null);
  assert.equal(signedPackage.calls.some((call) => call.operation === "sign"), true);

  await seedHistory(0);
  let appStorage = await resetAppStorage(null);
  const guestAnswerSession = { ...session("active", "cost02-guest-answer"), modeId: "coding-interview-guided-practice", configurationSnapshot: { kind: "practice" } };
  const guestAnswerId = "cost02-guest-answer-attempt";
  const guestAnswer = await measure("guest_local_answer_commit", { identity: "guest", storage: "production repositories over MemoryKeyValueStorage", networkExpected: false }, async () => {
    await commitTrainingSessionStart({ session: guestAnswerSession, draft: null, createdAt: guestAnswerSession.startedAt });
    await commitTrainingOutcome({ attempt: responseAttempt(guestAnswerId, guestAnswerSession.id), session: guestAnswerSession, reviews: [], createdAt: guestAnswerSession.startedAt });
    const records = (await accountData.buildAccountDataSnapshot(dataAdmission)).records;
    return { committedRecords: records.length, resultFinalized: false, localStorageKeys: appStorage.getAllKeys().length, localStorageWrites: appStorage.operations.filter((entry) => entry.kind === "write").length };
  });
  assert.equal(guestAnswer.error, null);
  assert.equal(guestAnswer.metrics.httpAttempts, 0, "Guest answer commit must not make backend calls");
  const guestCompletion = await measure("guest_local_completion_commit", { identity: "guest", storage: "production repositories over MemoryKeyValueStorage", networkExpected: false }, async () => {
    const finished = completedSession(guestAnswerSession.id);
    const result = createTrainingSessionResult({ id: `${finished.id}:result`, sessionId: finished.id, trackId: finished.trackId, totalOccurrences: 1, answeredOccurrenceIds: ["occurrence-1"], unansweredOccurrenceIds: [], completedAt: finished.completedAt, evidence: createFamilyEnvelope({ familyId: "coding_interview", details: { activeForegroundMs: 0, correctCount: 0, partialCount: 0, incorrectCount: 1, pointsEarned: 0, maxPoints: 1 } }) });
    await commitSessionCompletion(finished, result, finished.completedAt);
    return { resultFinalized: true, localStorageKeys: appStorage.getAllKeys().length, localStorageWrites: appStorage.operations.filter((entry) => entry.kind === "write").length };
  });
  assert.equal(guestCompletion.error, null);
  assert.equal(guestCompletion.metrics.httpAttempts, 0, "Guest completion commit must not make backend calls");

  appStorage = await resetAppStorage(auth.userId);
  await accountData.saveAccountSyncState({ ...await accountData.getAccountSyncState(dataAdmission), accountId: auth.userId, status: "synced", remoteAccountRevision: 0 }, dataAdmission);
  const accountAnswerSession = { ...session("active", "cost02-account-answer"), modeId: "coding-interview-guided-practice", configurationSnapshot: { kind: "practice" } };
  const accountAnswerId = "cost02-account-answer-attempt";
  const emptyRetry = await measure("account_empty_pending_retry_noop", { identity: "registered_account", syncState: "synced with no changed records" }, async () => {
    const result = await retryPendingAccountDataSync(api, auth.userId);
    assert.equal(result, null);
    return { result: "no_pending_sync" };
  });
  assert.equal(emptyRetry.error, null);
  assert.equal(emptyRetry.metrics.httpAttempts, 0);
  const accountAnswer = await measure("account_local_answer_commit", { identity: "registered_account", storage: "production repositories over MemoryKeyValueStorage", networkExpected: false }, async () => {
    await commitTrainingSessionStart({ session: accountAnswerSession, draft: null, createdAt: accountAnswerSession.startedAt });
    await commitTrainingOutcome({ attempt: responseAttempt(accountAnswerId, accountAnswerSession.id), session: accountAnswerSession, reviews: [], createdAt: accountAnswerSession.startedAt });
    const state = await accountData.getAccountSyncState(dataAdmission);
    assert.equal(state.status, "offlinePending", "production journal commit must retain pending bound-account work");
    const records = (await accountData.buildAccountDataSnapshot(dataAdmission)).records;
    return { committedRecords: records.length, outboxEntriesBeforeSync: state.outbox.length, resultFinalized: false, pendingStatus: state.status, localStorageKeys: appStorage.getAllKeys().length, localStorageWrites: appStorage.operations.filter((entry) => entry.kind === "write").length };
  });
  assert.equal(accountAnswer.error, null);
  assert.equal(accountAnswer.metrics.httpAttempts, 0, "account answer commit itself must not send network traffic");
  const accountCompletion = await measure("account_local_completion_commit", { identity: "registered_account", storage: "production repositories over MemoryKeyValueStorage", networkExpected: false }, async () => {
    const finished = completedSession(accountAnswerSession.id);
    const result = createTrainingSessionResult({ id: `${finished.id}:result`, sessionId: finished.id, trackId: finished.trackId, totalOccurrences: 1, answeredOccurrenceIds: ["occurrence-1"], unansweredOccurrenceIds: [], completedAt: finished.completedAt, evidence: createFamilyEnvelope({ familyId: "coding_interview", details: { activeForegroundMs: 0, correctCount: 0, partialCount: 0, incorrectCount: 1, pointsEarned: 0, maxPoints: 1 } }) });
    await commitSessionCompletion(finished, result, finished.completedAt);
    const state = await accountData.getAccountSyncState(dataAdmission);
    assert.equal(state.status, "offlinePending", "production completion journal must retain pending bound-account work");
    const snapshot = await accountData.buildAccountDataSnapshot(dataAdmission);
    assert.equal(snapshot.activeSession, false);
    assert.ok(snapshot.records.some((record) => record.recordType === "training_session_result" && record.recordId === `${finished.id}:result`));
    return { records: snapshot.records.length, outboxEntriesBeforeSync: state.outbox.length, resultFinalized: true, pendingStatus: state.status, localStorageKeys: appStorage.getAllKeys().length, localStorageWrites: appStorage.operations.filter((entry) => entry.kind === "write").length };
  });
  assert.equal(accountCompletion.error, null);
  assert.equal(accountCompletion.metrics.httpAttempts, 0, "local completion commit itself must not send network traffic");

  failNextSync = true;
  const failedSync = await measure("account_changed_sync_first_attempt_error", { identity: "registered_account", syncState: "offlinePending", trigger: "explicit retryPendingAccountDataSync call" }, async () => {
    const result = await retryPendingAccountDataSync(api, auth.userId);
    return { status: result?.status ?? null, lastFailureCode: result?.lastFailureCode ?? null, outboxEntries: (await accountData.getAccountSyncState(dataAdmission)).outbox.length };
  });
  assert.ok(failedSync.metrics.httpErrors > 0, JSON.stringify({ error: failedSync.error, result: failedSync.result, routes: failedSync.requests.map(({ method, route, status }) => ({ method, route, status })), appHttpAttempts: failedSync.metrics.appHttpAttempts }));
  assert.ok(failedSync.result.outboxEntries > 0);
  const retrySync = await measure("account_changed_sync_retry_success", { identity: "registered_account", syncState: "offlinePending", trigger: "explicit retryPendingAccountDataSync call after one injected transport failure" }, async () => {
    const result = await retryPendingAccountDataSync(api, auth.userId);
    const state = await accountData.getAccountSyncState(dataAdmission);
    return { status: result?.status ?? null, accountRevision: state.remoteAccountRevision, outboxEntries: state.outbox.length };
  });
  assert.equal(retrySync.error, null);
  assert.equal(retrySync.result.status, "synced");
  assert.equal(retrySync.result.outboxEntries, 0);

  const manualRetryNoop = await measure("account_retry_account_data_sync_current", { identity: "registered_account", syncState: "synced", trigger: "explicit retryAccountDataSync call" }, async () => {
    const result = await retryAccountDataSync(api, auth.userId);
    return { status: result.status, lastFailureCode: result.lastFailureCode };
  });
  assert.equal(manualRetryNoop.error, null);

  const lifecycleEvidence = await lifecycleTools.runCost02LifecycleTriggers({
    accountId: auth.userId,
    measure,
    identity: async () => {
      const current = await authFixture.auth.refreshAccountIdentity();
      if (!current) throw new Error("cost02_auth_identity_missing");
      await getMeWithExchangedSession({ api, auth: authFixture.auth, user: current, requiredAuthorizationGeneration: 1, canContinue: () => true, onExchangeStarting: () => { throw new Error("cost02_unexpected_session_exchange"); } });
      return { kind: "success", next: "authenticated" };
    },
    premium: async () => {
      const result = await api.getEntitlements();
      return result.entitlements.length > 0 ? "verified" : "denied";
    },
    recovery: async () => retryLearningPlanRecovery(api, auth.userId),
    coldStart: async () => {
      const restored = await authFixture.restart();
      if (!restored || restored.uid !== auth.localId) throw new Error("cost02_auth_sdk_restore_missing_user");
      const response = await getMeWithExchangedSession({ api, auth: authFixture.auth, user: restored, requiredAuthorizationGeneration: 1, canContinue: () => true, onExchangeStarting: () => { throw new Error("cost02_unexpected_session_exchange"); } });
      assert.equal(response.user.id, auth.userId, "cold restore must retain backend account mapping");
      const loaded = await loadAccountDataSession(api, auth.userId);
      assert.equal(loaded.status, "synced", "cold account bootstrap must complete production account data load");
      return { userId: response.user.id, accountDataStatus: loaded.status };
    },
  });
  const lifecycleRow = (name) => scenarios.find((scenario) => scenario.name === name);
  const coldLifecycle = lifecycleRow("cold_start_account");
  assert.ok(coldLifecycle && coldLifecycle.error === null, "cold bootstrap must finish through production Auth/API/account-data callbacks");
  assert.ok(coldLifecycle.metrics.authSdkRequests > 0, "cold SDK restore must perform emulator Auth RPC");
  assert.ok(coldLifecycle.requests.some((request) => request.route === "/v1/me") && coldLifecycle.requests.some((request) => request.route === "/v1/progress"), "cold bootstrap must call getMe and load account progress");
  const foregroundLifecycle = lifecycleRow("background_foreground_account");
  assert.ok(foregroundLifecycle && foregroundLifecycle.error === null, "foreground identity callback must succeed");
  assert.ok(foregroundLifecycle.metrics.authSdkRequests > 0, "foreground identity refresh must perform emulator Auth RPC");
  assert.ok(foregroundLifecycle.requests.some((request) => request.route === "/v1/me") && foregroundLifecycle.requests.some((request) => request.route === "/v1/entitlements"), "foreground must call real getMe and entitlement APIs");

  // Validate the stable machine-readable result shape before emitting any evidence.
  const schema = {
    type: "object", required: ["schema", "source", "runtime", "authSdk", "instrumentationProbes", "triggerEvidence", "lifecycleSummary", "scenarios", "flowObservations", "interpretation"], additionalProperties: false,
    properties: {
      schema: { const: "cost02-client-matrix-v1" },
      source: { type: "object", required: ["backendHead", "backendHarnessSha256", "frontendSha", "lifecycleHelperSha256", "packageFixtureSha256", "packageFixtureManifestSha256", "packageFixtureProvenanceSha256", "projectId"], additionalProperties: false, properties: { backendHead: { type: "string" }, backendHarnessSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, frontendSha: { type: "string", pattern: "^[a-f0-9]{40}$" }, lifecycleHelperSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, packageFixtureSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, packageFixtureManifestSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, packageFixtureProvenanceSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, projectId: { const: "demo-patternly-cost02-client" } } },
      runtime: { type: "object", required: ["node", "platform", "arch"], additionalProperties: true },
      authSdk: { type: "object", required: ["implementation", "secureStorePort", "signInSetupRoutes", "providerClaimsVerified", "tokenPayloadsCaptured"], additionalProperties: false, properties: { implementation: { type: "string" }, secureStorePort: { type: "string" }, signInSetupRoutes: { type: "array" }, providerClaimsVerified: { const: true }, tokenPayloadsCaptured: { const: false } } },
      instrumentationProbes: { type: "array", minItems: 7, items: { type: "object", required: ["kind", "operation"], properties: { kind: { enum: ["read", "write"] }, operation: { type: "string" } } } },
      triggerEvidence: { type: "object", required: ["coldStart", "warmStart", "foregroundIdle", "backgroundForeground", "reconnect", "nativeLaunch", "appStateNetInfo"], additionalProperties: false, properties: Object.fromEntries(["coldStart", "warmStart", "foregroundIdle", "backgroundForeground", "reconnect", "nativeLaunch", "appStateNetInfo"].map((key) => [key, { type: "string" }])) },
      lifecycleSummary: { type: "object", required: ["schema", "rows", "scope", "nativeColdStart", "nativeWarmStart", "providerNetworkTiming"], additionalProperties: false, properties: { schema: { const: "cost02-react-lifecycle-v1" }, rows: { type: "array" }, scope: { type: "string" }, nativeColdStart: { const: "NOT_MEASURED" }, nativeWarmStart: { const: "NOT_MEASURED" }, providerNetworkTiming: { const: "NOT_MEASURED" } } },
      scenarios: { type: "array", items: { type: "object", required: ["name", "metadata", "result", "error", "metrics", "requests"], additionalProperties: false, properties: { name: { type: "string" }, metadata: { type: "object" }, result: {}, error: { type: ["string", "null"] }, metrics: { type: "object" }, requests: { type: "array" } } } },
      flowObservations: { type: "array", items: { type: "object", required: ["id", "event", "audience", "requests", "authSdkRequests", "sampleCount", "firestoreReadsObserved", "firestoreReadsBillableEstimate", "missingPointReads", "queryCount", "emptyQueryCount", "queryReturnedDocuments", "indexEntryReads", "indexEntryReadStatus", "firestoreWrites", "firestoreDeletes", "requestBytes", "responseBytes", "gcsDownloads", "gcsDownloadAttempts", "gcsDownloadErrors", "gcsDownloadBytes", "httpServiceTimeMsSum", "httpServiceTimeMsMax", "requestServiceTimeMs", "evidenceRef", "estimateBoundary"], additionalProperties: false, properties: { id: { type: "string" }, event: { enum: ["session", "foreground", "answer", "completion", "premiumRefresh", "packageDownload"] }, audience: { enum: ["account", "guest"] }, requests: { type: "integer", minimum: 0 }, authSdkRequests: { type: "integer", minimum: 0 }, sampleCount: { const: 1 }, firestoreReadsObserved: { type: "integer", minimum: 0 }, firestoreReadsBillableEstimate: { type: "integer", minimum: 0 }, missingPointReads: { type: "integer", minimum: 0 }, queryCount: { type: "integer", minimum: 0 }, emptyQueryCount: { type: "integer", minimum: 0 }, queryReturnedDocuments: { type: "integer", minimum: 0 }, indexEntryReads: { type: "null" }, indexEntryReadStatus: { const: "NOT_MEASURED" }, firestoreWrites: { type: "integer", minimum: 0 }, firestoreDeletes: { type: "integer", minimum: 0 }, requestBytes: { type: "integer", minimum: 0 }, responseBytes: { type: "integer", minimum: 0 }, gcsDownloads: { type: "integer", minimum: 0 }, gcsDownloadAttempts: { type: "integer", minimum: 0 }, gcsDownloadErrors: { type: "integer", minimum: 0 }, gcsDownloadBytes: { type: "integer", minimum: 0 }, httpServiceTimeMsSum: { type: "number", minimum: 0 }, httpServiceTimeMsMax: { type: "number", minimum: 0 }, requestServiceTimeMs: { type: "number", minimum: 0 }, evidenceRef: { type: "string" }, estimateBoundary: { type: "string" } } } },
      interpretation: { type: "object", required: ["providerBillableUnits", "nativeStorage", "clientLifecycleTriggers", "packageTransport"], additionalProperties: false, properties: { providerBillableUnits: { const: "NOT_MEASURED" }, nativeStorage: { const: "NOT_MEASURED" }, clientLifecycleTriggers: { type: "string" }, packageTransport: { const: "GCS_SIGNED_URL_TRANSPORT_INTERCEPTED_BY_GCS_FIXTURE" } } },
    },
  };
  const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
  const flowObservations = scenarios.map((scenario) => {
    const m = scenario.metrics;
    const queryMinimumReads = m.queryResultSizes.reduce((sum, count) => sum + Math.max(1, count), 0);
    return {
      id: scenario.name,
      event: scenario.name.startsWith("account_history_") || scenario.name.includes("pending_retry") || scenario.name.includes("changed_sync") || scenario.name.includes("retry_account_data") ? "session"
        : scenario.name.includes("entitlements") ? "premiumRefresh"
          : scenario.name.includes("content_package") ? "packageDownload"
            : scenario.name.includes("local_answer") ? "answer"
              : scenario.name.includes("local_completion") ? "completion"
                : "foreground",
      audience: scenario.metadata.identity === "guest" ? "guest" : "account",
      requests: m.appHttpAttempts,
      authSdkRequests: m.authSdkRequests,
      sampleCount: 1,
      firestoreReadsObserved: m.observedSdkReadDocuments,
      firestoreReadsBillableEstimate: m.directReadDocuments + m.transactionReadDocuments + queryMinimumReads,
      missingPointReads: m.missingDocuments + m.transactionMissingDocuments,
      queryCount: m.sdkQueries,
      emptyQueryCount: m.queryResultSizes.filter((count) => count === 0).length,
      queryReturnedDocuments: m.queryDocuments,
      indexEntryReads: null,
      indexEntryReadStatus: "NOT_MEASURED",
      firestoreWrites: m.firestoreWrites,
      firestoreDeletes: m.firestoreDeletes,
      requestBytes: m.requestBodyBytes,
      responseBytes: m.responseBodyBytes,
      gcsDownloads: m.gcsDownloadSuccesses,
      gcsDownloadAttempts: m.gcsDownloadAttempts,
      gcsDownloadErrors: m.gcsDownloadErrors,
      gcsDownloadBytes: m.signedPackageFixtureBytes,
      httpServiceTimeMsSum: m.httpServiceTimeMsSum,
      httpServiceTimeMsMax: m.httpServiceTimeMsMax,
      requestServiceTimeMs: m.appHttpAttempts === 0 ? 0 : m.httpServiceTimeMsSum / m.appHttpAttempts,
      evidenceRef: `.agent/private/cost02-20261020/completion/client-matrix.json#/flowObservations/${scenario.name}`,
      estimateBoundary: "emulator SDK counters mapped to documented Firestore read units; not provider billed usage; index entry units unavailable",
    };
  });
  const measuredTrigger = "MEASURED_PRODUCTION_REACT_SIDECAR_WITH_LOCAL_APPSTATE_NETINFO_AND_REAL_AUTH_BACKEND_CALLBACKS";
  const lifecycleSummary = {
    schema: lifecycleEvidence.schema,
    rows: lifecycleEvidence.rows,
    scope: lifecycleEvidence.scope.replace("no native startup timings, Firebase client RPC or RevenueCat SDK proof", "Firebase client Auth RPC measured by the installed SDK FetchProvider loopback hook; native startup timings and RevenueCat SDK remain unmeasured"),
    nativeColdStart: "NOT_MEASURED",
    nativeWarmStart: "NOT_MEASURED",
    providerNetworkTiming: "NOT_MEASURED",
  };
  const output = {
    schema: "cost02-client-matrix-v1",
    source: { backendHead: (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), backendHarnessSha256: sha(await readFile(new URL(import.meta.url))), frontendSha, lifecycleHelperSha256: sha(await readFile(resolve(frontendRoot, "scripts/qa/measureCost02LifecycleTriggers.mjs"))), packageFixtureSha256: sha(compressed), packageFixtureManifestSha256: sha(await readFile(resolve(packageFixtureDirectory, "manifest.json"))), packageFixtureProvenanceSha256: sha(await readFile(resolve(packageFixtureDirectory, "provenance.json"))), projectId: "demo-patternly-cost02-client" },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    authSdk: { implementation: "production FirebaseAuthClient/Firebase SDK; @firebase/auth/internal FetchProvider hook observed loopback Auth Emulator only; restart restores persisted refresh token from in-memory SecureStore port", secureStorePort: "in-memory test port", signInSetupRoutes: authSignInSetupRoutes, providerClaimsVerified: true, tokenPayloadsCaptured: false },
    instrumentationProbes,
    triggerEvidence: { coldStart: measuredTrigger, warmStart: measuredTrigger, foregroundIdle: measuredTrigger, backgroundForeground: measuredTrigger, reconnect: measuredTrigger, nativeLaunch: "NOT_MEASURED", appStateNetInfo: "SIMULATED_EVENT_SOURCES" },
    lifecycleSummary,
    scenarios,
    flowObservations,
    interpretation: { providerBillableUnits: "NOT_MEASURED", nativeStorage: "NOT_MEASURED", clientLifecycleTriggers: "Production React sidecar/effects measured with simulated platform event sources and real emulator-backed API/Auth callbacks", packageTransport: "GCS_SIGNED_URL_TRANSPORT_INTERCEPTED_BY_GCS_FIXTURE" },
  };
  assert.equal(validate(output), true, JSON.stringify(validate.errors));
  console.log(JSON.stringify(output));
} finally {
  Query.prototype.get = originalQueryGet;
  Transaction.prototype.get = originalTransactionGet;
  Transaction.prototype.getAll = originalTransactionGetAll;
  for (const key of Object.keys(originalBatchWrites)) WriteBatch.prototype[key] = originalBatchWrites[key];
  WriteBatch.prototype._commit = originalBatchCommitInternal;
  WriteBatch.prototype._reset = originalBatchReset;
  context.db.getAll = originalDbGetAll;
  context.db.runTransaction = originalRunTransaction;
  await authFixture.close();
  await context.close();
}
