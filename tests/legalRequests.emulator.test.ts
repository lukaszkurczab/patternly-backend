import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { FirestoreLegalRequestStore, LegalRequestConfirmationRejectedError, type LegalRequestEmailSender } from "../src/modules/legal-requests/store.js";
import { clearFirestore, createEmulatorContext, firestore } from "./support.js";

const context = createEmulatorContext();
const sent: Parameters<LegalRequestEmailSender["send"]>[0][] = [];
const sender: LegalRequestEmailSender = { send: async (input) => { sent.push(input); } };
const secret = "test-only-legal-request-audit-secret-0123456789";

test.beforeEach(async () => {
  sent.length = 0;
  await clearFirestore();
  await firestore().collection("users").doc("account-1").set({ authorizationGeneration: 1, authorizationState: "active" });
});
test.after(async () => { await clearFirestore(); await context.close(); });

test("consumer case answer becomes final only after durable delivery and closure aligns six-year retention", async () => {
  const store = new FirestoreLegalRequestStore(firestore(), secret);
  const created = await store.create({ userId: "account-1", expectedAuthorizationGeneration: 1, email: "person@example.com", kind: "complaint", narrative: "Usługa nie została udostępniona.", transactionId: "tx-1" }, sender);
  assert.equal(created.status, "received");
  assert.equal(sent[0]?.purpose, "received");
  const details = await store.readAdmin(created.requestId, "operator-raw-id");
  assert.equal(details?.narrative, "Usługa nie została udostępniona.");
  assert.equal(details?.transactionId, "tx-1");
  const reviewing = await store.transitionAdmin(created.requestId, "operator-raw-id", { action: "start_review", expectedRevision: 0 }, sender);
  const answered = await store.transitionAdmin(created.requestId, "operator-raw-id", { action: "answer", expectedRevision: reviewing.revision, response: "Reklamacja uznana." }, sender);
  assert.equal(answered.status, "answered");
  assert.equal(answered.revision, 3);
  await assert.rejects(store.transitionAdmin(created.requestId, "operator-raw-id", { action: "close", expectedRevision: answered.revision, disposition: { kind: "minimal_archive", reason: "No claim" } }, sender), /legal_request_claim_disposition_required/u);
  const closed = await store.transitionAdmin(created.requestId, "operator-raw-id", { action: "close", expectedRevision: answered.revision, disposition: { kind: "claim", necessaryFields: ["email", "narrative", "transactionId", "response"], retentionUntil: "2032-02-01T00:00:00.000Z", basis: "Applicable claim limitation period", reason: "Evidence remains necessary for this complaint" } }, sender);
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
  const created = await store.create({ userId: "account-1", expectedAuthorizationGeneration: 1, email: "person@example.com", kind: "withdrawal" }, sender);
  await assert.rejects(store.transitionAdmin(created.requestId, "operator", { action: "answer", expectedRevision: 0, response: "Przyjęto." }, { send: async () => { throw new Error("smtp_down"); } }), /legal_request_email_unavailable/u);
  assert.equal((await store.readAccount("account-1", created.requestId))?.status, "received");
  for (let index = 0; index < 5; index += 1) await store.create({ userId: null, email: "guest@example.com", kind: "withdrawal" }, sender);
  await assert.rejects(store.create({ userId: null, email: "guest@example.com", kind: "withdrawal" }, sender), /legal_request_rate_limited/u);
});


test("received notice generic delivery ambiguity remains unknown without resending", async () => {
  let sends = 0;
  const store = new FirestoreLegalRequestStore(firestore(), secret);
  await assert.rejects(store.create({ userId: "account-1", expectedAuthorizationGeneration: 1, email: "person@example.com", kind: "complaint" }, { send: async () => { sends += 1; throw new Error("550 rejected maybe after DATA"); } }), /legal_request_email_unavailable/u);
  const cases = await firestore().collection("legalRequests").get();
  assert.equal(sends, 1);
  assert.equal(cases.size, 1);
  assert.equal(cases.docs[0]!.get("confirmationStatus"), "unknown");
  assert.equal(cases.docs[0]!.get("confirmationSentAt"), undefined);
});

const createInput = { userId: "account-1", expectedAuthorizationGeneration: 1, email: "person@example.com", kind: "complaint" } as const;

