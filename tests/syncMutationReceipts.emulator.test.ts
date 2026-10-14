import { attemptState, reviewState } from "./progressFixtures.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { progressDocumentId } from "../src/infrastructure/firestore/paths.js";
import type { ProgressMutation } from "../src/modules/progress/contracts.js";
import { FirestoreProgressStore } from "../src/modules/progress/store.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { createEmulatorContext, createVerifiedRegisteredAuthUser, TEST_APP_CHECK_TOKEN } from "./support.js";

const context = createEmulatorContext();
const db = context.db;
const store = new FirestoreProgressStore(db);
const accounts: string[] = [];
const deviceId = "00000000-0000-4000-8000-000000000000";
const bindingKeys = ["fingerprint", "targetId", "recordType", "trackId"] as const;

async function account() {
  const userId = randomUUID();
  accounts.push(userId);
  await db.collection("users").doc(userId).create({ id: userId });
  return userId;
}

function mutation(overrides: Partial<ProgressMutation> = {}): ProgressMutation {
  const base = { mutationId: `mutation-${randomUUID()}`, kind: "item" as const, recordType: "training_attempt" as const, trackId: "coding-interview-dsa-problem-solving", targetId: "attempt-a", expectedVersion: null, state: { answer: "Cafe\u0301" }, ...overrides };
  const answer = typeof base.state.answer === "string" ? base.state.answer : (base.state.response as { optionId?: string } | undefined)?.optionId ?? "Cafe\u0301";
  const state = base.recordType === "review_queue_entry" ? reviewState(base.targetId, base.trackId) : attemptState(base.targetId, base.trackId, answer);
  return { ...base, state, fingerprint: createMergeRecordFingerprint({ recordId: base.targetId, recordType: base.recordType, trackId: base.trackId, state }) };
}

const metadata = () => ({ sessionId: "receipt-session", batchId: randomUUID(), highWatermark: 1 });
const userRef = (id: string) => db.collection("users").doc(id);
const receiptRef = (id: string, value: ProgressMutation) => userRef(id).collection("syncMutations").doc(value.mutationId);
const progressRef = (id: string, value: ProgressMutation) => userRef(id).collection("progress").doc(progressDocumentId(value));
async function persisted(id: string) {
  const rows = await Promise.all(["progress", "syncMutations", "syncBatches", "syncMetadata"].map(async (collection) =>
    (await userRef(id).collection(collection).orderBy("__name__").get()).docs.map((document) => [document.id, document.data()])));
  return rows;
}
async function assertNoWrite(id: string, operation: () => Promise<unknown>) {
  const before = await persisted(id);
  await operation();
  assert.deepEqual(await persisted(id), before, "progress, revisions, receipts and batches must stay unchanged");
}
function assertBinding(data: Record<string, unknown> | undefined, value: ProgressMutation) {
  assert.ok(data);
  for (const key of bindingKeys) assert.equal(data[key], value[key], key);
  assert.ok(data.createdAt instanceof Timestamp);
  assert.ok(data.expiresAt instanceof Timestamp);
  assert.equal(data.expiresAt.toMillis() - data.createdAt.toMillis(), 30 * 24 * 60 * 60 * 1_000);
}

test.after(async () => {
  for (const id of accounts) await db.recursiveDelete(userRef(id));
  await context.close();
});

test("A → retry A in another batch → changed B rejects atomically for every binding", async () => {
  const id = await account();
  const a = mutation();
  const first = await store.applyBatch(id, 1, deviceId, 0, [a], metadata());
  assert.equal(first.applied.length, 1);
  const receipt = (await receiptRef(id, a).get()).data();
  assertBinding(receipt, a);
  const retry = await store.applyBatch(id, 1, deviceId, 0, [a], metadata());
  assert.deepEqual(retry.duplicates, [a.mutationId]);
  assert.deepEqual(retry.applied, []);
  assert.equal(retry.accountRevision, 1);
  assert.deepEqual((await receiptRef(id, a).get()).data(), receipt, "retry must not renew TTL");
  for (const change of [{ state: { answer: "changed" } }, { targetId: "attempt-b" }, { recordType: "review_queue_entry" as const }, { trackId: "backend-system-design-interview" }]) {
    const b = mutation({ ...a, ...change });
    await assertNoWrite(id, () => assert.rejects(store.applyBatch(id, 1, deviceId, 1, [mutation({ targetId: randomUUID() }), b], metadata()), /mutation_id_reuse/u));
  }
});

