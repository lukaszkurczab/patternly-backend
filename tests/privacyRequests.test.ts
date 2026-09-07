import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { getFirestore } from "firebase-admin/firestore";
import { clearFirestore, createEmulatorContext, createVerifiedAuthUser } from "./support.js";

const context = createEmulatorContext();
after(async () => context.close());
beforeEach(async () => { await clearFirestore(); });

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function provision(email?: string) {
  const user = await createVerifiedAuthUser(email);
  const response = await context.app.inject({ method: "GET", url: "/v1/me", headers: auth(user.idToken) });
  assert.equal(response.statusCode, 200);
  return { ...user, userId: response.json().user.id as string };
}

test("account request has an isolated lifecycle and serves a prepared response only to its owner", async () => {
  const subject = await provision();
  const other = await provision();
  const administrator = await provision("lukasz.kurczab@gmail.com");
  const created = await context.app.inject({ method: "POST", url: "/v1/privacy-requests", headers: auth(subject.idToken), payload: { right: "access", narrative: "Please provide my data" } });
  assert.equal(created.statusCode, 201);
  const requestId = created.json().request.requestId as string;

  const list = await context.app.inject({ method: "GET", url: "/v1/privacy-requests", headers: auth(subject.idToken) });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().requests[0].requestId, requestId);
  assert.equal(JSON.stringify(list.json()).includes("Please provide"), false);

  const denied = await context.app.inject({ method: "GET", url: `/v1/privacy-requests/${requestId}`, headers: auth(other.idToken) });
  assert.equal(denied.statusCode, 404);

  const adminHeaders = auth(administrator.idToken);
  const adminList = await context.app.inject({ method: "GET", url: "/v1/admin/privacy-requests", headers: adminHeaders });
  assert.equal(adminList.statusCode, 200);
  assert.equal(JSON.stringify(adminList.json()).includes("Please provide"), false);
  const details = await context.app.inject({ method: "GET", url: `/v1/admin/privacy-requests/${requestId}`, headers: adminHeaders });
  assert.equal(details.statusCode, 200);
  assert.equal(details.json().request.narrative, "Please provide my data");

  const start = await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers: adminHeaders, payload: { action: "start_review", expectedRevision: 0 } });
  assert.equal(start.statusCode, 200);
  await getFirestore().collection("users").doc(subject.userId).collection("progress").doc("large-state").set({ kind: "item", recordType: "training_attempt", trackId: "track", targetId: "large", version: 1, fingerprint: "a".repeat(64), state: { notes: "x".repeat(200_000) }, lastMutationId: "large-mutation", updatedAt: new Date() });
  const falseFulfilment = await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers: adminHeaders, payload: { action: "prepare_response", expectedRevision: 1, outcome: "fulfilled", response: "Article 15 response", reason: "Request fulfilled", complaintInformationIncluded: true, executionEvidence: "data-export:fixture" } });
  assert.equal(falseFulfilment.statusCode, 409);
  const prepare = await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers: adminHeaders, payload: { action: "execute_export", expectedRevision: 1 } });
  assert.equal(prepare.statusCode, 200);
  const repeatedExecution = await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers: adminHeaders, payload: { action: "execute_export", expectedRevision: 1 } });
  assert.equal(repeatedExecution.statusCode, 409);
  assert.equal(prepare.json().request.status, "response_ready");
  const beforeDelivery = await context.app.inject({ method: "GET", url: `/v1/privacy-requests/${requestId}`, headers: auth(subject.idToken) });
  assert.equal(beforeDelivery.json().response, null);
  const deliver = await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers: adminHeaders, payload: { action: "deliver", expectedRevision: 2 } });
  assert.equal(deliver.statusCode, 200);
  assert.equal(deliver.json().request.status, "fulfilled");

  const response = await context.app.inject({ method: "GET", url: `/v1/privacy-requests/${requestId}`, headers: auth(subject.idToken) });
  assert.equal(response.statusCode, 200);
  const deliveredExport = JSON.parse(response.json().response) as { exportId: string; article15Information?: unknown };
  assert.match(deliveredExport.exportId, /^export_[A-Za-z0-9_-]{32}$/u);
  assert.ok(deliveredExport.article15Information);
  assert.equal(response.json().complaintInformationIncluded, true);
  const readAudit = await getFirestore().collection("privacyRequests").doc(requestId).collection("audit").where("event", "==", "response_read").get();
  assert.equal(readAudit.size, 1);
  const artifact = await getFirestore().collection("privacyResponseArtifacts").doc(requestId).get();
  assert.equal(artifact.exists, true);
  assert.equal("payload" in (artifact.data() ?? {}), false);
  const chunks = await getFirestore().collection("privacyResponseChunks").where("requestId", "==", requestId).get();
  assert.ok(chunks.size >= 2);
  assert.equal(JSON.stringify(chunks.docs[0]?.data()).includes("article15Information"), false);

  const close = await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers: adminHeaders, payload: { action: "close", expectedRevision: 3 } });
  assert.equal(close.statusCode, 200);
  assert.equal(close.json().request.status, "closed");
  const secret = await getFirestore().collection("privacyRequestSecrets").doc(requestId).get();
  assert.ok(secret.data()?.expiresAt);
  const audit = await getFirestore().collection("privacyRequests").doc(requestId).collection("audit").get();
  assert.equal(audit.docs.some((document) => document.data().reasonCode === "Request fulfilled"), false);
});

