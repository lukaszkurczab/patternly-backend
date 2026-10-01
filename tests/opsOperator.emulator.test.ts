import assert from "node:assert/strict";
import { createCipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { FirestoreContentReportStore } from "../src/modules/content-reports/store.js";
import { FirestoreLegalRequestStore } from "../src/modules/legal-requests/store.js";
import { FirestorePrivacyRequestStore, type PrivacyRequestEmailSender } from "../src/modules/privacy-requests/store.js";
import { FirestoreSecurityIncidentStore } from "../src/modules/security-incidents/store.js";

const enabled = process.env.OPS_B2_EMULATOR_TESTS === "1";
const REPORT_SECRET = "ops-b2-test-report-hmac-secret-0123456789";
const PRIVACY_KEY = Buffer.alloc(32, 21);
const PRIVACY_SECRET = "ops-b2-test-privacy-hmac-secret-0123456789";
const LEGAL_SECRET = "ops-b2-test-legal-hmac-secret-0123456789";
const INCIDENT_KEY = Buffer.alloc(32, 22);
const INCIDENT_SECRET = "ops-b2-test-incident-hmac-secret-0123456789";

function emulatorDatabase() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (projectId !== "demo-patternly-ops-b2" || host !== "127.0.0.1:18119") {
    throw new Error("ops_b2_test_requires_isolated_demo_patternly_ops_b2_on_127.0.0.1_18119");
  }
  const app = initializeApp({ projectId }, `ops-b2-${randomUUID()}`);
  return { app, db: getFirestore(app) };
}

function encryptPrivacySecret(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", PRIVACY_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function reportRecord(clientSubmissionId: string, index: number) {
  const timestamp = Timestamp.fromMillis(Date.now() + index);
  return {
    id: randomUUID(), clientSubmissionId, trackId: "coding-interview", contentVersion: "v1", itemId: `question-${index}`,
    reason: "incorrect_answer", description: "private narrative must not appear in operator queue", context: {
      releasePackageId: "pkg-1", trackNode: null, modeRoute: "answer_review", locale: "en", appBuild: "1.0.0", platform: "ios", occurredAt: timestamp.toDate().toISOString(),
    }, status: "closed", createdAt: timestamp, updatedAt: timestamp, expiresAt: Timestamp.fromMillis(timestamp.toMillis() + 86_400_000),
  };
}

