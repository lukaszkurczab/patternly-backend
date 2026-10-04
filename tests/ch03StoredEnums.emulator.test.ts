import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { LEGAL_REQUEST_STATUSES, legalRequestKindSchema, type LegalRequestKind } from "../src/modules/legal-requests/contracts.js";
import { FirestoreLegalRequestStore, type LegalRequestEmailSender } from "../src/modules/legal-requests/store.js";
import { AUTHORITY_DELIVERY_STATUSES, INCIDENT_CLASSIFICATIONS, INCIDENT_DECISIONS, SUBJECT_DELIVERY_STATUSES, SUBJECT_NOTIFICATION_STATUSES } from "../src/modules/security-incidents/contracts.js";
import { FirestoreSecurityIncidentStore, type SecurityIncidentEmailSender } from "../src/modules/security-incidents/store.js";

const PROJECT_ID = "demo-patternly-ch03";
const EMULATOR_HOST = "127.0.0.1:18081";
const enabled = process.env.CH03_FIRESTORE_TESTS === "1"
  && process.env.FIREBASE_PROJECT_ID === PROJECT_ID
  && process.env.FIRESTORE_EMULATOR_HOST === EMULATOR_HOST;
const LEGAL_SECRET = "ch03-only-legal-audit-secret-0123456789";
const INCIDENT_KEY = Buffer.alloc(32, 23).toString("base64");
const INCIDENT_SECRET = "ch03-only-security-audit-secret-0123456789";
const LEGAL_KINDS = legalRequestKindSchema.options;
const DELIVERY_STATES = SUBJECT_DELIVERY_STATUSES;

function stores() {
  const app = initializeApp({ projectId: PROJECT_ID }, `ch03-${randomUUID()}`);
  const db = getFirestore(app);
  return {
    app,
    db,
    legal: new FirestoreLegalRequestStore(db, LEGAL_SECRET),
    incidents: new FirestoreSecurityIncidentStore(db, INCIDENT_KEY, INCIDENT_SECRET),
  };
}

function legalRecord(id: string, overrides: Record<string, unknown> = {}) {
  const receivedAt = Timestamp.fromDate(new Date("2026-01-01T00:00:00.000Z"));
  return {
    requestId: id, userId: "subject-ch03", email: "operator-private@example.com", narrative: null, transactionId: null,
    kind: "complaint", status: "received", response: null, receivedAt, responseDueAt: null, answeredAt: null,
    closedAt: null, retentionUntil: null, expiresAt: null, legalHold: false, revision: 0,
    createdAt: receivedAt, updatedAt: receivedAt, ...overrides,
  };
}

function incidentRecord(overrides: Record<string, unknown> = {}) {
  const now = Timestamp.now();
  return {
    classification: "triage", authorityDecision: "undecided", authorityDeliveryStatus: "not_started",
    subjectDecision: "undecided", subjectNotificationStatus: "not_started", awarenessAt: null,
    authorityDeadlineAt: null, closedAt: null, revision: 0, assessmentVersion: 1,
    legalHold: false, createdAt: now, updatedAt: now, ...overrides,
  };
}

async function deleteSubcollection(ref: FirebaseFirestore.DocumentReference, collection: string): Promise<void> {
  const snapshot = await ref.collection(collection).get();
  if (snapshot.empty) return;
  const batch = ref.firestore.batch();
  snapshot.docs.forEach((document) => batch.delete(document.ref));
  await batch.commit();
}

async function cleanLegal(db: FirebaseFirestore.Firestore, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const ref = db.collection("legalRequests").doc(id);
    await deleteSubcollection(ref, "audit");
    await ref.delete();
  }
}

async function cleanIncident(db: FirebaseFirestore.Firestore, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const ref = db.collection("securityIncidents").doc(id);
    await deleteSubcollection(ref, "audit");
    await Promise.all([
      db.collection("securityIncidentSecrets").doc(id).delete(),
      ...["securityIncidentArtifacts", "securityIncidentDeliveries", "securityIncidentDeliveryKeys", "securityIncidentReminders"].map(async (collection) => {
        const snapshot = await db.collection(collection).where("incidentId", "==", id).get();
        if (snapshot.empty) return;
        const batch = db.batch();
        snapshot.docs.forEach((document) => batch.delete(document.ref));
        await batch.commit();
      }),
      ref.delete(),
    ]);
  }
}

