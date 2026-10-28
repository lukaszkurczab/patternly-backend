import { attemptState, reviewState } from "./progressFixtures.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
const legacyBatchRef = (id: string, value: { sessionId: string; batchId: string }) => userRef(id).collection("syncBatches").doc(createHash("sha256").update(`${value.sessionId}:${value.batchId}`, "utf8").digest("hex"));
const versionedBatchRef = (id: string, value: { sessionId: string; batchId: string }) => userRef(id).collection("syncBatches").doc(`v2_${createHash("sha256").update(JSON.stringify(["sync-batch-v2", value.sessionId, value.batchId]), "utf8").digest("hex")}`);
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

test("versioned batch keys separate legacy-colliding pairs and preserve exact replay", async () => {
  const id = await account();
  const firstMetadata = { sessionId: "alpha", batchId: "beta:gamma", highWatermark: 1 };
  const secondMetadata = { sessionId: "alpha:beta", batchId: "gamma", highWatermark: 1 };
  const first = mutation({ targetId: "collision-first" });
  const second = mutation({ targetId: "collision-second" });

  const firstResult = await store.applyBatch(id, 1, deviceId, 0, [first], firstMetadata);
  assert.deepEqual(firstResult.applied.map((record) => record.lastMutationId), [first.mutationId]);

  // Turn the first batch receipt into an exact v1 fixture, as persisted by the
  // old delimiter-based implementation.
  const firstV2Ref = versionedBatchRef(id, firstMetadata);
  const firstReceipt = (await firstV2Ref.get()).data()!;
  const firstLegacyRef = legacyBatchRef(id, firstMetadata);
  await firstLegacyRef.create(firstReceipt);
  await firstV2Ref.delete();

  const secondResult = await store.applyBatch(id, 1, deviceId, 1, [second], secondMetadata);
  assert.deepEqual(secondResult.applied.map((record) => record.lastMutationId), [second.mutationId]);
  assert.equal(secondResult.accountRevision, 2);
  const secondReceiptRef = versionedBatchRef(id, secondMetadata);
  const secondReceipt = (await secondReceiptRef.get()).data();
  assert.ok(secondReceipt);

  await assertNoWrite(id, async () => {
    assert.deepEqual(await store.applyBatch(id, 1, deviceId, 1, [second], secondMetadata), secondResult);
  });
  await assertNoWrite(id, async () => {
    assert.deepEqual(await store.applyBatch(id, 1, deviceId, 0, [first], firstMetadata), firstResult);
  });
  assert.deepEqual((await firstLegacyRef.get()).data(), firstReceipt, "legacy replay must preserve its receipt and TTL");
  assert.deepEqual((await secondReceiptRef.get()).data(), secondReceipt, "batch replay must not renew TTL");

  const changedFirst = mutation({ ...first, state: { answer: "changed" } });
  await assertNoWrite(id, () => assert.rejects(store.applyBatch(id, 1, deviceId, 0, [changedFirst], firstMetadata), /mutation_id_reuse/u));
  const changedSecond = mutation({ ...second, state: { answer: "changed" } });
  await assertNoWrite(id, () => assert.rejects(store.applyBatch(id, 1, deviceId, 1, [changedSecond], secondMetadata), /mutation_id_reuse/u));
});

test("versioned namespace cannot alias an arbitrary legacy delimiter pair", async () => {
  const id = await account();
  const targetMetadata = { sessionId: "alpha:beta", batchId: "gamma", highWatermark: 1 };
  const encodedTarget = JSON.stringify(["sync-batch-v2", targetMetadata.sessionId, targetMetadata.batchId]);
  const separator = encodedTarget.indexOf(":");
  assert.ok(separator > 0);
  const legacyMetadata = { sessionId: encodedTarget.slice(0, separator), batchId: encodedTarget.slice(separator + 1), highWatermark: 1 };
  assert.ok(legacyMetadata.sessionId.length <= 128);
  assert.ok(legacyMetadata.batchId.length <= 128);
  assert.equal(`${legacyMetadata.sessionId}:${legacyMetadata.batchId}`, encodedTarget);

  // Create a realistic old receipt, then place it at the old v1 document ID.
  const legacyMutation = mutation({ targetId: "namespace-legacy" });
  await store.applyBatch(id, 1, deviceId, 0, [legacyMutation], legacyMetadata);
  const legacyV2Ref = versionedBatchRef(id, legacyMetadata);
  const legacyReceipt = (await legacyV2Ref.get()).data()!;
  const oldReceiptRef = legacyBatchRef(id, legacyMetadata);
  await oldReceiptRef.create(legacyReceipt);
  await legacyV2Ref.delete();

  const targetMutation = mutation({ targetId: "namespace-target" });
  const result = await store.applyBatch(id, 1, deviceId, 1, [targetMutation], targetMetadata);
  assert.deepEqual(result.applied.map((record) => record.lastMutationId), [targetMutation.mutationId]);
  assert.equal(result.accountRevision, 2);
  assert.match(versionedBatchRef(id, targetMetadata).id, /^v2_[a-f0-9]{64}$/u);
});

