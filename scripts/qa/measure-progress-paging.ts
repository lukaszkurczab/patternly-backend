import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Query, Timestamp } from "firebase-admin/firestore";
import { createEmulatorContext, createRegisteredAuthUser, TEST_APP_CHECK_TOKEN } from "../../tests/support.js";
import { progressDocumentId } from "../../src/infrastructure/firestore/paths.js";
import { createMergeRecordFingerprint } from "../../src/modules/users/merge.js";
import { canonicalJson } from "../../src/infrastructure/identity/canonicalJson.js";
import { progressMutationSchema, type ProgressRecord } from "../../src/modules/progress/contracts.js";

if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:18119" || process.env.FIREBASE_PROJECT_ID !== "demo-patternly-perf05-measure") throw new Error("paging_measure_isolated_emulator_required");
const sizes = (process.env.PERF05_SIZES ?? "100,1000,10000").split(",").map(Number);
if (sizes.some((size) => ![100, 1000, 10000].includes(size))) throw new Error("paging_measure_size_invalid");
const context = createEmulatorContext();
let queries = 0;
let documents = 0;
const originalGet = Query.prototype.get;
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
        const state = { result: "correct", index };
        const targetId = `attempt-${String(index).padStart(5, "0")}`;
        const trackId = "coding-interview-dsa-problem-solving";
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
      const collected: ProgressRecord[] = [];
      let token: string | null = null; let pages = 0;
      const began = performance.now();
      do {
        const response: Awaited<ReturnType<typeof context.app.inject>> = await context.app.inject({ method: "GET", url: `/v1/progress?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`, headers });
        assert.equal(response.statusCode, 200, `paging_measure_http_${response.statusCode}`);
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
      if (!onePage) { assert.equal(collected.length, size); assert.equal(digest(collected), digest(records)); }
      return { elapsedMs, queries, documents, pages, outputHash: digest(collected) };
    };
    await sweep(true);
    const first = []; for (let sample = 0; sample < 7; sample++) first.push(await sweep(true));
    await sweep(false);
    const full = []; for (let sample = 0; sample < 3; sample++) full.push(await sweep(false));
    output.push({ size, inputHash: digest(records), first: { samples: first, timingMs: stats(first.map((x) => x.elapsedMs)) }, full: { samples: full, timingMs: stats(full.map((x) => x.elapsedMs)) } });
    console.log(JSON.stringify({ stage: "size_complete", size }));
  }
  console.log(JSON.stringify({ schema: "perf05-sdk-route-measure-v1", pageSize: 100, firstSamples: 7, sweepSamples: 3, warmups: 1, counts: "Query.get returned documents, not billing units; route auth/metadata excluded", measurements: output }));
} finally {
  Query.prototype.get = originalGet;
  await context.close();
}