async function countChildren(ref: FirebaseFirestore.DocumentReference, collection: string): Promise<number> {
  return (await ref.collection(collection).get()).size;
}

test("CH-03 legal stores accept every canonical kind and status tuple", { skip: enabled ? false : "requires CH03_FIRESTORE_TESTS=1 and the dedicated demo-patternly-ch03 emulator project" }, async () => {
  const { app, db, legal } = stores();
  const ids: string[] = [];
  const malformedIds: string[] = [];
  try {
    const kinds = LEGAL_KINDS as readonly LegalRequestKind[];
    for (let kindIndex = 0; kindIndex < kinds.length; kindIndex += 1) {
      for (let statusIndex = 0; statusIndex < LEGAL_REQUEST_STATUSES.length; statusIndex += 1) {
        const id = `lr_${randomUUID()}`;
        ids.push(id);
        await db.collection("legalRequests").doc(id).create(legalRecord(id, { kind: kinds[kindIndex], status: LEGAL_REQUEST_STATUSES[statusIndex] }));
      }
    }
    assert.equal((await legal.listAdmin()).length, kinds.length * LEGAL_REQUEST_STATUSES.length);
    assert.equal((await legal.listOperatorQueue("actor-ch03")).items.length, kinds.length * LEGAL_REQUEST_STATUSES.length);
  } finally {
    await cleanLegal(db, ids);
    await deleteApp(app);
  }
});

test("CH-03 legal malformed enums fail detail, transition, and mixed queue before audit or SMTP", { skip: enabled ? false : "requires CH03_FIRESTORE_TESTS=1 and the dedicated demo-patternly-ch03 emulator project" }, async () => {
  const { app, db, legal } = stores();
  const ids: string[] = [];
  const malformedIds: string[] = [];
  let smtpCalls = 0;
  const sender: LegalRequestEmailSender = { send: async () => { smtpCalls += 1; } };
  try {
    const validId = `lr_${randomUUID()}`;
    ids.push(validId);
    await db.collection("legalRequests").doc(validId).create(legalRecord(validId));
    for (const [field, values] of [
      ["kind", [undefined, null, "new_kind"]],
      ["status", [undefined, null, "new_status"]],
    ] as const) {
      for (const value of values) {
        const id = `lr_${randomUUID()}`;
        ids.push(id);
        malformedIds.push(id);
        const invalid = legalRecord(id);
        if (value === undefined) delete (invalid as Record<string, unknown>)[field];
        else (invalid as Record<string, unknown>)[field] = value;
        await db.collection("legalRequests").doc(id).create(invalid);
        const ref = db.collection("legalRequests").doc(id);
        await assert.rejects(legal.readAdmin(id, "actor-ch03"), /legal_request_record_invalid/u);
        assert.equal(await countChildren(ref, "audit"), 0, `detail read made no audit for malformed ${field}`);
        await assert.rejects(legal.transitionAdmin(id, "actor-ch03", { action: "answer", expectedRevision: 0, response: "Answer" }, sender), /legal_request_record_invalid/u);
        assert.equal(smtpCalls, 0);
        assert.equal((await ref.get()).get("revision"), 0);
      }
    }

    const finishId = `lr_${randomUUID()}`;
    ids.push(finishId);
    await db.collection("legalRequests").doc(finishId).create(legalRecord(finishId));
    const corruptOnSuccess: LegalRequestEmailSender = { send: async () => {
      await db.collection("legalRequests").doc(finishId).update({ kind: "corrupt" });
    } };
    await assert.rejects(legal.transitionAdmin(finishId, "actor-ch03", { action: "answer", expectedRevision: 0, response: "Answer" }, corruptOnSuccess), /legal_request_record_invalid/u);
    assert.equal((await db.collection("legalRequests").doc(finishId).get()).get("answerDeliveryStatus"), "pending", "invalid post-SMTP snapshot is not rewritten as failed");

    const ordinaryFailureId = `lr_${randomUUID()}`;
    ids.push(ordinaryFailureId);
    await db.collection("legalRequests").doc(ordinaryFailureId).create(legalRecord(ordinaryFailureId));
    const ordinaryFailure: LegalRequestEmailSender = { send: async () => { throw new Error("provider unavailable"); } };
    await assert.rejects(legal.transitionAdmin(ordinaryFailureId, "actor-ch03", { action: "answer", expectedRevision: 0, response: "Answer" }, ordinaryFailure), /legal_request_email_unavailable/u);
    const failedRecord = await db.collection("legalRequests").doc(ordinaryFailureId).get();
    assert.equal(failedRecord.get("answerDeliveryStatus"), "failed", "ordinary sender failure keeps existing failure semantics");
    assert.equal(failedRecord.get("pendingResponse"), undefined);

    const auditsBeforeQueue = new Map(await Promise.all(ids.map(async (id) => [id, await countChildren(db.collection("legalRequests").doc(id), "audit")] as const)));
    await assert.rejects(legal.listOperatorQueue("actor-ch03"), /legal_request_record_invalid/u);
    for (const id of ids) assert.equal(await countChildren(db.collection("legalRequests").doc(id), "audit"), auditsBeforeQueue.get(id), "mixed queue leaves every selected row's audit count unchanged");
    for (const id of malformedIds) assert.equal(await countChildren(db.collection("legalRequests").doc(id), "audit"), 0, "malformed detail/transition path made no audit");
  } finally {
    await cleanLegal(db, ids);
    await deleteApp(app);
  }
});