test("concurrent legacy-colliding batch pairs serialize at account revision", async () => {
  const id = await account();
  const firstMetadata = { sessionId: "alpha", batchId: "beta:gamma", highWatermark: 1 };
  const secondMetadata = { sessionId: "alpha:beta", batchId: "gamma", highWatermark: 1 };
  const first = mutation({ targetId: "concurrent-collision-first" });
  const second = mutation({ targetId: "concurrent-collision-second" });

  const attempts = await Promise.all([
    store.applyBatch(id, 1, deviceId, 0, [first], firstMetadata),
    store.applyBatch(id, 1, deviceId, 0, [second], secondMetadata),
  ]);
  const winner = attempts.find((result) => result.applied.length === 1)!;
  const loser = attempts.find((result) => result.accountRevisionConflict !== undefined)!;
  assert.ok(winner);
  assert.ok(loser);
  const winnerMutation = winner.applied[0]!.lastMutationId === first.mutationId ? first : second;
  const loserMutation = winnerMutation === first ? second : first;
  const loserMetadata = winnerMutation === first ? secondMetadata : firstMetadata;

  const retried = await store.applyBatch(id, 1, deviceId, winner.accountRevision, [loserMutation], loserMetadata);
  assert.deepEqual(retried.applied.map((record) => record.lastMutationId), [loserMutation.mutationId]);
  assert.equal(retried.accountRevision, 2);
  assert.deepEqual((await store.readSnapshot(id)).records.map((record) => record.lastMutationId).sort(), [first.mutationId, second.mutationId].sort());
});

test("concurrent identical 100-mutation batches share one durable result", async () => {
  const id = await account();
  const value = { sessionId: "concurrent-100-session", batchId: "concurrent-100-batch", highWatermark: 100 };
  const inputs = Array.from({ length: 100 }, (_, index) => mutation({ targetId: `concurrent-batch-${index}` }));
  const [first, retry] = await Promise.all([
    store.applyBatch(id, 1, deviceId, 0, inputs, value),
    store.applyBatch(id, 1, deviceId, 0, inputs, value),
  ]);

  assert.deepEqual(retry, first);
  assert.equal(first.applied.length, 100);
  assert.equal(first.accountRevision, 100);
  assert.equal((await store.readSnapshot(id)).records.length, 100);
  const batchReceiptRef = versionedBatchRef(id, value);
  const receipt = (await batchReceiptRef.get()).data();
  assert.ok(receipt);
  assert.ok(receipt.createdAt instanceof Timestamp);
  assert.ok(receipt.expiresAt instanceof Timestamp);
  assert.equal(receipt.expiresAt.toMillis() - receipt.createdAt.toMillis(), 30 * 24 * 60 * 60 * 1_000);
  assert.equal((await userRef(id).collection("syncBatches").get()).size, 1);

  await assertNoWrite(id, async () => {
    assert.deepEqual(await store.applyBatch(id, 1, deviceId, 0, inputs, value), first);
  });
  assert.deepEqual((await batchReceiptRef.get()).data(), receipt, "concurrent retry must not renew batch TTL");
});

test("versioned batch identity preserves exact Unicode strings", async () => {
  const id = await account();
  const composed = { sessionId: "caf\u00e9", batchId: "unicode-batch", highWatermark: 1 };
  const decomposed = { sessionId: "cafe\u0301", batchId: "unicode-batch", highWatermark: 1 };
  const first = mutation({ targetId: "unicode-composed" });
  const second = mutation({ targetId: "unicode-decomposed" });

  const firstResult = await store.applyBatch(id, 1, deviceId, 0, [first], composed);
  const secondResult = await store.applyBatch(id, 1, deviceId, 1, [second], decomposed);
  assert.deepEqual(firstResult.applied.map((record) => record.lastMutationId), [first.mutationId]);
  assert.deepEqual(secondResult.applied.map((record) => record.lastMutationId), [second.mutationId]);
  assert.equal((await userRef(id).collection("syncBatches").get()).size, 2);
});

test("a mismatched v2 receipt pair fails closed", async () => {
  const id = await account();
  const value = metadata();
  const input = mutation({ targetId: "tampered-v2-receipt" });
  await store.applyBatch(id, 1, deviceId, 0, [input], value);
  const ref = versionedBatchRef(id, value);
  await ref.update({ sessionId: "other-session" });
  await assertNoWrite(id, () => assert.rejects(store.applyBatch(id, 1, deviceId, 0, [input], value), /sync_batch_invalid/u));
});

test("malformed legacy batch identity fails closed", async () => {
  for (const stored of [{}, { sessionId: "", batchId: "batch" }, { sessionId: "session", batchId: "b".repeat(129) }]) {
    const id = await account();
    const value = { sessionId: "session", batchId: "batch", highWatermark: 1 };
    const input = mutation({ targetId: "malformed-legacy-receipt" });
    await legacyBatchRef(id, value).set(stored);
    await assertNoWrite(id, () => assert.rejects(store.applyBatch(id, 1, deviceId, 0, [input], value), /sync_batch_invalid/u));
  }
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
