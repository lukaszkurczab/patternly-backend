import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { getFirestore } from "firebase-admin/firestore";
import { clearFirestore, createEmulatorContext, createVerifiedAuthUser } from "./support.js";

const context = createEmulatorContext();
after(async () => context.close());
beforeEach(async () => { await clearFirestore(); });
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const incidentInput = (title = "Incident") => ({ title, details: "sensitive facts", detectedAt: "2026-09-07T10:00:00.000Z", containedAt: "2026-09-07T11:00:00.000Z", categories: "account data", dataSubjectCount: "1", recordCount: "1", specialData: false, confidentialityImpact: "low", integrityImpact: "none", availabilityImpact: "none", consequences: "review", likelihood: "low", severity: "low", containment: "contained", remediation: "fixed", prevention: "monitor", postmortem: "reviewed" });

async function administrator() {
  const user = await createVerifiedAuthUser("lukasz.kurczab@gmail.com");
  const response = await context.app.inject({ method: "GET", url: "/v1/me", headers: auth(user.idToken) });
  assert.equal(response.statusCode, 200);
  return user;
}

test("incident register is admin-only, list/audit contain no sensitive details, and awareness cannot change", async () => {
  const admin = await administrator();
  const created = await context.app.inject({ method: "POST", url: "/v1/admin/security-incidents", headers: auth(admin.idToken), payload: { ...incidentInput("Unexpected disclosure"), details: "secret recipient@example.com and assessment" } });
  assert.equal(created.statusCode, 201);
  const incidentId = created.json().incident.incidentId as string;
  const listed = await context.app.inject({ method: "GET", url: "/v1/admin/security-incidents", headers: auth(admin.idToken) });
  assert.equal(listed.statusCode, 200);
  assert.equal(JSON.stringify(listed.json()).includes("recipient@example.com"), false);
  const acknowledged = await context.app.inject({ method: "PATCH", url: `/v1/admin/security-incidents/${incidentId}`, headers: auth(admin.idToken), payload: { action: "acknowledge_awareness", expectedRevision: 0 } });
  assert.equal(acknowledged.statusCode, 200);
  assert.ok(acknowledged.json().incident.authorityDeadlineAt);
  const immutable = await context.app.inject({ method: "PATCH", url: `/v1/admin/security-incidents/${incidentId}`, headers: auth(admin.idToken), payload: { action: "acknowledge_awareness", expectedRevision: 1 } });
  assert.equal(immutable.statusCode, 409);
  const audit = await getFirestore().collection("securityIncidents").doc(incidentId).collection("audit").get();
  assert.equal(JSON.stringify(audit.docs.map((doc) => doc.data())).includes("recipient@example.com"), false);
});

test("incident closure requires explicit decisions and a manual authority submission", async () => {
  const admin = await administrator();
  const created = await context.app.inject({ method: "POST", url: "/v1/admin/security-incidents", headers: auth(admin.idToken), payload: incidentInput() });
  const id = created.json().incident.incidentId as string;
  const headers = auth(admin.idToken);
  const patch = async (payload: object) => context.app.inject({ method: "PATCH", url: `/v1/admin/security-incidents/${id}`, headers, payload });
  assert.equal((await patch({ action: "close", expectedRevision: 0 })).statusCode, 409);
  assert.equal((await patch({ action: "acknowledge_awareness", expectedRevision: 0 })).statusCode, 200);
  assert.equal((await patch({ action: "classify", classification: "breach_confirmed", reason: "confirmed", expectedRevision: 1 })).statusCode, 200);
  assert.equal((await patch({ action: "decide_authority", decision: "required", reason: "high risk", expectedRevision: 2 })).statusCode, 200);
  assert.equal((await patch({ action: "prepare_authority_export", payload: "UODO payload", expectedRevision: 3 })).statusCode, 200);
  assert.equal((await patch({ action: "record_authority_submission", channel: "UODO portal", reference: "REF-1", evidence: "receipt", expectedRevision: 4 })).statusCode, 200);
  assert.equal((await patch({ action: "decide_subject", decision: "not_required", reason: "exception", legalException: "Article 34 exception", expectedRevision: 5 })).statusCode, 200);
  const closed = await patch({ action: "close", expectedRevision: 6 });
  assert.equal(closed.statusCode, 200);
  assert.equal(closed.json().incident.closedAt !== null, true);
});