test("CH-03 incident stores accept all five canonical parent enum sets", { skip: enabled ? false : "requires CH03_FIRESTORE_TESTS=1 and the dedicated demo-patternly-ch03 emulator project" }, async () => {
  const { app, db, incidents } = stores();
  const ids: string[] = [];
  try {
    const fields = [
      ["classification", INCIDENT_CLASSIFICATIONS],
      ["authorityDecision", INCIDENT_DECISIONS],
      ["authorityDeliveryStatus", AUTHORITY_DELIVERY_STATUSES],
      ["subjectDecision", INCIDENT_DECISIONS],
      ["subjectNotificationStatus", SUBJECT_NOTIFICATION_STATUSES],
    ] as const;
    for (const [field, values] of fields) {
      for (const value of values) {
        const id = `si_${randomUUID()}`;
        ids.push(id);
        await db.collection("securityIncidents").doc(id).create(incidentRecord({ [field]: value }));
      }
    }
    assert.equal((await incidents.listAdmin()).length, ids.length);
    assert.equal((await incidents.listOperatorQueue("actor-ch03")).items.length, ids.length);
    assert.deepEqual(DELIVERY_STATES, ["pending", "sent", "failed", "unknown", "superseded"]);
  } finally {
    await cleanIncident(db, ids);
    await deleteApp(app);
  }
});