test("full receipt proves old A after newer C or absent current record, without rewriting progress", async () => {
  const id = await account();
  const a = mutation();
  await store.applyBatch(id, 1, deviceId, 0, [a], metadata());
  const c = mutation({ targetId: a.targetId, expectedVersion: 1, state: { answer: "newer" } });
  await store.applyBatch(id, 1, deviceId, 1, [c], metadata());
  for (const removeCurrent of [false, true]) {
    if (removeCurrent) await progressRef(id, a).delete(); // fixture only: receipt remains authoritative
    const before = await store.readSnapshot(id);
    const retry = await store.applyBatch(id, 1, deviceId, 0, [a], metadata());
    assert.deepEqual(retry.duplicates, [a.mutationId]);
    assert.deepEqual(retry.applied, []);
    assert.deepEqual(await store.readSnapshot(id), before);
  }
});

test("every incomplete legacy binding needs an exact lastMutationId witness and is preserved", async () => {
  for (let mask = 0; mask < 15; mask++) {
    const id = await account();
    const a = mutation();
    await store.applyBatch(id, 1, deviceId, 0, [a], metadata());
    const full = (await receiptRef(id, a).get()).data()!;
    const legacy = { ...full };
    bindingKeys.forEach((key, index) => { if (!(mask & (1 << index))) delete legacy[key]; });
    if (mask === 0) delete legacy.expiresAt; // historical rows without TTL are not backfilled
    await receiptRef(id, a).set(legacy);
    const retry = await store.applyBatch(id, 1, deviceId, 0, [a], metadata());
    assert.deepEqual(retry.duplicates, [a.mutationId], `mask ${mask}`);
    assert.deepEqual(retry.applied, []);
    assert.equal(retry.accountRevision, 1);
    assert.deepEqual((await receiptRef(id, a).get()).data(), legacy);
    // Equal content with another lastMutationId still cannot resolve an old receipt.
    await progressRef(id, a).update({ lastMutationId: "some-other-mutation" });
    await assertNoWrite(id, () => assert.rejects(store.applyBatch(id, 1, deviceId, 1, [a], metadata()), /mutation_id_reuse/u));
    await progressRef(id, a).delete();
    await assertNoWrite(id, () => assert.rejects(store.applyBatch(id, 1, deviceId, 1, [a], metadata()), /mutation_id_reuse/u));
  }
});

test("present contradictory legacy fields cannot be rescued by a matching current record", async () => {
  for (const key of bindingKeys) {
    const id = await account();
    const a = mutation();
    await store.applyBatch(id, 1, deviceId, 0, [a], metadata());
    const full = (await receiptRef(id, a).get()).data()!;
    const partial = { ...full };
    delete partial[bindingKeys.find((candidate) => candidate !== key)!];
    partial[key] = null;
    await receiptRef(id, a).set(partial);
    await assertNoWrite(id, () => assert.rejects(store.applyBatch(id, 1, deviceId, 1, [a], metadata()), /mutation_id_reuse/u));
  }
});