test("subject notification fails closed without the separate incident sender", async () => {
  const admin = await administrator();
  const created = await context.app.inject({ method: "POST", url: "/v1/admin/security-incidents", headers: auth(admin.idToken), payload: incidentInput() });
  const id = created.json().incident.incidentId as string; const headers = auth(admin.idToken);
  const patch = async (payload: object) => context.app.inject({ method: "PATCH", url: `/v1/admin/security-incidents/${id}`, headers, payload });
  await patch({ action: "decide_subject", decision: "required", reason: "high risk", expectedRevision: 0 });
  const prepared = await patch({ action: "prepare_subject_notification", recipients: ["person@example.com"], subject: "Notice", text: "Details", expectedRevision: 1 });
  assert.equal(prepared.statusCode, 200);
  const pseudonym = (await context.stores.securityIncidents.readAdmin(id, "admin"))!.subjectNotifications;
  assert.equal(pseudonym.length, 0);
  const artifact = await getFirestore().collection("securityIncidentArtifacts").doc(`subject_snapshot_${id}_1`).get();
  assert.equal(JSON.stringify(artifact.data()).includes("person@example.com"), false);
  const payload = await context.app.inject({ method: "PATCH", url: `/v1/admin/security-incidents/${id}`, headers, payload: { action: "send_subject_notification", recipientPseudonym: "a".repeat(16), snapshotVersion: 1, expectedRevision: 2 } });
  assert.equal(payload.statusCode, 503);
});

test("reconcile turns stale pending notification into unknown without retrying it", async () => {
  const admin = await administrator();
  const created = await context.app.inject({ method: "POST", url: "/v1/admin/security-incidents", headers: auth(admin.idToken), payload: incidentInput() });
  const id = created.json().incident.incidentId as string; const headers = auth(admin.idToken);
  const patch = async (payload: object) => context.app.inject({ method: "PATCH", url: `/v1/admin/security-incidents/${id}`, headers, payload });
  await patch({ action: "decide_subject", decision: "required", reason: "risk", expectedRevision: 0 });
  await patch({ action: "prepare_subject_notification", recipients: ["person@example.com"], subject: "Notice", text: "Details", expectedRevision: 1 });
  await getFirestore().collection("securityIncidentDeliveries").doc("00000000-0000-4000-8000-000000000001").set({ incidentId: id, snapshotVersion: 1, recipientPseudonym: "x".repeat(16), status: "pending", createdAt: new Date(Date.now() - 16 * 60 * 1_000) });
  const reconciled = await patch({ action: "reconcile_subject_notifications", expectedRevision: 2 });
  assert.equal(reconciled.statusCode, 200);
  assert.equal(reconciled.json().incident.subjectNotificationStatus, "unknown");
  const delivery = await getFirestore().collection("securityIncidentDeliveries").doc("00000000-0000-4000-8000-000000000001").get();
  assert.equal(delivery.data()?.status, "unknown");
});