test("operator queues return at most 100 allowlisted rows, audit each returned row, and content CAS rejects a stale writer", { skip: enabled ? false : "requires explicit isolated OPS_B2_EMULATOR_TESTS=1 gate" }, async () => {
  const { app, db } = emulatorDatabase();
  try {
    const namespace = randomUUID();
    const actor = `operator-${namespace}`;
    const reports = db.collection("contentReports");
    const privacy = db.collection("privacyRequests");
    const legal = db.collection("legalRequests");
    const incidents = db.collection("securityIncidents");
    const seedBatch = db.batch();
    const reportIds: string[] = [];
    const privacyIds: string[] = [];
    const legalIds: string[] = [];
    const incidentIds: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const reportId = randomUUID();
      reportIds.push(reportId);
      seedBatch.create(reports.doc(reportId), reportRecord(reportId, index));

      const privacyId = `pr_${randomUUID()}`;
      privacyIds.push(privacyId);
      const receivedAt = Timestamp.fromMillis(Date.now() + index);
      seedBatch.create(privacy.doc(privacyId), {
        requestId: privacyId, channel: "account", userId: `subject-${namespace}`, right: "access", status: "received", outcome: null,
        receivedAt, deadlineAt: Timestamp.fromMillis(receivedAt.toMillis() + 1_000), extendedAt: null, responsePreparedAt: null,
        deliveredAt: null, closedAt: null, revision: 0, createdAt: receivedAt, updatedAt: receivedAt,
      });

      const legalId = `lr_${randomUUID()}`;
      legalIds.push(legalId);
      seedBatch.create(legal.doc(legalId), {
        requestId: legalId, userId: `subject-${namespace}`, email: "private@example.com", narrative: "private legal narrative", transactionId: "private-transaction",
        kind: "complaint", status: "received", response: "private response", receivedAt, responseDueAt: null, answeredAt: null,
        retentionUntil: null, expiresAt: null, legalHold: false, revision: 0, createdAt: receivedAt, updatedAt: receivedAt,
      });

      const incidentId = `si_${randomUUID()}`;
      incidentIds.push(incidentId);
      seedBatch.create(incidents.doc(incidentId), {
        classification: "triage", authorityDecision: "undecided", authorityDeliveryStatus: "not_started", subjectDecision: "undecided",
        subjectNotificationStatus: "not_started", awarenessAt: null, authorityDeadlineAt: null, closedAt: null,
        revision: 0, assessmentVersion: 1, legalHold: false, createdAt: receivedAt, updatedAt: receivedAt,
      });
    }
    await seedBatch.commit();

    const contentStore = new FirestoreContentReportStore(db, { rateLimitHashSecret: REPORT_SECRET, rateLimitMax: 10, rateLimitWindowSeconds: 60 });
    const privacyStore = new FirestorePrivacyRequestStore(db, PRIVACY_KEY.toString("base64"), PRIVACY_SECRET);
    const legalStore = new FirestoreLegalRequestStore(db, LEGAL_SECRET);
    const incidentStore = new FirestoreSecurityIncidentStore(db, INCIDENT_KEY.toString("base64"), INCIDENT_SECRET);
    const [contentQueue, privacyQueue, legalQueue, incidentQueue] = await Promise.all([
      contentStore.listOperatorQueue(actor), privacyStore.listOperatorQueue(actor), legalStore.listOperatorQueue(actor), incidentStore.listOperatorQueue(actor),
    ]);
    for (const queue of [contentQueue, privacyQueue, legalQueue, incidentQueue]) {
      assert.equal(queue.items.length, 100);
      assert.equal(queue.truncated, true);
    }
    assert.deepEqual(Object.keys(contentQueue.items[0]!).sort(), ["clientSubmissionId", "contentVersion", "createdAt", "itemId", "reason", "status", "trackId", "updatedAt"].sort());
    assert.equal(contentQueue.items.some((item) => item.status === "closed"), true);
    assert.equal("description" in contentQueue.items[0]!, false);
    assert.equal("context" in contentQueue.items[0]!, false);
    assert.equal("email" in privacyQueue.items[0]!, false);
    assert.equal("narrative" in legalQueue.items[0]!, false);
    assert.equal("response" in legalQueue.items[0]!, false);
    assert.equal("title" in incidentQueue.items[0]!, false);
    assert.equal("assessment" in incidentQueue.items[0]!, false);

    const pseudonym = createHmac("sha256", REPORT_SECRET).update(`content-report-actor\0${actor}`, "utf8").digest("base64url");
    const privacyPseudonym = createHmac("sha256", PRIVACY_SECRET).update(`actor:${actor}`, "utf8").digest("hex");
    const legalPseudonym = createHmac("sha256", LEGAL_SECRET).update(`legal-request-actor\0${actor}`, "utf8").digest("base64url");
    const incidentPseudonym = createHmac("sha256", INCIDENT_SECRET).update(actor, "utf8").digest("base64url");
    const returnedReportId = contentQueue.items.find((item) => reportIds.includes(item.clientSubmissionId))!.clientSubmissionId;
    const reportAudit = await reports.doc(returnedReportId).collection("audit").where("event", "==", "operator_queue_read").get();
    assert.equal(reportAudit.docs.some((document) => document.get("actorPseudonym") === pseudonym), true);
    const returnedPrivacyId = privacyQueue.items.find((item) => privacyIds.includes(item.requestId))!.requestId;
    const privacyAudit = await privacy.doc(returnedPrivacyId).collection("audit").where("event", "==", "operator_queue_read").get();
    assert.ok(privacyAudit.docs.some((document) => document.get("actorPseudonym") === privacyPseudonym));
    const returnedLegalId = legalQueue.items.find((item) => legalIds.includes(item.requestId))!.requestId;
    const legalAudit = await legal.doc(returnedLegalId).collection("audit").where("action", "==", "operator_queue_read").get();
    assert.ok(legalAudit.docs.some((document) => document.get("actorPseudonym") === legalPseudonym));
    const returnedIncidentId = incidentQueue.items.find((item) => incidentIds.includes(item.incidentId))!.incidentId;
    const incidentAudit = await incidents.doc(returnedIncidentId).collection("audit").where("event", "==", "operator_queue_read").get();
    assert.ok(incidentAudit.docs.some((document) => document.get("actorPseudonym") === incidentPseudonym));

    for (const [collection, items, idField, eventField] of [
      [reports, contentQueue.items, "clientSubmissionId", "event"],
      [privacy, privacyQueue.items, "requestId", "event"],
      [legal, legalQueue.items, "requestId", "action"],
      [incidents, incidentQueue.items, "incidentId", "event"],
    ] as const) {
      const audits = await Promise.all(items.map(async (item) => {
        const id = (item as unknown as Record<string, unknown>)[idField];
        assert.equal(typeof id, "string");
        return collection.doc(String(id)).collection("audit").where(eventField, "==", "operator_queue_read").get();
      }));
      assert.equal(audits.length, 100);
      assert.ok(audits.every((audit) => audit.size === 1), "every returned row must have exactly one read audit");
      assert.ok(audits.every((audit) => typeof audit.docs[0]!.get("actorPseudonym") === "string" && audit.docs[0]!.get("actorPseudonym") !== actor));
    }

    await reports.doc(returnedReportId).update({ accountId: "private-account", contactEmail: "private@example.com" });
    const detail = await contentStore.readOperator(returnedReportId, actor);
    assert.equal(detail?.status, "closed");
    assert.equal(detail?.description, "private narrative must not appear in operator queue");
    assert.equal(detail?.context.releasePackageId, "pkg-1");
    assert.equal(detail?.linkage, "account_and_contact");
    assert.equal(JSON.stringify(detail).includes("private-account"), false);
    assert.equal(JSON.stringify(detail).includes("private@example.com"), false);
    assert.equal((await reports.doc(returnedReportId).collection("audit").where("event", "==", "operator_details_read").get()).size, 1);

    const casId = randomUUID();
    await reports.doc(casId).create({ ...reportRecord(casId, 500), status: "open" });
    const outcomes = await Promise.allSettled([
      contentStore.transitionStatus(casId, actor, "in_review", "open"),
      contentStore.transitionStatus(casId, actor, "in_review", "open"),
    ]);
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((result) => result.status === "rejected" && /content_report_status_conflict/u.test(String(result.reason))).length, 1);
  } finally {
    await deleteApp(app);
  }
});