test("CH-03 incident malformed parent enums reject list and mixed queue without reminders or audits", { skip: enabled ? false : "requires CH03_FIRESTORE_TESTS=1 and the dedicated demo-patternly-ch03 emulator project" }, async () => {
  const { app, db, incidents } = stores();
  const ids: string[] = [];
  try {
    const fields = ["classification", "authorityDecision", "authorityDeliveryStatus", "subjectDecision", "subjectNotificationStatus"] as const;
    for (const field of fields) {
      for (const value of [undefined, null, "new_status"] as const) {
        const id = `si_${randomUUID()}`;
        ids.push(id);
        const awarenessAt = Timestamp.fromMillis(Date.now() - 71 * 60 * 60 * 1_000);
        const invalid = incidentRecord({ awarenessAt });
        if (value === undefined) delete (invalid as Record<string, unknown>)[field];
        else (invalid as Record<string, unknown>)[field] = value;
        await db.collection("securityIncidents").doc(id).create(invalid);
        // applyAction requires the incident's companion secret document before
        // it validates the parent enums. Keep this opaque: the guard must run
        // before attempting to decrypt it.
        await db.collection("securityIncidentSecrets").doc(id).create({ payload: "opaque-fixture" });
        await assert.rejects(incidents.listAdmin(), /security_incident_record_invalid/u);
        assert.equal((await db.collection("securityIncidentReminders").where("incidentId", "==", id).get()).size, 0, `list made no reminders for malformed ${field}`);
        await assert.rejects(incidents.act(id, "actor-ch03", { action: "acknowledge_awareness", expectedRevision: 0 }, null), /security_incident_record_invalid/u);
        assert.equal(await countChildren(db.collection("securityIncidents").doc(id), "audit"), 0);
      }
    }

    const validId = `si_${randomUUID()}`;
    ids.push(validId);
    await db.collection("securityIncidents").doc(validId).create(incidentRecord());
    await assert.rejects(incidents.listOperatorQueue("actor-ch03"), /security_incident_record_invalid/u);
    for (const id of ids) assert.equal(await countChildren(db.collection("securityIncidents").doc(id), "audit"), 0, "mixed queue validates every row before any queue audit");
  } finally {
    await cleanIncident(db, ids);
    await deleteApp(app);
  }
});

