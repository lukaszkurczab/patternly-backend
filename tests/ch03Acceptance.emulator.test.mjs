import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { buildApplication } from "../src/api/app.ts";
import { loadEnvironment } from "../src/config/environment.ts";
import { FirestoreLegalRequestStore } from "../src/modules/legal-requests/store.ts";
import { FirestoreSecurityIncidentStore } from "../src/modules/security-incidents/store.ts";

const enabled = process.env.CH03_FIRESTORE_TESTS === "1";
if (enabled && (process.env.FIREBASE_PROJECT_ID !== "demo-patternly-ch03" || process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:18081")) throw Error("ch03_isolated_emulator_required");
const options = { skip: enabled ? false : "requires isolated CH-03 emulator configuration" };
const input = { title: "safe", details: "synthetic", detectedAt: "2026-01-01T00:00:00.000Z", categories: "availability", dataSubjectCount: "1", recordCount: "1", specialData: false, confidentialityImpact: "none", integrityImpact: "none", availabilityImpact: "low", consequences: "none", likelihood: "low", severity: "low", containment: "contained", remediation: "done", prevention: "updated", postmortem: "complete" };
const audit = async (ref) => (await ref.collection("audit").get()).size;
const oldAwareness = () => Timestamp.fromMillis(Date.now() - 71 * 3600 * 1000);
function legalRecord(id) {
  const now = Timestamp.now();
  return { requestId: id, userId: "synthetic", email: "private@example.test", narrative: null, transactionId: null, kind: "complaint", status: "received", response: null, receivedAt: now, responseDueAt: null, answeredAt: null, closedAt: null, retentionUntil: null, expiresAt: null, legalHold: false, revision: 0, createdAt: now, updatedAt: now };
}
function context() {
  const app = initializeApp({ projectId: "demo-patternly-ch03" }, `ch03-acceptance-${randomUUID()}`);
  const db = getFirestore(app), ids = [];
  const legal = new FirestoreLegalRequestStore(db, "ch03-legal-audit-secret-0123456789");
  const incidents = new FirestoreSecurityIncidentStore(db, Buffer.alloc(32, 37).toString("base64"), "ch03-security-audit-secret-0123456789");
  return { db, legal, incidents, ids, async createIncident() { const item = await incidents.create("actor", input); ids.push(item.incidentId); return item; }, async createLegal() { const id = `lr_${randomUUID()}`; ids.push(id); const ref = db.collection("legalRequests").doc(id); await ref.create(legalRecord(id)); return ref; }, async close() {
    for (const id of ids) {
      const ref = db.collection(id.startsWith("lr_") ? "legalRequests" : "securityIncidents").doc(id);
      for (const doc of (await ref.collection("audit").get()).docs) await doc.ref.delete();
      await ref.delete();
      if (!id.startsWith("lr_")) {
        await db.collection("securityIncidentSecrets").doc(id).delete();
        for (const collection of ["securityIncidentArtifacts", "securityIncidentDeliveries", "securityIncidentDeliveryKeys", "securityIncidentReminders"]) for (const doc of (await db.collection(collection).where("incidentId", "==", id).get()).docs) await doc.ref.delete();
      }
    }
    await db.terminate(); await deleteApp(app);
  } };
}

test("CH-03 production operator routes reject corrupt records without effects", options, async () => {
  const c = context();
  const environment = loadEnvironment({ NODE_ENV: "test", HOST: "127.0.0.1", PORT: "8080", LOG_LEVEL: "silent", REPORT_RATE_LIMIT_HASH_SECRET: "ch03-route-report-secret-0123456789", DELETION_PSEUDONYM_KEYS_JSON: "[]", PRIVACY_RESPONSE_KEY_BASE64: "ch03-route-key", PRIVACY_AUDIT_HMAC_SECRET: "ch03-route-privacy-secret-0123456789" });
  let sends = 0;
  // Only authorization is a seam: handlers, serialization and stores are production paths.
  const api = buildApplication({ environment, firestore: null, verifier: null, appCheckVerifier: null, operatorTokenVerifier: { verifyAndAuthorize: async (_token, action) => ({ actorPseudonym: "ch03-route-actor", role: "privacy_operator", action }) }, stores: { legalRequests: c.legal, securityIncidents: c.incidents }, legalRequestEmailSender: { send: async () => { sends++; } }, securityIncidentEmailSender: { send: async () => { sends++; } } });
  const call = (method, url, payload) => api.inject({ method, url, headers: { authorization: "Bearer synthetic" }, ...(payload ? { payload } : {}) });
  try {
    const legalRef = await c.createLegal(); await legalRef.update({ kind: null });
    const item = await c.createIncident(), incidentRef = c.db.collection("securityIncidents").doc(item.incidentId);
    await incidentRef.update({ authorityDecision: null, awarenessAt: oldAwareness() });
    const beforeIncident = await audit(incidentRef);
    for (const [resource, ref, action, code, before] of [["legal-requests", legalRef, { action: "start_review", expectedRevision: 0 }, "legal_request_record_invalid", 0], ["security-incidents", incidentRef, { action: "acknowledge_awareness", expectedRevision: 0 }, "security_incident_record_invalid", beforeIncident]]) {
      for (const url of [`/v1/operator/${resource}`, `/v1/operator/${resource}/${ref.id}`]) { const result = await call("GET", url); assert.equal(result.statusCode, 500); assert.equal(result.json().error.code, "internal_error"); assert.ok(result.json().error.correlationId); }
      const result = await call("PATCH", `/v1/operator/${resource}/${ref.id}`, action); assert.equal(result.statusCode, 409); assert.equal(result.json().error.code, code);
      assert.equal((await ref.get()).get("revision"), 0); assert.equal(await audit(ref), before);
    }
    assert.equal(sends, 0);
    assert.equal((await c.db.collection("securityIncidentReminders").where("incidentId", "==", item.incidentId).get()).size, 0);
    const nested = await c.createIncident(), nestedRef = c.db.collection("securityIncidents").doc(nested.incidentId);
    await nestedRef.update({ awarenessAt: oldAwareness() });
    await c.db.collection("securityIncidentDeliveries").doc(randomUUID()).create({ incidentId: nested.incidentId, snapshotVersion: 1, recipientPseudonym: "pseudonym", status: null, createdAt: Timestamp.now() });
    const before = await audit(nestedRef), result = await call("GET", `/v1/operator/security-incidents/${nested.incidentId}`);
    assert.equal(result.statusCode, 500); assert.equal(result.json().error.code, "internal_error"); assert.equal(await audit(nestedRef), before);
    assert.equal((await c.db.collection("securityIncidentReminders").where("incidentId", "==", nested.incidentId).get()).size, 0);
  } finally { await api.close(); await c.close(); }
});

test("CH-03 missing/null/unknown child status and corrupted sender failure preserve state", options, async () => {
  const c = context();
  try {
    for (const status of [undefined, null, "future_state"]) {
      const item = await c.createIncident(), ref = c.db.collection("securityIncidents").doc(item.incidentId);
      await ref.update({ awarenessAt: oldAwareness() });
      await c.db.collection("securityIncidentDeliveries").doc(randomUUID()).create({ incidentId: item.incidentId, snapshotVersion: 1, recipientPseudonym: "p", createdAt: Timestamp.now(), ...(status === undefined ? {} : { status }) });
      const before = await audit(ref); await assert.rejects(c.incidents.readAdmin(item.incidentId, "actor"), /security_incident_record_invalid/u); assert.equal(await audit(ref), before);
      assert.equal((await c.db.collection("securityIncidentReminders").where("incidentId", "==", item.incidentId).get()).size, 0);
    }
    const ref = await c.createLegal(); let sends = 0;
    await assert.rejects(c.legal.transitionAdmin(ref.id, "actor", { action: "answer", expectedRevision: 0, response: "controlled" }, { send: async () => { sends++; await ref.update({ status: "corrupt" }); throw Error("controlled smtp failure"); } }), /legal_request_record_invalid/u);
    const state = await ref.get(); assert.equal(sends, 1); assert.equal(state.get("answerDeliveryStatus"), "pending"); assert.equal(state.get("pendingResponse"), "controlled"); assert.equal(state.get("revision"), 1); assert.equal(await audit(ref), 1);
  } finally { await c.close(); }
});

test("CH-03 malformed child status blocks ordinary action and SMTP preflight", options, async () => {
  const c = context();
  try {
    const item = await c.createIncident(), ref = c.db.collection("securityIncidents").doc(item.incidentId);
    await c.db.collection("securityIncidentDeliveries").doc(randomUUID()).create({ incidentId: item.incidentId, snapshotVersion: 1, recipientPseudonym: "bad", status: "future_status", createdAt: Timestamp.now() });
    const before = await audit(ref); await assert.rejects(c.incidents.act(item.incidentId, "actor", { action: "acknowledge_awareness", expectedRevision: 0 }, null), /security_incident_record_invalid/u);
    assert.equal((await ref.get()).get("revision"), 0); assert.equal(await audit(ref), before);
    const sendItem = await c.createIncident(); await c.incidents.act(sendItem.incidentId, "actor", { action: "decide_subject", decision: "required", reason: "test", expectedRevision: 0 }, null);
    const prepared = await c.incidents.act(sendItem.incidentId, "actor", { action: "prepare_subject_notification", recipients: ["person@example.test"], subject: "Notice", text: "Body", expectedRevision: 1 }, null);
    const sendRef = c.db.collection("securityIncidents").doc(sendItem.incidentId); await c.db.collection("securityIncidentDeliveries").doc(randomUUID()).create({ incidentId: sendItem.incidentId, snapshotVersion: 1, recipientPseudonym: "bad", status: null, createdAt: Timestamp.now() });
    const audits = await audit(sendRef); let calls = 0; await assert.rejects(c.incidents.act(sendItem.incidentId, "actor", { action: "send_subject_notification", recipientPseudonym: prepared.preparedRecipients[0].recipientPseudonym, snapshotVersion: 1, expectedRevision: 2 }, { send: async () => { calls++; } }), /security_incident_record_invalid/u);
    assert.equal(calls, 0); assert.equal((await sendRef.get()).get("revision"), 2); assert.equal(await audit(sendRef), audits); assert.equal((await c.db.collection("securityIncidentDeliveries").where("incidentId", "==", sendItem.incidentId).get()).size, 1);
  } finally { await c.close(); }
});