test("public lifecycle exchanges fragment tokens and remains non-enumerating", async () => {
  const administrator = await provision("lukasz.kurczab@gmail.com");
  const intake = await context.app.inject({ method: "POST", url: "/v1/public/privacy-requests", payload: { email: "guest@example.com", right: "portability", reportSubmissionIds: [] } });
  assert.equal(intake.statusCode, 202);
  assert.deepEqual(intake.json(), { status: "accepted" });
  const verification = context.privacyLinks.at(-1)!;
  assert.equal(verification.purpose, "verify");
  assert.match(verification.link, /#token=/u);
  assert.equal(verification.link.includes("?token="), false);

  const missing = await context.app.inject({ method: "POST", url: "/v1/public/privacy-requests/pr_00000000-0000-4000-8000-000000000000/session", payload: { token: verification.token } });
  const invalid = await context.app.inject({ method: "POST", url: `/v1/public/privacy-requests/${verification.requestId}/session`, payload: { token: "x".repeat(32) } });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), invalid.json());

  const exchange = await context.app.inject({ method: "POST", url: `/v1/public/privacy-requests/${verification.requestId}/session`, payload: { token: verification.token } });
  assert.equal(exchange.statusCode, 200);
  const sessionToken = exchange.json().sessionToken as string;
  const replay = await context.app.inject({ method: "POST", url: `/v1/public/privacy-requests/${verification.requestId}/session`, payload: { token: verification.token } });
  assert.equal(replay.statusCode, 404);
  const initial = await context.app.inject({ method: "POST", url: `/v1/public/privacy-requests/${verification.requestId}/response`, payload: { sessionToken } });
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.json().response, null);

  const headers = auth(administrator.idToken);
  assert.equal((await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${verification.requestId}`, headers, payload: { action: "start_review", expectedRevision: 1 } })).statusCode, 409);
  assert.equal((await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${verification.requestId}`, headers, payload: { action: "verify_subject", expectedRevision: 1, reason: "Matched supplied report identifiers" } })).statusCode, 200);
  const extended = await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${verification.requestId}`, headers, payload: { action: "extend", expectedRevision: 2, reason: "Complex request", noticeLocale: "en" } });
  assert.equal(extended.statusCode, 200);
  assert.equal(context.privacyLinks.at(-1)?.purpose, "extension");
  assert.equal(context.privacyLinks.at(-1)?.extensionReason, "Complex request");
  const extensionExchange = await context.app.inject({ method: "POST", url: `/v1/public/privacy-requests/${verification.requestId}/session`, payload: { token: context.privacyLinks.at(-1)!.token } });
  assert.equal(extensionExchange.statusCode, 200);
  const extensionStatus = await context.app.inject({ method: "POST", url: `/v1/public/privacy-requests/${verification.requestId}/response`, payload: { sessionToken: extensionExchange.json().sessionToken } });
  assert.equal(extensionStatus.json().extensionReason, "Complex request");
  assert.equal((await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${verification.requestId}`, headers, payload: { action: "start_review", expectedRevision: 4 } })).statusCode, 200);
  assert.equal((await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${verification.requestId}`, headers, payload: { action: "prepare_response", expectedRevision: 5, outcome: "refused", response: "Reasoned refusal", reason: "No qualifying portable data", complaintInformationIncluded: true, executionEvidence: "operator_refusal_decision" } })).statusCode, 200);
  const delivered = await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${verification.requestId}`, headers, payload: { action: "deliver", expectedRevision: 6 } });
  assert.equal(delivered.statusCode, 200);
  assert.equal(delivered.json().request.status, "refused");
  assert.equal(delivered.json().request.revision, 8);
  const responseLink = context.privacyLinks.at(-1)!;
  assert.equal(responseLink.purpose, "response");
  const responseExchange = await context.app.inject({ method: "POST", url: `/v1/public/privacy-requests/${verification.requestId}/session`, payload: { token: responseLink.token } });
  assert.equal(responseExchange.statusCode, 200);
  const publicResponse = await context.app.inject({ method: "POST", url: `/v1/public/privacy-requests/${verification.requestId}/response`, payload: { sessionToken: responseExchange.json().sessionToken } });
  assert.equal(publicResponse.statusCode, 200);
  assert.equal(publicResponse.json().response, "Reasoned refusal");
  assert.equal(publicResponse.headers["cache-control"], "no-store");
  assert.equal(publicResponse.headers["referrer-policy"], "no-referrer");
});