test("TTL-removed receipt: exact surviving A deduplicates without recreating it; superseded A conflicts", async () => {
  const id = await account();
  const a = mutation();
  await store.applyBatch(id, 1, deviceId, 0, [a], metadata());
  await receiptRef(id, a).update({ expiresAt: Timestamp.fromMillis(1) });
  const expired = (await receiptRef(id, a).get()).data();
  const beforeDeletion = await store.applyBatch(id, 1, deviceId, 0, [a], metadata());
  assert.deepEqual(beforeDeletion.duplicates, [a.mutationId]);
  assert.deepEqual((await receiptRef(id, a).get()).data(), expired, "elapsed TTL never deletes or renews identity evidence on read");
  await receiptRef(id, a).delete(); // simulate eventual TTL; emulator does not run managed TTL
  const retry = await store.applyBatch(id, 1, deviceId, 0, [a], metadata());
  assert.deepEqual(retry.duplicates, [a.mutationId]);
  assert.deepEqual(retry.applied, []);
  assert.equal((await receiptRef(id, a).get()).exists, false);
  const c = mutation({ expectedVersion: 1, state: { answer: "later" } });
  await store.applyBatch(id, 1, deviceId, 1, [c], metadata());
  await assertNoWrite(id, async () => {
    const rejected = await store.applyBatch(id, 1, deviceId, 2, [a], metadata());
    assert.deepEqual(rejected.applied, []);
    assert.deepEqual(rejected.duplicates, []);
    assert.equal(rejected.conflicts[0]?.code, "version_conflict");
  });
  await progressRef(id, a).delete();
  await assertNoWrite(id, async () => {
    const rejected = await store.applyBatch(id, 1, deviceId, 0, [a], metadata());
    assert.deepEqual(rejected.applied, []);
    assert.deepEqual(rejected.duplicates, []);
    assert.equal(rejected.accountRevisionConflict?.code, "account_revision_conflict", "an unchanged retry cannot recreate an absent target after its receipt disappears");
  });
});

test("one-shot adoption writes full immutable receipts reusable by ordinary sync", async () => {
  const id = await account();
  const a = mutation();
  const snapshot = { guestSnapshotVersion: 1, guestUserId: randomUUID(), activeSession: false, pendingJournal: false,
    records: [{ recordId: a.targetId, recordType: a.recordType, trackId: a.trackId, state: a.state, fingerprint: a.fingerprint, version: 0 }] };
  const preview = await store.previewAdoption(id, snapshot);
  const confirmation = { operationId: preview.preview.operationId, previewFingerprint: preview.preview.fingerprint, resolutions: [], groupChoices: [] };
  const first = await store.confirmAdoption(id, 1, deviceId, snapshot, confirmation);
  const adopted = { ...a, mutationId: first.mutationIds[0]! };
  const receipt = (await receiptRef(id, adopted).get()).data();
  assertBinding(receipt, adopted);
  assert.deepEqual(await store.confirmAdoption(id, 1, deviceId, snapshot, confirmation), first);
  assert.deepEqual((await receiptRef(id, adopted).get()).data(), receipt);
  const retry = await store.applyBatch(id, 1, deviceId, 0, [adopted], metadata());
  assert.deepEqual(retry.duplicates, [adopted.mutationId]);
  const b = mutation({ ...adopted, trackId: "backend-system-design-interview" });
  await assertNoWrite(id, () => assert.rejects(store.applyBatch(id, 1, deviceId, 1, [b], metadata()), /mutation_id_reuse/u));
});

test("HTTP route returns an error and no ACK for reused mutation ID in a separate batch", async () => {
  const auth = await createVerifiedRegisteredAuthUser(context);
  accounts.push(auth.userId);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const a = mutation();
  const send = (value: ProgressMutation, revision: number) => context.app.inject({ method: "POST", url: "/v1/progress/sync", headers,
    payload: { canonicalVersion: "canonical-json-v1", deviceId, expectedAccountRevision: revision, ...metadata(), mutations: [value] } });
  const first = await send(a, 0);
  assert.equal(first.statusCode, 200, first.body);
  const retry = await send(a, 0);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.deepEqual(retry.json().duplicates, [a.mutationId]);
  await assertNoWrite(auth.userId, async () => {
    const rejected = await send(mutation({ ...a, targetId: "other-target" }), 1);
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.deepEqual(rejected.json(), { error: { code: "mutation_id_reuse" } });
  });
});