test("CH-03 incident detail/export and delivery paths reject corrupt enums before reminders, audit, SMTP, or delivery finalization", { skip: enabled ? false : "requires CH03_FIRESTORE_TESTS=1 and the dedicated demo-patternly-ch03 emulator project" }, async () => {
  const { app, db, incidents } = stores();
  const ids: string[] = [];
  const senderCalls: string[] = [];
  const sender: SecurityIncidentEmailSender = { send: async (input) => { senderCalls.push(input.recipient); } };
  const input = { title: "CH03 fixture", details: "safe fixture details", detectedAt: "2026-01-01T00:00:00.000Z", categories: "availability", dataSubjectCount: "1", recordCount: "1", specialData: false, confidentialityImpact: "none", integrityImpact: "none", availabilityImpact: "low", consequences: "none", likelihood: "low", severity: "low", containment: "contained", remediation: "done", prevention: "updated", postmortem: "complete" };
  try {
    const reminderId = (await incidents.create("actor-ch03", input)).incidentId;
    ids.push(reminderId);
    await db.collection("securityIncidents").doc(reminderId).update({ awarenessAt: Timestamp.fromMillis(Date.now() - 71 * 60 * 60 * 1_000) });
    await incidents.readAdmin(reminderId, "actor-ch03");
    assert.ok((await db.collection("securityIncidentReminders").where("incidentId", "==", reminderId).get()).size > 0, "valid old awareness materializes due reminders through the real transaction path");

    const nestedValidId = (await incidents.create("actor-ch03", input)).incidentId;
    ids.push(nestedValidId);
    for (let index = 0; index < DELIVERY_STATES.length; index += 1) {
      const deliveryId = randomUUID();
      await db.collection("securityIncidentDeliveries").doc(deliveryId).create({ incidentId: nestedValidId, snapshotVersion: 1, recipientPseudonym: `pseudonym-${index}`, status: DELIVERY_STATES[index], createdAt: Timestamp.now() });
    }
    const nestedValid = await incidents.readAdmin(nestedValidId, "actor-ch03");
    assert.deepEqual(nestedValid?.subjectNotifications.map(({ status }) => status).sort(), [...DELIVERY_STATES].sort(), "detail accepts and returns every canonical nested delivery status");

    const exportId = (await incidents.create("actor-ch03", input)).incidentId;
    ids.push(exportId);
    await incidents.act(exportId, "actor-ch03", { action: "decide_authority", decision: "required", reason: "fixture", expectedRevision: 0 }, null);
    await incidents.act(exportId, "actor-ch03", { action: "prepare_authority_export", payload: "controlled fixture", expectedRevision: 1 }, null);
    const validExport = await incidents.readAuthorityExport(exportId, 1, "actor-ch03");
    assert.equal(validExport?.version, 1, "valid current export can be read");
    const exportRef = db.collection("securityIncidents").doc(exportId);
    const exportAuditBefore = await countChildren(exportRef, "audit");
    await exportRef.update({ subjectDecision: "corrupt" });
    await assert.rejects(incidents.readAuthorityExport(exportId, 1, "actor-ch03"), /security_incident_record_invalid/u);
    assert.equal(await countChildren(exportRef, "audit"), exportAuditBefore, "corrupt parent enum is rejected before export-read audit");

    const detailId = (await incidents.create("actor-ch03", input)).incidentId;
    ids.push(detailId);
    const staleAwareness = Timestamp.fromMillis(Date.now() - 71 * 60 * 60 * 1_000);
    await db.collection("securityIncidents").doc(detailId).update({ awarenessAt: staleAwareness });
    const detailDeliveryId = randomUUID();
    await db.collection("securityIncidentDeliveries").doc(detailDeliveryId).create({ incidentId: detailId, snapshotVersion: 1, recipientPseudonym: "p".repeat(20), status: "corrupt", createdAt: Timestamp.now() });
    const detailRef = db.collection("securityIncidents").doc(detailId);
    const auditBefore = await countChildren(detailRef, "audit");
    await assert.rejects(incidents.readAdmin(detailId, "actor-ch03"), /security_incident_record_invalid/u);
    assert.equal(await countChildren(detailRef, "audit"), auditBefore);
    assert.equal((await db.collection("securityIncidentReminders").where("incidentId", "==", detailId).get()).size, 0, "nested delivery failure occurs before reminder materialization");

    const actionId = (await incidents.create("actor-ch03", input)).incidentId;
    ids.push(actionId);
    await incidents.act(actionId, "actor-ch03", { action: "decide_subject", decision: "required", reason: "fixture", expectedRevision: 0 }, null);
    const prepared = await incidents.act(actionId, "actor-ch03", { action: "prepare_subject_notification", recipients: ["person@example.com"], subject: "Notice", text: "Body", expectedRevision: 1 }, null);
    const recipient = prepared.preparedRecipients[0]!;
    const actionRef = db.collection("securityIncidents").doc(actionId);
    const beforeSendAudit = await countChildren(actionRef, "audit");
    await actionRef.update({ classification: "corrupt" });
    await assert.rejects(incidents.act(actionId, "actor-ch03", { action: "send_subject_notification", recipientPseudonym: recipient.recipientPseudonym, snapshotVersion: 1, expectedRevision: 2 }, sender), /security_incident_record_invalid/u);
    assert.deepEqual(senderCalls, [], "corrupt parent enums cannot reach the external sender");
    assert.equal((await db.collection("securityIncidentDeliveries").where("incidentId", "==", actionId).get()).size, 0);
    assert.equal(await countChildren(actionRef, "audit"), beforeSendAudit);

    const finishId = (await incidents.create("actor-ch03", input)).incidentId;
    ids.push(finishId);
    await incidents.act(finishId, "actor-ch03", { action: "decide_subject", decision: "required", reason: "fixture", expectedRevision: 0 }, null);
    const finishPrepared = await incidents.act(finishId, "actor-ch03", { action: "prepare_subject_notification", recipients: ["person@example.com"], subject: "Notice", text: "Body", expectedRevision: 1 }, null);
    const finishRecipient = finishPrepared.preparedRecipients[0]!;
    const corruptDuringDelivery: SecurityIncidentEmailSender = { send: async () => { await db.collection("securityIncidents").doc(finishId).update({ classification: null }); } };
    await assert.rejects(incidents.act(finishId, "actor-ch03", { action: "send_subject_notification", recipientPseudonym: finishRecipient.recipientPseudonym, snapshotVersion: 1, expectedRevision: 2 }, corruptDuringDelivery), /security_incident_record_invalid/u);
    const pendingDelivery = await db.collection("securityIncidentDeliveries").where("incidentId", "==", finishId).get();
    assert.equal(pendingDelivery.size, 1);
    assert.equal(pendingDelivery.docs[0]?.get("status"), "pending", "invalid finish read does not relabel pending delivery failed or unknown");
  } finally {
    await cleanIncident(db, ids);
    await deleteApp(app);
  }
});
