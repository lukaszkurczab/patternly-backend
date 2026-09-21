import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after, beforeEach } from "node:test";
import { getFirestore } from "firebase-admin/firestore";
import { TEST_APP_CHECK_TOKEN, clearFirestore, createEmulatorContext, createVerifiedAuthUser, registerAuthUser } from "./support.js";

const context = createEmulatorContext();
after(async () => context.close());
beforeEach(async () => { await clearFirestore(); });

const auth = (token: string) => ({ authorization: `Bearer ${token}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN });

async function provision(email?: string) {
  const user = await createVerifiedAuthUser(email);
  return registerAuthUser(context, user);
}

test("account request has an isolated lifecycle and serves a prepared response only to its owner", async () => {
  const subject = await provision();
  const other = await provision();
  const administrator = await createVerifiedAuthUser("lukasz.kurczab@gmail.com");
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

test("guest lifecycle keeps verification and operator response inside the app", async () => {
  const administrator = await createVerifiedAuthUser("lukasz.kurczab@gmail.com");
  const mobileHeaders = { "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const intake = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests", headers: mobileHeaders, payload: { clientRequestId: "9cb532bc-621c-4c73-afd7-4e47b79f05d9", email: "guest@example.com", right: "portability", reportSubmissionIds: [] } });
  assert.equal(intake.statusCode, 202);
  const requestId = intake.json().requestId as string;
  const verification = context.privacyLinks.at(-1)!;
  assert.equal(verification.purpose, "verify");
  assert.match(verification.code, /^pr_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u);

  const missing = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests/verify", headers: mobileHeaders, payload: { code: `pr_00000000-0000-4000-8000-000000000000.${verification.token}` } });
  const invalid = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests/verify", headers: mobileHeaders, payload: { code: `${requestId}.${"x".repeat(43)}` } });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), invalid.json());

  const exchange = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests/verify", headers: mobileHeaders, payload: { code: verification.code } });
  assert.equal(exchange.statusCode, 200);
  const sessionToken = exchange.json().sessionToken as string;
  const initial = await context.app.inject({ method: "POST", url: `/v1/guest/privacy-requests/${requestId}/response`, headers: mobileHeaders, payload: { sessionToken } });
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.json().response, null);

  const headers = auth(administrator.idToken);
  assert.equal((await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers, payload: { action: "start_review", expectedRevision: 1 } })).statusCode, 409);
  assert.equal((await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers, payload: { action: "verify_subject", expectedRevision: 1, reason: "Matched supplied report identifiers" } })).statusCode, 200);
  const extended = await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers, payload: { action: "extend", expectedRevision: 2, reason: "Complex request", noticeLocale: "en" } });
  assert.equal(extended.statusCode, 200);
  assert.equal(context.privacyLinks.at(-1)?.purpose, "extension");
  assert.equal(context.privacyLinks.at(-1)?.extensionReason, "Complex request");
  const extensionExchange = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests/verify", headers: mobileHeaders, payload: { code: context.privacyLinks.at(-1)!.code } });
  assert.equal(extensionExchange.statusCode, 200);
  const extensionStatus = await context.app.inject({ method: "POST", url: `/v1/guest/privacy-requests/${requestId}/response`, headers: mobileHeaders, payload: { sessionToken: extensionExchange.json().sessionToken } });
  assert.equal(extensionStatus.json().extensionReason, "Complex request");
  assert.equal((await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers, payload: { action: "start_review", expectedRevision: 4 } })).statusCode, 200);
  assert.equal((await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers, payload: { action: "prepare_response", expectedRevision: 5, outcome: "refused", response: "Reasoned refusal", reason: "No qualifying portable data", complaintInformationIncluded: true, executionEvidence: "operator_refusal_decision" } })).statusCode, 200);
  const delivered = await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers, payload: { action: "deliver", expectedRevision: 6 } });
  assert.equal(delivered.statusCode, 200);
  assert.equal(delivered.json().request.status, "refused");
  assert.equal(delivered.json().request.revision, 8);
  const responseCode = context.privacyLinks.at(-1)!;
  assert.equal(responseCode.purpose, "response");
  const responseExchange = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests/verify", headers: mobileHeaders, payload: { code: responseCode.code } });
  assert.equal(responseExchange.statusCode, 200);
  const guestResponse = await context.app.inject({ method: "POST", url: `/v1/guest/privacy-requests/${requestId}/response`, headers: mobileHeaders, payload: { sessionToken: responseExchange.json().sessionToken } });
  assert.equal(guestResponse.statusCode, 200);
  assert.equal(guestResponse.json().response, "Reasoned refusal");
  assert.equal(guestResponse.headers["cache-control"], "no-store");
});

test("guest mobile request is App Check protected, idempotent and verifiable only in app", async () => {
  const payload = { clientRequestId: "d39fbfd9-33dc-47f5-9d1c-48e630da2b43", email: "guest@example.com", right: "access", reportSubmissionIds: [] };
  const missingAppCheck = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests", payload });
  assert.equal(missingAppCheck.statusCode, 401);
  assert.equal(missingAppCheck.json().error.code, "app_check_required");
  const mobileHeaders = { "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const created = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests", headers: mobileHeaders, payload });
  assert.equal(created.statusCode, 202);
  const requestId = created.json().requestId as string;
  assert.deepEqual(created.json(), { status: "pending_verification", requestId });
  const firstCode = context.privacyLinks.at(-1)!.code;
  assert.match(firstCode, /^pr_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u);
  const retried = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests", headers: mobileHeaders, payload });
  assert.deepEqual(retried.json(), created.json());
  assert.equal(context.privacyLinks.at(-1)!.code, firstCode);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const recovery = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests", headers: mobileHeaders, payload });
    assert.equal(recovery.statusCode, 202);
    assert.equal(recovery.json().requestId, requestId);
  }
  const changed = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests", headers: mobileHeaders, payload: { ...payload, right: "erasure" } });
  assert.equal(changed.statusCode, 409);
  const missingResend = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests/pr_00000000-0000-4000-8000-000000000000/resend", headers: mobileHeaders, payload: { email: payload.email } });
  const wrongEmailResend = await context.app.inject({ method: "POST", url: `/v1/guest/privacy-requests/${requestId}/resend`, headers: mobileHeaders, payload: { email: "wrong@example.com" } });
  assert.equal(missingResend.statusCode, 202);
  assert.deepEqual(missingResend.json(), wrongEmailResend.json());
  const resend = await context.app.inject({ method: "POST", url: `/v1/guest/privacy-requests/${requestId}/resend`, headers: mobileHeaders, payload: { email: payload.email } });
  assert.equal(resend.statusCode, 202);
  const latestCode = context.privacyLinks.at(-1)!.code;
  assert.notEqual(latestCode, firstCode);
  const stale = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests/verify", headers: mobileHeaders, payload: { code: firstCode } });
  assert.equal(stale.statusCode, 404);
  const verified = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests/verify", headers: mobileHeaders, payload: { code: latestCode } });
  assert.equal(verified.statusCode, 200);
  assert.equal(verified.json().requestId, requestId);
  const replay = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests/verify", headers: mobileHeaders, payload: { code: latestCode } });
  assert.equal(replay.statusCode, 404);
  const read = await context.app.inject({ method: "POST", url: `/v1/guest/privacy-requests/${requestId}/response`, headers: mobileHeaders, payload: { sessionToken: verified.json().sessionToken } });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().request.requestId, requestId);
  const resendVerified = await context.app.inject({ method: "POST", url: `/v1/guest/privacy-requests/${requestId}/resend`, headers: mobileHeaders, payload: { email: payload.email } });
  assert.equal(resendVerified.statusCode, 202);
  const laterCode = context.privacyLinks.at(-1)!.code;
  const later = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests/verify", headers: mobileHeaders, payload: { code: laterCode } });
  assert.equal(later.statusCode, 200);
});

test("retired browser privacy endpoints cannot create, verify or read a request", async () => {
  for (const url of [
    "/v1/public/privacy-requests",
    "/v1/public/privacy-requests/pr_75347222-8b93-4d78-9232-36b053107c46/session",
    "/v1/public/privacy-requests/pr_75347222-8b93-4d78-9232-36b053107c46/response",
  ]) {
    const response = await context.app.inject({ method: "POST", url, payload: {} });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  }
});

test("a pending legacy-compatible guest record can receive a fresh in-app code", async () => {
  const email = "legacy@example.com";
  const requestId = await context.stores.privacyRequests.createGuest({ clientRequestId: "16bcdb5b-05d6-47ad-a729-25d544ea1bba", email, right: "access", reportSubmissionIds: [], rateLimitKey: "legacy-test" }, { send: async () => undefined });
  const mobileHeaders = { "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const legacyToken = "L".repeat(43);
  await getFirestore().collection("privacyRequests").doc(requestId).set({ verificationTokenHash: createHash("sha256").update(legacyToken).digest("hex") }, { merge: true });
  const retiredLinkToken = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests/verify", headers: mobileHeaders, payload: { code: `${requestId}.${legacyToken}` } });
  assert.equal(retiredLinkToken.statusCode, 404);
  const missing = await context.app.inject({ method: "POST", url: `/v1/guest/privacy-requests/${requestId}/resend`, headers: mobileHeaders, payload: { email: "other@example.com" } });
  const matching = await context.app.inject({ method: "POST", url: `/v1/guest/privacy-requests/${requestId}/resend`, headers: mobileHeaders, payload: { email } });
  assert.deepEqual(missing.json(), matching.json());
  assert.equal(matching.statusCode, 202);
  const code = context.privacyLinks.at(-1)?.code;
  assert.ok(code);
  const verified = await context.app.inject({ method: "POST", url: "/v1/guest/privacy-requests/verify", headers: mobileHeaders, payload: { code } });
  assert.equal(verified.statusCode, 200);
  const read = await context.app.inject({ method: "POST", url: `/v1/guest/privacy-requests/${requestId}/response`, headers: mobileHeaders, payload: { sessionToken: verified.json().sessionToken } });
  assert.equal(read.statusCode, 200);
});

test("admin transitions are revision guarded and require complaint information plus execution evidence", async () => {
  const subject = await provision();
  const administrator = await createVerifiedAuthUser("lukasz.kurczab@gmail.com");
  const created = await context.app.inject({ method: "POST", url: "/v1/privacy-requests", headers: auth(subject.idToken), payload: { right: "objection" } });
  const requestId = created.json().request.requestId as string;
  const headers = auth(administrator.idToken);
  assert.equal((await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers, payload: { action: "start_review", expectedRevision: 0 } })).statusCode, 200);
  const stale = await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers, payload: { action: "start_review", expectedRevision: 0 } });
  assert.equal(stale.statusCode, 409);
  const unproved = await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers, payload: { action: "prepare_response", expectedRevision: 1, outcome: "refused", response: "No", reason: "Legal grounds", complaintInformationIncluded: false } });
  assert.equal(unproved.statusCode, 400);
});

test("failed guest extension notice remains explicit and can be retried without extending twice", async () => {
  let verificationCode = "";
  let requestId = "";
  await context.stores.privacyRequests.createGuest({ clientRequestId: "7f94f013-6a30-4a2f-a360-459c86c548a7", email: "extension@example.com", right: "access", reportSubmissionIds: [], rateLimitKey: "extension-test" }, { send: async (input) => { requestId = input.requestId; verificationCode = input.code; } });
  assert.ok(requestId);
  await context.stores.privacyRequests.exchangeGuestCode(verificationCode, "extension-test");
  await context.stores.privacyRequests.transitionAdmin(requestId, "admin", { action: "verify_subject", reason: "Matched identifiers", expectedRevision: 1 }, null);
  await assert.rejects(context.stores.privacyRequests.transitionAdmin(requestId, "admin", { action: "extend", reason: "Complex request", noticeLocale: "en", expectedRevision: 2 }, { send: async () => { throw new Error("mail_down"); } }), /privacy_email_unavailable/u);
  const failed = await context.stores.privacyRequests.readAdmin(requestId, "admin");
  assert.equal(failed?.extensionNoticeStatus, "failed");
  assert.equal(failed?.revision, 3);
  await context.stores.privacyRequests.transitionAdmin(requestId, "admin", { action: "retry_extension_notice", expectedRevision: 3 }, { send: async () => undefined });
  const delivered = await context.stores.privacyRequests.readAdmin(requestId, "admin");
  assert.equal(delivered?.extensionNoticeStatus, "delivered");
  assert.equal(delivered?.revision, 3);
});
