import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Query, Timestamp, Transaction } from "firebase-admin/firestore";
import { createEmulatorContext, createRegisteredAuthUser, TEST_APP_CHECK_TOKEN } from "../../tests/support.js";
import { progressDocumentId } from "../../src/infrastructure/firestore/paths.js";
import { createMergeRecordFingerprint } from "../../src/modules/users/merge.js";
import { canonicalJson } from "../../src/infrastructure/identity/canonicalJson.js";
import { progressMutationSchema, type ProgressRecord } from "../../src/modules/progress/contracts.js";
import { attemptState } from "../../tests/progressFixtures.js";
import { validateIsolatedEmulatorRuntime } from "../isolated-emulator-test-runner.mjs";

validateIsolatedEmulatorRuntime(process.env, "demo-patternly-perf05-measure");
const sizes = (process.env.PERF05_SIZES ?? "0,100,1000,10000").split(",").map(Number);
if (sizes.some((size) => ![0, 100, 1000, 10000].includes(size))) throw new Error("paging_measure_size_invalid");
const context = createEmulatorContext();
let queries = 0;
let documents = 0;
let directReadCalls = 0;
let directReadDocuments = 0;
let missingDocuments = 0;
let transactionReadDocuments = 0;
let transactionMissingDocuments = 0;
let transactionCalls = 0;
let transactionAttempts = 0;
const originalGet = Query.prototype.get;
const originalGetAll = context.db.getAll.bind(context.db);
const originalTransactionGet = Transaction.prototype.get;
const originalTransactionGetAll = Transaction.prototype.getAll;
const originalRunTransaction = context.db.runTransaction.bind(context.db);
const countTransactionSnapshots = (value: unknown): void => {
  const snapshots = Array.isArray(value) ? value : [value];
  for (const snapshot of snapshots) {
    assert.ok(snapshot && typeof snapshot.exists === "boolean", "paging_measure_document_snapshot_required");
    transactionReadDocuments++;
    if (!snapshot.exists) transactionMissingDocuments++;
  }
};
Transaction.prototype.get = (async function (this: Transaction, ...args: unknown[]) {
  const snapshot: unknown = await Reflect.apply(originalTransactionGet, this, args);
  countTransactionSnapshots(snapshot);
  return snapshot;
}) as typeof Transaction.prototype.get;
Transaction.prototype.getAll = (async function (this: Transaction, ...args: unknown[]) {
  const snapshots: unknown = await Reflect.apply(originalTransactionGetAll, this, args);
  countTransactionSnapshots(snapshots);
  return snapshots;
}) as typeof Transaction.prototype.getAll;
context.db.runTransaction = (async (callback: (transaction: Transaction) => Promise<unknown>, ...options: unknown[]) => {
  transactionCalls++;
  return Reflect.apply(originalRunTransaction, context.db, [async (transaction: Transaction) => {
    transactionAttempts++;
    return callback(transaction);
  }, ...options]);
}) as typeof context.db.runTransaction;
context.db.getAll = (async (...references: Parameters<typeof context.db.getAll>) => {
  const snapshots = await originalGetAll(...references);
  directReadCalls++;
  directReadDocuments += snapshots.length;
  missingDocuments += snapshots.filter((snapshot) => !snapshot.exists).length;
  return snapshots;
}) as typeof context.db.getAll;
Query.prototype.get = async function () {
  const snapshot = await originalGet.call(this);
  queries++;
  documents += snapshot.size;
  return snapshot;
};
const digest = (records: readonly ProgressRecord[]) => createHash("sha256").update(canonicalJson([...records].sort((a, b) => a.targetId.localeCompare(b.targetId)))).digest("hex");
const stats = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * .95) - 1] }; };
const output: unknown[] = [];
try {
  const auth = await createRegisteredAuthUser(context);
  const user = context.db.collection("users").doc(auth.userId);
  const collection = user.collection("progress");
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  for (const size of sizes) {
    await context.db.recursiveDelete(collection);
    const records: ProgressRecord[] = [];
    for (let start = 0; start < size; start += 400) {
      const batch = context.db.batch();
      for (let index = start; index < Math.min(start + 400, size); index++) {
        const targetId = `attempt-${String(index).padStart(5, "0")}`;
        const trackId = "coding-interview-dsa-problem-solving";
        const state = attemptState(targetId, trackId);
        const record = { kind: "item" as const, recordType: "training_attempt" as const, trackId, targetId, version: 1, fingerprint: createMergeRecordFingerprint({ recordId: targetId, recordType: "training_attempt", state, trackId }), state, lastMutationId: `mutation-${String(index).padStart(16, "0")}`, updatedAt: "2026-10-12T00:00:00.000Z" };
        progressMutationSchema.parse({ mutationId: record.lastMutationId, expectedVersion: null, kind: record.kind, recordType: record.recordType, trackId: record.trackId, targetId: record.targetId, fingerprint: record.fingerprint, state: record.state });
        records.push(record);
        batch.set(collection.doc(progressDocumentId(record)), { ...record, updatedAt: Timestamp.fromDate(new Date(record.updatedAt)) });
      }
      await batch.commit();
    }
    await user.collection("syncMetadata").doc("account").set({ accountRevision: size, generation: 0 });
    const sweep = async (onePage: boolean) => {
      queries = 0; documents = 0;
      directReadCalls = 0; directReadDocuments = 0; missingDocuments = 0;
      transactionReadDocuments = 0; transactionMissingDocuments = 0; transactionCalls = 0; transactionAttempts = 0;
      const collected: ProgressRecord[] = [];
      let token: string | null = null; let pages = 0;
      let responseBodyBytes = 0;
      const cpuStart = process.cpuUsage();
      const rssBeforeBytes = process.memoryUsage().rss;
      let sampledRssMaxBytes = rssBeforeBytes;
      const began = performance.now();
      do {
        const response: Awaited<ReturnType<typeof context.app.inject>> = await context.app.inject({ method: "GET", url: `/v1/progress?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`, headers });
        assert.equal(response.statusCode, 200, `paging_measure_http_${response.statusCode}`);
        responseBodyBytes += Buffer.byteLength(response.body, "utf8");
        sampledRssMaxBytes = Math.max(sampledRssMaxBytes, process.memoryUsage().rss);
        const body = response.json();
        assert.equal(body.accountRevision, size);
        assert.equal(body.generation, 0);
        assert.ok(body.records.length <= 100);
        collected.push(...body.records);
        token = body.nextPageToken;
        pages++;
        assert.ok(pages <= Math.ceil(size / 100) + 1);
      } while (token && !onePage);
      const elapsedMs = performance.now() - began;
      const cpu = process.cpuUsage(cpuStart);
      if (!onePage) { assert.equal(collected.length, size); assert.equal(digest(collected), digest(records)); }
      const expectedPages = onePage ? 1 : Math.max(1, Math.ceil(size / 100));
      const expectedQueryDocuments = onePage ? Math.min(size, 101) : size + expectedPages - 1;
      assert.equal(pages, expectedPages);
      assert.equal(queries, pages);
      assert.equal(documents, expectedQueryDocuments);
      // Route metadata and transactional auth reads use distinct SDK methods.
      assert.equal(directReadDocuments, 4 * pages);
      assert.ok(transactionReadDocuments >= 3 * pages);
      return { elapsedMs, queries, documents, pages, directReadCalls, directReadDocuments, missingDocuments,
        transactionReadDocuments, transactionMissingDocuments, transactionCalls, transactionAttempts,
        transactionRetries: transactionAttempts - transactionCalls,
        observedDocumentReads: documents + directReadDocuments + transactionReadDocuments, responseBodyBytes,
        nodeCpuUserMs: cpu.user / 1000, nodeCpuSystemMs: cpu.system / 1000,
        rssBeforeBytes, sampledRssMaxBytes, outputHash: digest(collected) };
    };
    await sweep(true);
    const first = []; for (let sample = 0; sample < 7; sample++) first.push(await sweep(true));
    await sweep(false);
    const full = []; for (let sample = 0; sample < 3; sample++) full.push(await sweep(false));
    output.push({ size, inputHash: digest(records), first: { samples: first, timingMs: stats(first.map((x) => x.elapsedMs)) }, full: { samples: full, timingMs: stats(full.map((x) => x.elapsedMs)) } });
    console.log(JSON.stringify({ stage: "size_complete", size }));
  }
  console.log(JSON.stringify({ schema: "cost02-sdk-route-measure-v2", pageSize: 100, firstSamples: 7, sweepSamples: 3, warmups: 1,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    scope: "Backend injected HTTP route + Admin SDK + Auth/Firestore emulators; deterministic attempt fixture seeded outside samples; no APP/native start, socket HTTP or provider measurement",
    counts: "Query.get returned documents plus Firestore.getAll and Transaction.get/getAll snapshots (missing included separately); transaction callbacks count attempts/retries. Not provider billable units. Read-only route/auth transactions; fixture writes excluded. Auth SDK RPCs, gRPC bytes, headers, TLS and index billing unmeasured.",
    resources: "CPU and sampled RSS cover only this Node process, not emulator JVM/Auth processes; RSS is sampled at page boundaries, not a measured peak. Warm local timings, not Cloud Run cold-start, p95 SLO or capacity evidence.",
    measurements: output }));
} finally {
  Query.prototype.get = originalGet;
  context.db.getAll = originalGetAll;
  context.db.runTransaction = originalRunTransaction;
  Transaction.prototype.get = originalTransactionGet;
  Transaction.prototype.getAll = originalTransactionGetAll;
  await context.close();
}
