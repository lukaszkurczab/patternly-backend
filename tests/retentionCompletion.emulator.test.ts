import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { clearFirestore, createEmulatorContext, firestore } from "./support.js";
import { addUtcCalendarMonths } from "../src/infrastructure/time/utcCalendar.js";
import { nextWorkingReviewAt } from "../src/modules/retention/review.js";
import { readOperatorPage } from "../src/modules/retention/operatorPage.js";
const context = createEmulatorContext();
const now = () => Timestamp.now();
const afterMonths = (months: number) => Timestamp.fromDate(addUtcCalendarMonths(new Date(), months));
const ago = (days: number) => Timestamp.fromMillis(Date.now() - days * 86400000);
test.beforeEach(clearFirestore);
test.after(async () => { await clearFirestore(); await context.close(); });

const incidentInput = { title: "Incident", details: "minimal test facts", detectedAt: "2026-09-07T10:00:00.000Z", containedAt: "2026-09-07T11:00:00.000Z", categories: "account data", dataSubjectCount: "1", recordCount: "1", specialData: false, confidentialityImpact: "low", integrityImpact: "none", availabilityImpact: "none", consequences: "review", likelihood: "low", severity: "low", containment: "contained", remediation: "fixed", prevention: "monitor", postmortem: "reviewed" };

