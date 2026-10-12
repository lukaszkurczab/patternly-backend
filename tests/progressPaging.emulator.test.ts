import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Query, Timestamp } from "firebase-admin/firestore";
import { FirestoreProgressStore } from "../src/modules/progress/store.js";
import { createProgressPageToken, parseProgressPageToken, type ProgressMutation, type ProgressPageToken } from "../src/modules/progress/contracts.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { progressDocumentId } from "../src/infrastructure/firestore/paths.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("firebase_emulator_suite_required");
const app = initializeApp({ projectId: "demo-patternly-paging-tests" }, `paging-${randomUUID()}`);
const db = getFirestore(app);
const store = new FirestoreProgressStore(db);
const accounts: string[] = [];
const deviceId = "00000000-0000-4000-8000-000000000000";
const mutation = (index: number): ProgressMutation => {
  const state = { result: "correct", index };
  const targetId = `attempt-${String(index).padStart(5, "0")}`;
  const trackId = "coding-interview-dsa-problem-solving";
  return { mutationId: `mutation-${String(index).padStart(16, "0")}`, kind: "item", recordType: "training_attempt", trackId, targetId, expectedVersion: null, state, fingerprint: createMergeRecordFingerprint({ recordId: targetId, recordType: "training_attempt", trackId, state }) };
};
async function account(count = 2) {
  const userId = randomUUID(); accounts.push(userId);
  await db.collection("users").doc(userId).create({ id: userId, authorizationGeneration: 1 });
  let revision = 0;
  for (let start = 0; start < count; start += 100) {
    const mutations = Array.from({ length: Math.min(100, count - start) }, (_, offset) => mutation(start + offset));
    const result = await store.applyBatch(userId, 1, deviceId, revision, mutations, { sessionId: "paging-session", batchId: `paging-batch-${start}`, highWatermark: start + 1 });
    assert.equal(result.accountRevisionConflict, undefined);
    assert.equal(result.applied.length, mutations.length);
    revision = result.accountRevision;
  }
  return userId;
}
const meta = (userId: string) => db.collection("users").doc(userId).collection("syncMetadata").doc("account");
async function duringQuery(effect: () => Promise<unknown>, when: "before" | "after", work: () => Promise<unknown>) {
  const original = Query.prototype.get;
  let fired = false;
  Query.prototype.get = async function () {
    if (fired) return original.call(this);
    fired = true;
    if (when === "before") await effect();
    const snapshot = await original.call(this);
    if (when === "after") await effect();
    return snapshot;
  };
  try { await work(); assert.equal(fired, true); } finally { Query.prototype.get = original; }
}
test.after(async () => {
  for (const userId of accounts) await db.recursiveDelete(db.collection("users").doc(userId));
  await db.terminate(); await deleteApp(app);
});

test("bounded pages sweep canonical producer records exactly once in document-ID order", async () => {
  const userId = await account(205);
  const expected = Array.from({ length: 205 }, (_, index) => mutation(index)).sort((a, b) => progressDocumentId(a).localeCompare(progressDocumentId(b))).map((record) => record.targetId);
  const actual: string[] = []; let token: ProgressPageToken | null = null;
  const reads: number[] = []; const original = Query.prototype.get;
  const originalAll = db.getAll.bind(db); let metadataReads = 0;
  db.getAll = ((...references: Parameters<typeof db.getAll>) => { metadataReads += references.length; return originalAll(...references); }) as typeof db.getAll;
  Query.prototype.get = async function () { const snapshot = await original.call(this); reads.push(snapshot.size); return snapshot; };
  try {
    do {
      const page = await store.readPage(userId, 1, 100, token);
      assert.equal(page.accountRevision, 205); assert.equal(page.generation, 0);
      actual.push(...page.records.map((record) => record.targetId));
      token = page.nextPageToken === null ? null : parseProgressPageToken(page.nextPageToken);
    } while (token);
  } finally { Query.prototype.get = original; db.getAll = originalAll; }
  assert.equal(metadataReads, 3 * 4);
  assert.deepEqual(actual, expected); assert.equal(new Set(actual).size, 205);
  assert.deepEqual(reads, [101, 101, 5]);
});

