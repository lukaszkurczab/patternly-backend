import assert from "node:assert/strict";
import test from "node:test";
import { FirestoreLegalRequestStore, type LegalRequestEmailSender } from "../src/modules/legal-requests/store.js";
import { clearFirestore, createEmulatorContext, firestore } from "./support.js";

const context = createEmulatorContext();
const sent: Parameters<LegalRequestEmailSender["send"]>[0][] = [];
const sender: LegalRequestEmailSender = { send: async (input) => { sent.push(input); } };
const secret = "test-only-legal-request-audit-secret-0123456789";

test.beforeEach(async () => { sent.length = 0; await clearFirestore(); });
test.after(async () => { await clearFirestore(); await context.close(); });

test("consumer case answer becomes final only after durable delivery and closure aligns six-year retention", async () => {
  const store = new FirestoreLegalRequestStore(firestore(), secret);
  const created = await store.create({ userId: "account-1", email: "person@example.com", kind: "complaint", narrative: "Usługa nie została udostępniona.", transactionId: "tx-1" }, sender);
  assert.equal(created.status, "received");
  assert.equal(sent[0]?.purpose, "received");
  const details = await store.readAdmin(created.requestId, "operator-raw-id");
  assert.equal(details?.narrative, "Usługa nie została udostępniona.");
  assert.equal(details?.transactionId, "tx-1");
  const reviewing = await store.transitionAdmin(created.requestId, "operator-raw-id", { action: "start_review", expectedRevision: 0 }, sender);
  const answered = await store.transitionAdmin(created.requestId, "operator-raw-id", { action: "answer", expectedRevision: reviewing.revision, response: "Reklamacja uznana." }, sender);
  assert.equal(answered.status, "answered");
  assert.equal(answered.revision, 3);
  const closed = await store.transitionAdmin(created.requestId, "operator-raw-id", { action: "close", expectedRevision: answered.revision }, sender);
  assert.equal(closed.status, "closed");
  assert.ok(closed.retentionUntil);
  const document = await firestore().collection("legalRequests").doc(created.requestId).get();
  assert.equal(document.get("lastActorId"), undefined);
  const audits = await document.ref.collection("audit").get();
  assert.ok(audits.size >= 4);
  for (const audit of audits.docs) {
    assert.equal(audit.get("actorId"), undefined);
    assert.equal(audit.get("expiresAt").toMillis(), document.get("expiresAt").toMillis());
  }
});

test("failed answer delivery leaves the case unanswered and guest intake is transactionally rate limited", async () => {
  const store = new FirestoreLegalRequestStore(firestore(), secret);
  const created = await store.create({ userId: "account-1", email: "person@example.com", kind: "withdrawal" }, sender);
  await assert.rejects(store.transitionAdmin(created.requestId, "operator", { action: "answer", expectedRevision: 0, response: "Przyjęto." }, { send: async () => { throw new Error("smtp_down"); } }), /legal_request_email_unavailable/u);
  assert.equal((await store.readAccount("account-1", created.requestId))?.status, "received");
  for (let index = 0; index < 5; index += 1) await store.create({ userId: null, email: "guest@example.com", kind: "withdrawal" }, sender);
  await assert.rejects(store.create({ userId: null, email: "guest@example.com", kind: "withdrawal" }, sender), /legal_request_rate_limited/u);
});
