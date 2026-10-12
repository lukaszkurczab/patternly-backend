import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, FieldPath } from "firebase-admin/firestore";

const projectId = "demo-patternly-perf05-probe";
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:18119" || process.env.GOOGLE_CLOUD_PROJECT !== projectId) throw new Error("paging_probe_isolated_emulator_required");
const app = initializeApp({ projectId }, `perf05-${randomUUID()}`);
const db = getFirestore(app);
const user = db.collection("users").doc(randomUUID());
const meta = user.collection("syncMetadata").doc("account");
const records = user.collection("progress");
let stage = "seed";
try {
  const ids = ["logical-z", "logical-a", "logical-m"].map((value) => createHash("sha256").update(value).digest("hex")).sort();
  const batch = db.batch();
  batch.set(user, { authorizationGeneration: 1 });
  batch.set(meta, { accountRevision: 1, generation: 0 });
  for (const id of ids) batch.set(records.doc(id), { identity: id });
  await batch.commit();
  stage = "query";
  const before = await db.getAll(user, meta);
  const first = await records.orderBy(FieldPath.documentId()).limit(2).get();
  const next = await records.orderBy(FieldPath.documentId()).startAt(first.docs[1]!.id).limit(2).get();
  assert.deepEqual(first.docs.map((document) => document.id), ids.slice(0, 2));
  assert.deepEqual(next.docs.map((document) => document.id), ids.slice(1));
  stage = "metadata_readback";
  await meta.update({ accountRevision: 2 });
  const after = await db.getAll(user, meta);
  assert.equal(before[1]!.updateTime!.isEqual(after[1]!.updateTime!), false);
  console.log(JSON.stringify({ stage: "real_sdk_probe", result: "PASS", firstDocuments: first.size, nextDocuments: next.size, inclusiveCursor: true, metadataUpdateObserved: true, projectId }));
} catch {
  throw new Error(`paging_probe_failed:${stage}`);
} finally {
  await db.recursiveDelete(user);
  await db.terminate();
  await deleteApp(app);
}