test("operator privacy email fence has no public writes while safe public review remains available", { skip: enabled ? false : "requires explicit isolated OPS_B2_EMULATOR_TESTS=1 gate" }, async () => {
  const { app, db } = emulatorDatabase();
  try {
    const store = new FirestorePrivacyRequestStore(db, PRIVACY_KEY.toString("base64"), PRIVACY_SECRET);
    const requestRef = db.collection("privacyRequests").doc(`pr_${randomUUID()}`);
    const secretRef = db.collection("privacyRequestSecrets").doc(requestRef.id);
    const receivedAt = Timestamp.now();
    const record = {
      requestId: requestRef.id, channel: "public", userId: null, subjectPseudonym: "pseudonym", right: "access", status: "received", outcome: null,
      receivedAt, deadlineAt: Timestamp.fromMillis(receivedAt.toMillis() + 86_400_000), extendedAt: null, responsePreparedAt: null,
      deliveredAt: null, closedAt: null, revision: 0, createdAt: receivedAt, updatedAt: receivedAt, subjectVerifiedAt: receivedAt,
    };
    await requestRef.create(record);
    await secretRef.create({ payload: encryptPrivacySecret({ email: "private@example.com", narrative: null, reportSubmissionIds: [] }), expiresAt: Timestamp.fromMillis(receivedAt.toMillis() + 86_400_000) });
    let sends = 0;
    const sender: PrivacyRequestEmailSender = { send: async () => { sends += 1; } };
    await assert.rejects(store.transitionAdmin(requestRef.id, "operator", { action: "retry_extension_notice", expectedRevision: 0 }, sender, true), /privacy_request_operator_action_unavailable/u);
    assert.equal(sends, 0);
    const afterBlocked = await requestRef.get();
    assert.equal(afterBlocked.get("revision"), 0);
    assert.equal(afterBlocked.get("verificationTokenHash"), undefined);

    for (const action of [
      { action: "extend", expectedRevision: 0, reason: "needs additional review", noticeLocale: "en" },
      { action: "deliver", expectedRevision: 0 },
    ] as const) {
      const state = action.action === "deliver"
        ? { ...record, status: "response_ready", outcome: "refused", responsePreparedAt: receivedAt }
        : record;
      await requestRef.set(state);
      const before = await requestRef.get();
      const secretBefore = await secretRef.get();
      await assert.rejects(store.transitionAdmin(requestRef.id, "operator", action, sender, true), /privacy_request_operator_action_unavailable/u);
      assert.deepEqual((await requestRef.get()).data(), before.data(), "blocked public mail action must not change its request");
      assert.deepEqual((await secretRef.get()).data(), secretBefore.data(), "blocked public mail action must not reserve a new token");
      assert.equal(sends, 0);
    }
    await requestRef.set(record);
    const safe = await store.transitionAdmin(requestRef.id, "operator", { action: "start_review", expectedRevision: 0 }, sender, true);
    assert.equal(safe.status, "in_review");
    assert.equal(sends, 0);
  } finally {
    await deleteApp(app);
  }
});

