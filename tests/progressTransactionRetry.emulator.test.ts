import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import firestorePackage from "@google-cloud/firestore";
import { grpc } from "google-gax";
import type { Transaction } from "firebase-admin/firestore";
import { FirestoreProgressStore } from "../src/modules/progress/store.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { progressDocumentId } from "../src/infrastructure/firestore/paths.js";
import { attemptState } from "./progressFixtures.js";

const { Firestore, Timestamp, setLogFunction, v1 } = firestorePackage;
const projectId = "demo-patternly-closed-read-regression";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host) throw new Error("firebase_emulator_suite_required");
const endpoint = new URL(`http://${host}`);
if (endpoint.hostname !== "127.0.0.1" || !endpoint.port) throw new Error("closed_read_test_loopback_required");
const db = new Firestore({ projectId, host, ssl: false });
const rpc = new v1.FirestoreClient({ projectId, servicePath: endpoint.hostname, port: Number(endpoint.port), sslCreds: grpc.credentials.createInsecure() });
const database = `projects/${projectId}/databases/(default)`;
const accounts: string[] = [];
const trackId = "coding-interview-dsa-problem-solving";
const metadata = { sessionId: "closed-read-session", batchId: "closed-read-batch", highWatermark: 1 };

function mutation() {
  const targetId = `attempt-${randomUUID()}`;
  const state = attemptState(targetId, trackId);
  return { mutationId: `mutation-${randomUUID()}`, kind: "item" as const, recordType: "training_attempt" as const, trackId, targetId, expectedVersion: null, state, fingerprint: createMergeRecordFingerprint({ recordId: targetId, recordType: "training_attempt", state, trackId }) };
}

// Inject one real server rollback between read 1 and read 2. The logger keeps
// the public SDK's token only in memory; it never emits SDK messages or tokens.
function closeFirstRead(onClosed?: () => Promise<void>) {
  let captured: Buffer | undefined;
  let firstToken: Buffer | undefined;
  let secondToken: Buffer | undefined;
  let attempts = 0;
  let injected = false;
  setLogFunction(message => {
    const match = /\[Firestore.requestStream\]: Received response: ([\s\S]*)$/u.exec(message);
    if (!match) return;
    let value: unknown;
    try { value = JSON.parse(match[1]!).transaction; } catch { return; }
    const candidate = value as { data?: unknown } | null;
    const token = typeof value === "string" && value.length > 0 ? Buffer.from(value, "base64")
      : Array.isArray(candidate?.data) && candidate.data.length > 0 ? Buffer.from(candidate.data)
      : Array.isArray(value) && value.length > 0 ? Buffer.from(value) : undefined;
    if (token?.length) captured = token;
  });
  const instrumented = new Proxy(db, { get(target, property) {
    if (property === "runTransaction") return async (callback: (transaction: Transaction) => Promise<unknown>) => target.runTransaction(async transaction => {
      attempts++;
      let reads = 0;
      captured = undefined;
      const observed = new Proxy(transaction, { get(actual, member) {
        const value = Reflect.get(actual, member, actual) as unknown;
        if ((member === "get" || member === "getAll") && typeof value === "function") return async (...args: unknown[]) => {
          reads++;
          if (reads === 2 && !injected) {
            assert.ok(captured?.length, "closed_read_public_sdk_token_unavailable");
            firstToken = Buffer.from(captured);
            injected = true;
            await rpc.rollback({ database, transaction: firstToken }, { otherArgs: { headers: { authorization: "Bearer owner" } } });
            await onClosed?.();
          }
          const result: unknown = await Reflect.apply(value, actual, args);
          if (reads === 1 && attempts === 2) {
            assert.ok(captured?.length, "closed_read_retry_token_unavailable");
            secondToken = Buffer.from(captured);
          }
          return result;
        };
        return typeof value === "function" ? value.bind(actual) : value;
      } });
      return callback(observed);
    });
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return {
    store: new FirestoreProgressStore(instrumented),
    inspect: () => ({ attempts, injected, freshTransaction: firstToken !== undefined && secondToken !== undefined && !firstToken.equals(secondToken) }),
    close: () => { setLogFunction(null); captured = undefined; firstToken = undefined; secondToken = undefined; },
  };
}

test.after(async () => {
  setLogFunction(null);
  for (const userId of accounts) await db.recursiveDelete(db.collection("users").doc(userId));
  await db.terminate();
  await rpc.close();
});

test("real closed progress read retries with a fresh SDK transaction and keeps one durable result", async () => {
  const userId = randomUUID();
  accounts.push(userId);
  const user = db.collection("users").doc(userId);
  await user.create({ authorizationGeneration: 1, authorizationState: "active" });
  const input = mutation();
  const fixture = closeFirstRead();
  try {
    const result = await fixture.store.applyBatch(userId, 1, "device", 0, [input], metadata);
    assert.deepEqual(fixture.inspect(), { attempts: 2, injected: true, freshTransaction: true });
    assert.equal(result.accountRevision, 1);
    assert.equal(result.applied.length, 1);
    const [meta, record, receipt] = await db.getAll(user.collection("syncMetadata").doc("account"), user.collection("progress").doc(progressDocumentId(input)), user.collection("syncMutations").doc(input.mutationId));
    assert.equal(meta!.get("accountRevision"), 1);
    assert.equal(record!.get("version"), 1);
    assert.deepEqual(record!.get("state"), input.state);
    assert.equal(receipt!.get("fingerprint"), input.fingerprint);
    assert.equal(receipt!.get("appliedVersion"), 1);
    const createdAt = receipt!.get("createdAt") as InstanceType<typeof Timestamp>;
    const expiresAt = receipt!.get("expiresAt") as InstanceType<typeof Timestamp>;
    assert.ok(createdAt instanceof Timestamp);
    assert.ok(expiresAt instanceof Timestamp);
    assert.equal(expiresAt.toMillis() - createdAt.toMillis(), 30 * 24 * 60 * 60 * 1_000);
    const replay = await fixture.store.applyBatch(userId, 1, "device", 0, [input], metadata);
    assert.deepEqual(replay, result);
    const replayed = await user.collection("syncMutations").doc(input.mutationId).get();
    assert.equal((replayed.get("createdAt") as InstanceType<typeof Timestamp>).toMillis(), createdAt.toMillis());
    assert.equal((replayed.get("expiresAt") as InstanceType<typeof Timestamp>).toMillis(), expiresAt.toMillis());
    assert.equal((await user.collection("syncBatches").get()).size, 1);
    assert.equal((await user.collection("syncMutations").get()).size, 1);
    assert.equal((await user.collection("progress").get()).size, 1);
  } finally { fixture.close(); }
});

test("real closed-read retry rechecks authorization and cannot write after generation rotation", async () => {
  const userId = randomUUID();
  accounts.push(userId);
  const user = db.collection("users").doc(userId);
  await user.create({ authorizationGeneration: 1, authorizationState: "active" });
  const fixture = closeFirstRead(async () => { await user.update({ authorizationGeneration: 2 }); });
  try {
    await assert.rejects(fixture.store.applyBatch(userId, 1, "device", 0, [mutation()], metadata), { message: "authorization_generation_conflict" });
    assert.deepEqual(fixture.inspect(), { attempts: 2, injected: true, freshTransaction: true });
    for (const collection of ["syncMetadata", "syncMutations", "syncBatches", "progress"]) assert.equal((await user.collection(collection).get()).size, 0);
  } finally { fixture.close(); }
});