test("empty and exact-page boundaries finish without empty sentinel pages", async () => {
  for (const count of [0, 1, 100]) {
    const page = await store.readPage(await account(count), 1, 100, null);
    assert.equal(page.records.length, count); assert.equal(page.nextPageToken, null);
  }
});

test("tokens reject account/revision/generation changes and absent cursor", async () => {
  const userId = await account();
  const first = await store.readPage(userId, 1, 1, null);
  const token = parseProgressPageToken(first.nextPageToken!);
  for (const changed of [{ ...token, userId: randomUUID() }, { ...token, accountRevision: token.accountRevision + 1 }, { ...token, generation: 1 }, { ...token, cursor: "f".repeat(64) }]) {
    await assert.rejects(() => store.readPage(userId, 1, 1, parseProgressPageToken(createProgressPageToken(changed))), /progress_generation_conflict/u);
  }
});

test("bounded read rejects canonical writes on both sides of the query", async () => {
  for (const when of ["before", "after"] as const) {
    const userId = await account();
    await duringQuery(async () => {
      const result = await store.applyBatch(userId, 1, deviceId, 2, [mutation(3)], { sessionId: "race-session", batchId: "race-batch", highWatermark: 1 });
      assert.equal(result.applied.length, 1);
      assert.equal(result.accountRevision, 3);
    }, when,
      () => assert.rejects(() => store.readPage(userId, 1, 1, null), /progress_generation_conflict/u));
  }
});

test("readback rejects generation, metadata, lease, revocation and deletion races", async () => {
  const cases = [
    { name: "generation", change: async (id: string) => meta(id).update({ generation: 1, accountRevision: 2 }), error: /progress_generation_conflict/u },
    { name: "same-revision metadata rewrite", change: async (id: string) => meta(id).update({ marker: randomUUID() }), error: /progress_generation_conflict/u },
    { name: "lease", change: async (id: string) => meta(id).update({ adoptionPromotionSessionId: "race", adoptionPromotionLeaseExpiresAt: Timestamp.fromMillis(Date.now() + 60_000) }), error: /progress_generation_conflict/u },
    { name: "authorization", change: async (id: string) => db.collection("users").doc(id).update({ authorizationGeneration: 2 }), error: /authorization_generation_conflict/u },
    { name: "deactivated", change: async (id: string) => db.collection("users").doc(id).update({ authorizationState: "revoked" }), error: /account_deleted/u },
    { name: "deleted", change: async (id: string) => db.collection("users").doc(id).delete(), error: /account_deleted/u },
  ];
  for (const row of cases) {
    for (const when of ["before", "after"] as const) {
      const userId = await account();
      await duringQuery(() => row.change(userId), when, () => assert.rejects(() => store.readPage(userId, 1, 1, null), row.error, `${row.name}/${when}`));
    }
  }
});

test("an active promotion lease blocks before querying progress", async () => {
  const userId = await account();
  await meta(userId).update({ adoptionPromotionSessionId: "promotion", adoptionPromotionLeaseExpiresAt: Timestamp.fromMillis(Date.now() + 60_000) });
  const original = Query.prototype.get; let queries = 0;
  Query.prototype.get = async function () { queries++; return original.call(this); };
  try { await assert.rejects(() => store.readPage(userId, 1, 1, null), /progress_generation_conflict/u); } finally { Query.prototype.get = original; }
  assert.equal(queries, 0);
});

test("strict page validation rejects malformed or fingerprint-corrupt records", async () => {
  for (const patch of [{ fingerprint: "a".repeat(64) }, { lastMutationId: null }]) {
    const userId = await account(1);
    await db.collection("users").doc(userId).collection("progress").doc(progressDocumentId(mutation(0))).update(patch);
    await assert.rejects(() => store.readPage(userId, 1, 100, null), /progress_(fingerprint_mismatch|record_invalid)/u);
  }
});