test("all four production operator stores continue past 100 live records without duplicate or missing IDs", async () => {
  const batch = firestore().batch();
  const at = now();
  for (let i = 0; i < 205; i += 1) {
    const id = randomUUID();
    batch.set(firestore().collection("contentReports").doc(id), { id, clientSubmissionId: id, trackId: "coding", contentVersion: "v1", itemId: "q1", reason: "other", description: "", context: { releasePackageId: "test", trackNode: null, modeRoute: "answer_review", locale: "en", appBuild: "0.1.0", platform: "ios", occurredAt: new Date().toISOString() }, status: "open", createdAt: at, updatedAt: at, expiresAt: afterMonths(1) });
    batch.set(firestore().collection("privacyRequests").doc(`pr_${id}`), { right: "access", channel: "public", status: "received", receivedAt: at, deadlineAt: afterMonths(1), revision: 0 });
    batch.set(firestore().collection("legalRequests").doc(`lr_${id}`), { kind: "complaint", status: "closed", receivedAt: at, closedAt: at, expiresAt: afterMonths(12), retentionUntil: afterMonths(12), revision: 0 });
    batch.set(firestore().collection("securityIncidents").doc(`si_${id}`), { classification: "breach_confirmed", authorityDecision: "not_required", authorityDeliveryStatus: "not_started", subjectDecision: "not_required", subjectNotificationStatus: "not_started", closedAt: ago(400), expiresAt: afterMonths(60), createdAt: at, updatedAt: at, revision: 0, assessmentVersion: 1 });
  }
  await batch.commit();
  for (const store of [context.stores.contentReports, context.stores.privacyRequests, context.stores.legalRequests, context.stores.securityIncidents]) {
    const ids: string[] = []; let cursor: string | undefined;
    do {
      const page = await store.listOperatorQueue("test-operator", { cursor });
      assert.ok(page.items.length <= 100);
      ids.push(...page.items.map((item) => "clientSubmissionId" in item ? item.clientSubmissionId : "requestId" in item ? item.requestId : item.incidentId));
      assert.equal(page.truncated, page.nextCursor !== null);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(ids.length, 205); assert.equal(new Set(ids).size, 205);
  }
  const ordered = await firestore().collection("legalRequests").orderBy("__name__").get();
  const reviewed = firestore().batch();
  for (const document of ordered.docs.slice(0, 203)) reviewed.update(document.ref, { nextReviewAt: afterMonths(5) });
  await reviewed.commit();
  const due = await context.stores.legalRequests.listOperatorQueue("op", { dueOnly: true });
  assert.equal(due.items.length, 2); assert.equal(due.nextCursor, null);
  assert.deepEqual(due.items.map((item) => item.requestId), ordered.docs.slice(203).map((document) => document.id));
});

test("bounded scans continue through an empty expired page and survive deletion of the cursor document", async () => {
  const collection = firestore().collection("retentionPagingFixture"); const batch = firestore().batch();
  for (let i = 0; i < 505; i += 1) batch.set(collection.doc(String(i).padStart(5, "0")), { live: i >= 500 });
  await batch.commit();
  const first = await readOperatorPage(collection, (row) => row.live === true);
  assert.equal(first.documents.length, 0); assert.ok(first.nextCursor);
  await collection.doc("00499").delete();
  const second = await readOperatorPage(collection, (row) => row.live === true, { cursor: first.nextCursor });
  assert.equal(second.documents.length, 5); assert.equal(second.nextCursor, null);
  await assert.rejects(readOperatorPage(collection, () => true, { cursor: first.nextCursor, dueOnly: true }), /cursor_invalid/);
});

test("legacy privacy archives and their secrets obey calendar/working caps without physical deletion", async () => {
  const id = await context.stores.privacyRequests.createGuest({ clientRequestId: randomUUID(), email: "fixture@example.test", right: "access", narrative: "Private narrative", reportSubmissionIds: [], rateLimitKey: "legacy" }, { send: async () => {} });
  const ref = firestore().collection("privacyRequests").doc(id);
  await ref.update({ status: "closed", closedAt: ago(400), expiresAt: afterMonths(24) });
  assert.equal(await context.stores.privacyRequests.readAdmin(id, "op"), null);
  assert.equal((await ref.get()).exists, true);
  await ref.update({ closedAt: ago(31) });
  const details = await context.stores.privacyRequests.readAdmin(id, "op");
  assert.ok(details); assert.equal(details.narrative, null);
  await ref.update({ status: "received", closedAt: null, extensionNoticeStatus: "pending", extensionNoticeAttemptedAt: ago(3) });
  const due = await context.stores.privacyRequests.listOperatorQueue("op", { dueOnly: true });
  assert.ok(due.items.some((item) => item.requestId === id));
  assert.ok(Date.parse(due.items[0]!.nextReviewAt!) <= Date.now());
  await context.stores.privacyRequests.transitionAdmin(id, "op", { action: "record_review", expectedRevision: 0, reason: "Uncertain delivery inspected; no automatic repeat", nextReviewAt: new Date(Date.now() + 86400000).toISOString() }, null);
  assert.equal((await context.stores.privacyRequests.listOperatorQueue("op", { dueOnly: true })).items.length, 0);
  await ref.update({ extensionNoticeStatus: "delivered", deliveryFailure: "response_email_failed", deliveryFailureAt: ago(2) });
  assert.equal((await context.stores.privacyRequests.listOperatorQueue("op", { dueOnly: true })).items.length, 0); // already reviewed failure predates acknowledgment
  await ref.update({ deliveryReviewAcknowledgedAt: null });
  assert.equal((await context.stores.privacyRequests.listOperatorQueue("op", { dueOnly: true })).items.length, 1);
  await ref.update({ status: "closed", closedAt: ago(31) });
  await firestore().collection("privacyRequestSecrets").doc(id).delete();
  assert.ok(await context.stores.privacyRequests.readAdmin(id, "op"));

});

test("legal review minimizes only unneeded evidence, preserves ongoing dispute, and requires finality plus execution", async () => {
  const store = context.stores.legalRequests;
  const created = await store.create({ userId: null, email: "fixture@example.test", kind: "complaint", narrative: "Evidence", transactionId: "tx" }, { send: async () => {} });
  const ref = firestore().collection("legalRequests").doc(created.requestId);
  await ref.update({ status: "answered", response: "Resolution", answeredAt: now() });
  await store.transitionAdmin(created.requestId, "op", { action: "close", expectedRevision: 0, disposition: { kind: "claim", necessaryFields: ["narrative", "transactionId"], retentionUntil: afterMonths(12).toDate().toISOString(), basis: "Applicable claim period", reason: "Only these two fields prove the claim" } }, null);
  let raw = (await ref.get()).data()!;
  assert.equal(raw.email, undefined); assert.equal(raw.response, undefined); assert.equal(raw.subjectKey, undefined); assert.equal(raw.narrative, "Evidence");
  const review = { action: "review_retention" as const, expectedRevision: 1, reason: "Proceedings ongoing", nextReviewAt: afterMonths(5).toDate().toISOString(), necessaryFields: ["narrative", "transactionId"] as ("narrative" | "transactionId")[], retentionUntil: afterMonths(12).toDate().toISOString(), basis: "Claim period", dispute: "ongoing" as const };
  await store.transitionAdmin(created.requestId, "op", review, null);
  raw = (await ref.get()).data()!; assert.equal(raw.legalHold, true); assert.equal(raw.expiresAt, null);
  await assert.rejects(store.transitionAdmin(created.requestId, "op", { ...review, expectedRevision: 2, necessaryFields: [] }, null), /held_evidence/);
  await assert.rejects(store.transitionAdmin(created.requestId, "op", { ...review, expectedRevision: 2, dispute: "resolved_executed" }, null), /resolution_required/);
  await store.transitionAdmin(created.requestId, "op", { ...review, expectedRevision: 2, dispute: "resolved_executed", finalResolutionAt: ago(2).toDate().toISOString(), executedAt: ago(1).toDate().toISOString(), necessaryFields: ["transactionId"] }, null);
  raw = (await ref.get()).data()!; assert.equal(raw.legalHold, false); assert.equal(raw.narrative, undefined); assert.equal(raw.transactionId, "tx");
  await assert.rejects(store.transitionAdmin(created.requestId, "op", { ...review, expectedRevision: 3, nextReviewAt: afterMonths(7).toDate().toISOString() }, null), /review_date_invalid/);
});

test("legacy incident caps distinguish working copies, necessary breach evidence and held evidence; annual review is actionable", async () => {
  const store = context.stores.securityIncidents;
  const created = await store.create("op", { ...incidentInput, recipients: ["fixture@example.test"] });
  const ref = firestore().collection("securityIncidents").doc(created.incidentId);
  await ref.update({ classification: "not_a_breach", closedAt: ago(400), expiresAt: afterMonths(60) });
  assert.equal(await store.readAdmin(created.incidentId, "op"), null);
  await ref.update({ classification: "breach_confirmed", closedAt: ago(400), expiresAt: afterMonths(60) });
  assert.ok((await store.listOperatorQueue("op", { dueOnly: true })).items.some((item) => item.incidentId === created.incidentId));
  const reviewed = await store.act(created.incidentId, "op", { action: "review_retention", expectedRevision: 0, reason: "Necessary breach core remains; annual necessity reviewed", nextReviewAt: afterMonths(11).toDate().toISOString() }, null);
  assert.ok(reviewed.nextReviewAt);
  await assert.rejects(store.act(created.incidentId, "op", { action: "review_retention", expectedRevision: 1, reason: "Too late", nextReviewAt: afterMonths(13).toDate().toISOString() }, null), /review_date_invalid/);
  const secret = (await firestore().collection("securityIncidentSecrets").doc(created.incidentId).get()).data()!;
  const artifact = firestore().collection("securityIncidentArtifacts").doc(`authority_${created.incidentId}_1`);
  await artifact.set({ incidentId: created.incidentId, kind: "authority_export", payload: secret.payload, digest: "fixture", expiresAt: afterMonths(12), version: 1 });
  assert.equal(await store.readAuthorityExport(created.incidentId, 1, "op"), null);
  await firestore().collection("securityIncidentArtifacts").doc(`subject_snapshot_${created.incidentId}_1`).set({ incidentId: created.incidentId, kind: "subject_notification_snapshot", payload: secret.payload, expiresAt: afterMonths(12) });
  await ref.update({ subjectNotificationVersion: 1 });
  assert.equal((await store.readAdmin(created.incidentId, "op"))!.preparedRecipients.length, 1);
  await ref.update({ legalHold: true, legalHoldReviewBy: ago(1) });
  await artifact.update({ kind: "authority_export", expiresAt: null });
  assert.ok(await store.readAuthorityExport(created.incidentId, 1, "op"));
});

test("operational next working day skips weekends without changing legal deadlines", () => {
  assert.equal(nextWorkingReviewAt(new Date("2026-10-16T10:00:00Z")).toISOString(), "2026-10-19T00:00:00.000Z");
});


test("closing a held nonbreach preserves full evidence; release minimizes it without extending the core expiry", async () => {
  const store = context.stores.securityIncidents;
  const created = await store.create("op", incidentInput);
  const ref = firestore().collection("securityIncidents").doc(created.incidentId);
  await store.act(created.incidentId, "op", { action: "acknowledge_awareness", expectedRevision: 0 }, null);
  await store.act(created.incidentId, "op", { action: "classify", classification: "not_a_breach", reason: "No personal data breach", expectedRevision: 1 }, null);
  await store.act(created.incidentId, "op", { action: "decide_authority", decision: "not_required", reason: "Not a personal data breach", legalException: "No personal data breach requiring notification", expectedRevision: 2 }, null);
  await store.act(created.incidentId, "op", { action: "decide_subject", decision: "not_required", reason: "No affected personal data", legalException: "No personal data breach requiring notification", expectedRevision: 3 }, null);
  await store.act(created.incidentId, "op", { action: "set_legal_hold", expectedRevision: 4, reason: "Preserve evidence pending review", reviewBy: afterMonths(5).toDate().toISOString() }, null);
  await store.act(created.incidentId, "op", { action: "close", expectedRevision: 5, reason: "Assessed as nonbreach; separate preservation still required" }, null);
  assert.equal((await store.readAdmin(created.incidentId, "op"))!.assessment.categories, "account data");
  const closedAt = (await ref.get()).get("closedAt") as Timestamp;
  await store.act(created.incidentId, "op", { action: "release_legal_hold", expectedRevision: 6, reason: "Preservation need resolved; discard redundant working fields" }, null);
  assert.equal((await store.readAdmin(created.incidentId, "op"))!.assessment.categories, undefined);
  assert.equal(((await ref.get()).get("expiresAt") as Timestamp).toMillis(), addUtcCalendarMonths(closedAt.toDate(), 12).getTime());
});

test("claim close cannot discard fields that are already protected by a hold", async () => {
  const store = context.stores.legalRequests;
  const created = await store.create({ userId: null, email: "held@example.test", kind: "complaint", narrative: "Held evidence" }, { send: async () => {} });
  const ref = firestore().collection("legalRequests").doc(created.requestId);
  await ref.update({ status: "answered", response: "Held response", legalHold: true, expiresAt: null });
  await assert.rejects(store.transitionAdmin(created.requestId, "op", { action: "close", expectedRevision: 0, disposition: { kind: "claim", necessaryFields: ["narrative"], retentionUntil: afterMonths(12).toDate().toISOString(), basis: "Claim period", reason: "Attempted minimization" } }, null), /held_evidence_required/);
  const raw = (await ref.get()).data()!;
  assert.equal(raw.email, "held@example.test"); assert.equal(raw.response, "Held response"); assert.equal(raw.revision, 0);
});

test("account response reader hides an expired legacy extension secret even when provider TTL is still in the future", async () => {
  await firestore().collection("users").doc("archive-account").set({ authorizationGeneration: 1, authorizationState: "active" });
  const store = context.stores.privacyRequests;
  const created = await store.createAccount("archive-account", 1, "access");
  await store.transitionAdmin(created.requestId, "op", { action: "start_review", expectedRevision: 0 }, null);
  await store.transitionAdmin(created.requestId, "op", { action: "extend", expectedRevision: 1, reason: "Private extension details", noticeLocale: "en" }, null);
  const ref = firestore().collection("privacyRequests").doc(created.requestId);
  await ref.update({ status: "closed", closedAt: ago(31), expiresAt: afterMonths(24) });
  const response = await store.readAccount("archive-account", 1, created.requestId);
  assert.ok(response); assert.equal(response.extensionReason, null);
});