/** Forward real SDK transactions; inject only at the caller's acknowledgement boundary. */
function confirmationFaultDb(onTransaction: (commit: () => Promise<unknown>) => Promise<unknown>, enabled: () => boolean): Firestore {
  const db = firestore();
  return new Proxy(db, { get(target, property) {
    if (property === "runTransaction") return (callback: Parameters<Firestore["runTransaction"]>[0]) => {
      const commit = () => target.runTransaction(callback);
      return enabled() ? onTransaction(commit) : commit();
    };
    const value: unknown = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("received notice actual sent commit survives one lost ACK without marker rewrite or resend", async () => {
  let sends = 0;
  let finalizations = 0;
  let faultTriggered = 0;
  let requestId = "";
  let committed: Record<string, unknown> | undefined;
  const db = confirmationFaultDb(async (commit) => {
    finalizations += 1;
    const result = await commit();
    if (faultTriggered === 0) {
      committed = (await firestore().collection("legalRequests").doc(requestId).get()).data()!;
      assert.equal(committed.confirmationStatus, "sent");
      assert.ok(committed.confirmationSentAt instanceof Timestamp);
      faultTriggered += 1;
      throw new Error("injected_post_commit_ack_loss");
    }
    return result;
  }, () => sends > 0);
  const created = await new FirestoreLegalRequestStore(db, secret).create(createInput, { send: async (input) => { sends += 1; requestId = input.requestId; } });
  assert.equal(created.requestId, requestId);
  assert.equal(created.status, "received");
  assert.equal(sends, 1);
  assert.equal(faultTriggered, 1);
  assert.equal(finalizations, 2);
  const cases = await firestore().collection("legalRequests").get();
  assert.equal(cases.size, 1);
  assert.deepEqual(cases.docs[0]!.data(), committed);
});

test("received notice persistence failure has one bounded follow-up and no false durable success", async () => {
  for (const failBoth of [false, true]) {
    await clearFirestore();
    await firestore().collection("users").doc("account-1").set({ authorizationGeneration: 1, authorizationState: "active" });
    let sends = 0;
    let attempts = 0;
    const db = confirmationFaultDb(async (commit) => {
      attempts += 1;
      if (attempts === 1 || failBoth) throw new Error("injected_before_commit");
      return commit();
    }, () => sends > 0);
    await assert.rejects(new FirestoreLegalRequestStore(db, secret).create(createInput, { send: async () => { sends += 1; } }), /legal_request_email_unavailable/u);
    assert.equal(sends, 1);
    assert.equal(attempts, 2);
    const cases = await firestore().collection("legalRequests").get();
    assert.equal(cases.size, 1);
    assert.equal(cases.docs[0]!.get("confirmationStatus"), failBoth ? "pending" : "unknown");
    assert.equal(cases.docs[0]!.get("confirmationSentAt"), undefined);
  }
});

test("received notice definite refusal persists failed without a second sender invocation", async () => {
  let sends = 0;
  await assert.rejects(new FirestoreLegalRequestStore(firestore(), secret).create(createInput, { send: async () => { sends += 1; throw new LegalRequestConfirmationRejectedError(); } }), /legal_request_email_unavailable/u);
  const cases = await firestore().collection("legalRequests").get();
  assert.equal(sends, 1);
  assert.equal(cases.size, 1);
  assert.equal(cases.docs[0]!.get("confirmationStatus"), "failed");
  assert.equal(cases.docs[0]!.get("confirmationSentAt"), undefined);
});

test("received notice refuses erased rebound and inconsistent terminal cases without normalization", async () => {
  const changes: (Record<string, unknown> | null)[] = [
    null, { requestId: "foreign" }, { userId: "foreign" }, { email: "foreign@example.com" }, { kind: "withdrawal" },
    { createdAt: Timestamp.fromMillis(1) }, { receivedAt: Timestamp.fromMillis(1) },
    { confirmationStatus: "pending", confirmationSentAt: Timestamp.fromMillis(2) },
    { confirmationStatus: "sent" }, { confirmationStatus: "sent", confirmationSentAt: "invalid" },
    { confirmationStatus: "unknown" }, { confirmationStatus: "failed" }, { confirmationStatus: "malformed" },
  ];
  for (const change of changes) {
    let sends = 0;
    let requestId = "";
    let expected: Record<string, unknown> | undefined;
    await assert.rejects(new FirestoreLegalRequestStore(firestore(), secret).create(createInput, { send: async (input) => {
      sends += 1;
      requestId = input.requestId;
      const ref = firestore().collection("legalRequests").doc(requestId);
      if (change === null) await ref.delete(); else await ref.update(change);
      expected = (await ref.get()).data();
    } }), /legal_request_email_unavailable/u);
    assert.equal(sends, 1);
    assert.deepEqual((await firestore().collection("legalRequests").doc(requestId).get()).data(), expected);
  }
});

test("received notice finalization preserves concurrent review revision and retention fields", async () => {
  const retentionUntil = Timestamp.fromMillis(Date.now() + 86_400_000);
  const created = await new FirestoreLegalRequestStore(firestore(), secret).create(createInput, { send: async (input) => {
    await firestore().collection("legalRequests").doc(input.requestId).update({ status: "in_review", revision: 7, narrative: "Updated review", retentionUntil, legalHold: true });
  } });
  const stored = (await firestore().collection("legalRequests").doc(created.requestId).get()).data()!;
  assert.equal(stored.confirmationStatus, "sent");
  assert.ok(stored.confirmationSentAt instanceof Timestamp);
  assert.equal(stored.status, "in_review");
  assert.equal(stored.revision, 7);
  assert.equal(stored.narrative, "Updated review");
  assert.equal(stored.legalHold, true);
  assert.ok(retentionUntil.isEqual(stored.retentionUntil));
});
