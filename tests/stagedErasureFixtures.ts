import { createHash } from "node:crypto";
import type { DocumentReference, Firestore } from "firebase-admin/firestore";
import { adoptionTransferRecordDocumentId, adoptionTransferIdempotencyDocumentId } from "../src/infrastructure/firestore/paths.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { adoptionTransferRecordKey } from "../src/modules/users/adoptionTransfer.js";
import { attemptState } from "./progressFixtures.js";

/** Seed concrete staged account documents for physical erasure/readback tests. */
export async function seedStagedErasureFixture(
  db: Firestore,
  userId: string,
  { missingParents = false, recordCount = 2 }: { missingParents?: boolean; recordCount?: number } = {},
): Promise<{ root: DocumentReference; refs: DocumentReference[] }> {
  if (!Number.isSafeInteger(recordCount) || recordCount < 1) throw new Error("staged_fixture_record_count_invalid");

  const root = db.collection("accounts").doc(userId);
  const sessionId = "staged-erasure-transfer";
  const transfer = root.collection("adoptionTransfers").doc(sessionId);
  const refs: DocumentReference[] = [];

  if (!missingParents) {
    await root.set({ accountId: userId, updatedAt: new Date("2026-10-19T10:00:00.000Z") });
    refs.push(root);
    await transfer.set({ accountId: userId, sessionId, state: "collecting", recordCount, idempotencyKey: "staged-erasure-key" });
    refs.push(transfer);
  }

  for (let index = 0; index < recordCount; index += 1) {
    const recordId = `staged-attempt-${index}`;
    const state = attemptState(recordId, "coding-interview-dsa-problem-solving");
    const record = {
      recordType: "training_attempt",
      recordId,
      trackId: "coding-interview-dsa-problem-solving",
      fingerprint: createMergeRecordFingerprint({ recordId, recordType: "training_attempt", trackId: "coding-interview-dsa-problem-solving", state }),
      state,
      version: 1,
    };
    const ref = transfer.collection("records").doc(adoptionTransferRecordDocumentId(record));
    await ref.set(record);
    refs.push(ref);
  }

  if (missingParents) {
    const orphanLeaf = transfer.collection("records").doc("missing-record-parent").collection("nested").doc("leaf");
    await orphanLeaf.set({ payload: "orphaned-staged-data" });
    refs.push(orphanLeaf);
  }

  const recordKeys = Array.from({ length: recordCount }, (_, index) => adoptionTransferRecordKey({ recordType: "training_attempt", recordId: `staged-attempt-${index}`, trackId: "coding-interview-dsa-problem-solving" }));
  const chunk = transfer.collection("chunks").doc("staged-chunk");
  await chunk.set({ chunkId: "staged-chunk", index: 0, recordKeys, fingerprint: createHash("sha256").update("staged-chunk").digest("hex"), bytes: 1 });
  refs.push(chunk);
  const decision = transfer.collection("decisions").doc("staged-decision");
  await decision.set({ decisionId: "staged-decision", resolution: "keep_guest", previewFingerprint: "b".repeat(64) });
  refs.push(decision);
  const result = transfer.collection("results").doc("00000000");
  await result.set({ chunkIndex: 0, status: "staged", result: { accountId: userId } });
  refs.push(result);
  const marker = transfer.collection("markers").doc("staged-marker");
  await marker.set({ operationId: "staged-marker", status: "pending" });
  refs.push(marker);

  const idempotency = root.collection("adoptionTransferIdempotency").doc(adoptionTransferIdempotencyDocumentId("staged-erasure-key"));
  await idempotency.set({ accountId: userId, idempotencyKey: "staged-erasure-key", sessionId, targetGeneration: 1 });
  refs.push(idempotency);

  return { root, refs };
}