test("stable incident caller UUID replays exact payload and rejects changed payload", { skip: enabled ? false : "requires explicit isolated OPS_B2_EMULATOR_TESTS=1 gate" }, async () => {
  const { app, db } = emulatorDatabase();
  try {
    const store = new FirestoreSecurityIncidentStore(db, INCIDENT_KEY.toString("base64"), INCIDENT_SECRET);
    const clientIncidentId = randomUUID();
    const payload = { title: "Incident title", details: "Incident description", severity: "high" };
    const created = await store.create("operator", payload, clientIncidentId);
    const replay = await store.create("operator", payload, clientIncidentId);
    assert.equal(replay.incidentId, created.incidentId);
    assert.equal(replay.revision, created.revision);
    const reordered = await store.create("operator", { severity: "high", details: "Incident description", title: "Incident title" }, clientIncidentId);
    assert.equal(reordered.incidentId, created.incidentId, "object key order is not a new payload");
    const incidentRef = db.collection("securityIncidents").doc(created.incidentId);
    assert.equal((await incidentRef.collection("audit").where("event", "==", "incident_created").get()).size, 1);
    await incidentRef.update({ revision: 1 });
    const laterReplay = await store.create("operator", payload, clientIncidentId);
    assert.equal(laterReplay.revision, 1, "replaying creation must not reset subsequent state");
    assert.equal((await incidentRef.collection("audit").where("event", "==", "incident_created").get()).size, 1);
    await assert.rejects(store.create("operator", { ...payload, severity: "low" }, clientIncidentId), /security_incident_idempotency_conflict/u);
  } finally {
    await deleteApp(app);
  }
});


test("legal non-email actions need no sender and unavailable answer leaves no effects", { skip: enabled ? false : "requires explicit isolated OPS_B2_EMULATOR_TESTS=1 gate" }, async () => {
  const { app, db } = emulatorDatabase();
  try {
    const store = new FirestoreLegalRequestStore(db, LEGAL_SECRET);
    const ref = db.collection("legalRequests").doc(`lr_${randomUUID()}`);
    const at = Timestamp.now();
    await ref.create({ requestId: ref.id, kind: "complaint", email: "private@example.com", narrative: "Purchase complaint context", transactionId: "tx-context", status: "received", receivedAt: at, responseDueAt: null, answeredAt: null, retentionUntil: null, expiresAt: null, legalHold: false, revision: 0, createdAt: at, updatedAt: at });
    const reviewed = await store.transitionAdmin(ref.id, "operator", { action: "start_review", expectedRevision: 0 }, null);
    assert.equal(reviewed.status, "in_review");
    const before = (await ref.get()).data();
    const auditBefore = (await ref.collection("audit").get()).size;
    await assert.rejects(store.transitionAdmin(ref.id, "operator", { action: "answer", expectedRevision: 1, response: "Meaningful response" }, null), /legal_request_email_unavailable/u);
    assert.deepEqual((await ref.get()).data(), before);
    assert.equal((await ref.collection("audit").get()).size, auditBefore);
    const held = await store.transitionAdmin(ref.id, "operator", { action: "set_legal_hold", expectedRevision: 1, active: true, reason: "Dispute pending" }, null);
    assert.equal(held.legalHold, true);
    await ref.update({ status: "answered" });
    const closed = await store.transitionAdmin(ref.id, "operator", { action: "close", expectedRevision: 2 }, null);
    assert.equal(closed.status, "closed");
  } finally {
    await deleteApp(app);
  }
});