test("admin transitions are revision guarded and require complaint information plus execution evidence", async () => {
  const subject = await provision();
  const administrator = await provision("lukasz.kurczab@gmail.com");
  const created = await context.app.inject({ method: "POST", url: "/v1/privacy-requests", headers: auth(subject.idToken), payload: { right: "objection" } });
  const requestId = created.json().request.requestId as string;
  const headers = auth(administrator.idToken);
  assert.equal((await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers, payload: { action: "start_review", expectedRevision: 0 } })).statusCode, 200);
  const stale = await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers, payload: { action: "start_review", expectedRevision: 0 } });
  assert.equal(stale.statusCode, 409);
  const unproved = await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers, payload: { action: "prepare_response", expectedRevision: 1, outcome: "refused", response: "No", reason: "Legal grounds", complaintInformationIncluded: false } });
  assert.equal(unproved.statusCode, 400);
});

test("failed public extension notice remains explicit and can be retried without extending twice", async () => {
  let verificationToken = "";
  let requestId = "";
  await context.stores.privacyRequests.createPublic({ email: "extension@example.com", right: "access", reportSubmissionIds: [], rateLimitKey: "extension-test" }, "http://127.0.0.1:4173", { send: async (input) => { requestId = input.requestId; verificationToken = decodeURIComponent(new URL(input.link).hash.replace(/^#token=/u, "")); } });
  assert.ok(requestId);
  await context.stores.privacyRequests.exchangePublicToken(requestId, verificationToken);
  await context.stores.privacyRequests.transitionAdmin(requestId, "admin", { action: "verify_subject", reason: "Matched identifiers", expectedRevision: 1 }, "http://127.0.0.1:4173", null);
  await assert.rejects(context.stores.privacyRequests.transitionAdmin(requestId, "admin", { action: "extend", reason: "Complex request", noticeLocale: "en", expectedRevision: 2 }, "http://127.0.0.1:4173", { send: async () => { throw new Error("mail_down"); } }), /privacy_email_unavailable/u);
  const failed = await context.stores.privacyRequests.readAdmin(requestId, "admin");
  assert.equal(failed?.extensionNoticeStatus, "failed");
  assert.equal(failed?.revision, 3);
  await context.stores.privacyRequests.transitionAdmin(requestId, "admin", { action: "retry_extension_notice", expectedRevision: 3 }, "http://127.0.0.1:4173", { send: async () => undefined });
  const delivered = await context.stores.privacyRequests.readAdmin(requestId, "admin");
  assert.equal(delivered?.extensionNoticeStatus, "delivered");
  assert.equal(delivered?.revision, 3);
});