test("hold and release recalculate expiry for audit records created before and after closure", async () => {
  const store = context.stores.securityIncidents;
  const created = await store.create("admin", incidentInput()); const id = created.incidentId;
  await store.act(id, "admin", { action: "acknowledge_awareness", expectedRevision: 0 }, null);
  await store.act(id, "admin", { action: "classify", classification: "not_a_breach", reason: "confirmed", expectedRevision: 1 }, null);
  await store.act(id, "admin", { action: "decide_authority", decision: "not_required", reason: "exception", legalException: "documented", expectedRevision: 2 }, null);
  await store.act(id, "admin", { action: "decide_subject", decision: "not_required", reason: "exception", legalException: "documented", expectedRevision: 3 }, null);
  await store.act(id, "admin", { action: "close", expectedRevision: 4 }, null);
  await store.readAdmin(id, "admin");
  const beforeHold = await getFirestore().collection("securityIncidents").doc(id).collection("audit").get();
  assert.ok(beforeHold.docs.every((doc) => doc.data().expiresAt));
  await store.act(id, "admin", { action: "set_legal_hold", reason: "legal hold", expectedRevision: 5 }, null);
  await store.readAdmin(id, "admin");
  const held = await getFirestore().collection("securityIncidents").doc(id).collection("audit").get();
  assert.ok(held.docs.every((doc) => doc.data().expiresAt === null || doc.data().expiresAt === undefined));
  await store.act(id, "admin", { action: "release_legal_hold", reason: "release", expectedRevision: 6 }, null);
  await store.readAdmin(id, "admin");
  const released = await getFirestore().collection("securityIncidents").doc(id).collection("audit").get();
  assert.ok(released.docs.every((doc) => doc.data().expiresAt));
});

test("old asynchronous delivery cannot overwrite a newer notification snapshot", async () => {
  const store = context.stores.securityIncidents;
  const created = await store.create("admin", incidentInput()); const id = created.incidentId;
  await store.act(id, "admin", { action: "decide_subject", decision: "required", reason: "risk", expectedRevision: 0 }, null);
  await store.act(id, "admin", { action: "prepare_subject_notification", recipients: ["first@example.com"], subject: "Notice", text: "One", expectedRevision: 1 }, null);
  const first = (await store.readAdmin(id, "admin"))!.preparedRecipients[0]!;
  let resolveSend: (() => void) | undefined;
  const sender = { send: async () => new Promise<void>((resolve) => { resolveSend = resolve; }) };
  const sending = store.act(id, "admin", { action: "send_subject_notification", recipientPseudonym: first.recipientPseudonym, snapshotVersion: 1, expectedRevision: 2 }, sender);
  for (let index = 0; index < 20 && !resolveSend; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(resolveSend);
  await store.act(id, "admin", { action: "prepare_subject_notification", recipients: ["second@example.com"], subject: "Notice", text: "Two", expectedRevision: 3 }, null);
  resolveSend!(); await sending;
  const after = await store.readAdmin(id, "admin");
  assert.equal(after?.revision, 4);
  assert.equal(after?.subjectNotificationStatus, "prepared");
});

test("closure requires a sent delivery for every prepared recipient", async () => {
  const store = context.stores.securityIncidents;
  const created = await store.create("admin", incidentInput()); const id = created.incidentId;
  await store.act(id, "admin", { action: "acknowledge_awareness", expectedRevision: 0 }, null);
  await store.act(id, "admin", { action: "classify", classification: "breach_confirmed", reason: "confirmed", expectedRevision: 1 }, null);
  await store.act(id, "admin", { action: "decide_authority", decision: "not_required", reason: "exception", legalException: "documented", expectedRevision: 2 }, null);
  await store.act(id, "admin", { action: "decide_subject", decision: "required", reason: "risk", expectedRevision: 3 }, null);
  await store.act(id, "admin", { action: "prepare_subject_notification", recipients: ["one@example.com", "two@example.com"], subject: "Notice", text: "Details", expectedRevision: 4 }, null);
  const recipients = (await store.readAdmin(id, "admin"))!.preparedRecipients;
  await getFirestore().collection("securityIncidentDeliveries").doc("00000000-0000-4000-8000-000000000011").set({ incidentId: id, snapshotVersion: 1, recipientPseudonym: recipients[0]!.recipientPseudonym, status: "sent", createdAt: new Date() });
  await assert.rejects(store.act(id, "admin", { action: "close", expectedRevision: 5 }, null), /security_incident_close_incomplete/u);
  await getFirestore().collection("securityIncidentDeliveries").doc("00000000-0000-4000-8000-000000000012").set({ incidentId: id, snapshotVersion: 1, recipientPseudonym: recipients[1]!.recipientPseudonym, status: "sent", createdAt: new Date() });
  const closed = await store.act(id, "admin", { action: "close", expectedRevision: 5 }, null);
  assert.ok(closed.closedAt);
});
