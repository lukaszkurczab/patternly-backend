import assert from "node:assert/strict";
import test from "node:test";
import { buildApplication } from "../src/api/app.js";
import { identityDocumentId } from "../src/infrastructure/firestore/paths.js";
import { createContentReportSchema } from "../src/modules/content-reports/contracts.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { clearFirestore, createAuthUser, createEmulatorContext, firestore, testEnvironment, type EmulatorContext } from "./support.js";

const reportBody = (clientSubmissionId: string) => createContentReportSchema.parse({
  clientSubmissionId,
  trackId: "coding-interview-dsa-problem-solving",
  contentVersion: "2026.08.25",
  itemId: "two-sum-001",
  reason: "unclear_explanation",
  description: "The explanation does not identify why the invariant is safe.",
  context: {
    releasePackageId: "patternly-launch-2026-08-25-01",
    trackNode: "complexity_and_constraints",
    modeRoute: "practice_feedback_details",
    locale: "en",
    appBuild: "0.1.0",
    platform: "ios",
    occurredAt: "2026-08-25T10:00:00.000Z",
  },
});

let context: EmulatorContext;

test.before(async () => {
  context = createEmulatorContext();
  await clearFirestore();
});

test.afterEach(async () => {
  await clearFirestore();
});

test.after(async () => {
  await context.close();
});

test("Firebase Auth identity is mapped to one Firestore account in a transaction", async () => {
  const auth = await createAuthUser();
  const first = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}` } });
  const second = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}` } });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(first.json().user.id, second.json().user.id);
  const users = await firestore().collection("users").get();
  const identities = await firestore().collection("identityMappings").get();
  assert.equal(users.size, 1);
  assert.equal(identities.size, 1);
  assert.equal(identities.docs[0]?.data().userId, first.json().user.id);
  assert.equal(identities.docs[0]?.data().provider, "firebase");
  assert.equal(identities.docs[0]?.data().subject, auth.localId);
});

test("invalid Firebase bearer tokens fail closed without exposing identity details", async () => {
  const response = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: "Bearer invalid-emulator-bearer" } });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: { code: "authentication_required" } });
});

test("revoked Firebase verifier results fail closed at the backend boundary", async () => {
  const revokedApp = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: { verify: async () => { throw new Error("firebase_token_invalid"); } },
    appCheckVerifier: null,
    stores: context.stores,
  });
  const response = await revokedApp.inject({ method: "GET", url: "/v1/me", headers: { authorization: "Bearer revoked-session" } });
  await revokedApp.close();
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: { code: "authentication_required" } });
});

test("Firestore transaction preserves sync CAS and idempotency under concurrent retries", async () => {
  const auth = await createAuthUser();
  const mutation = {
    mutationId: `mutation-${Date.now()}-0001`,
    kind: "item" as const,
    recordType: "training_attempt" as const,
    trackId: "coding-interview-dsa-problem-solving",
    targetId: "item-1",
    expectedVersion: null,
    state: { mastery: "learning" },
    fingerprint: createMergeRecordFingerprint({ recordId: "item-1", recordType: "training_attempt", state: { mastery: "learning" }, trackId: "coding-interview-dsa-problem-solving" }),
  };
  const headers = { authorization: `Bearer ${auth.idToken}` };
  const [first, second] = await Promise.all([
    context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: { expectedAccountRevision: 0, mutations: [mutation] } }),
    context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: { expectedAccountRevision: 0, mutations: [mutation] } }),
  ]);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal([first, second].filter((response) => response.json().applied.length === 1).length, 1);
  assert.equal([first, second].filter((response) => response.json().duplicates.length === 1).length, 1);
  const conflictState = { mastery: "mastered" };
  const conflict = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: { expectedAccountRevision: 1, mutations: [{ ...mutation, mutationId: `${mutation.mutationId}-conflict`, expectedVersion: null, state: conflictState, fingerprint: createMergeRecordFingerprint({ recordId: "item-1", recordType: "training_attempt", state: conflictState, trackId: mutation.trackId }) }] } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().conflicts[0].current.version, 1);
  assert.equal(conflict.json().conflicts[0].current.state.mastery, "learning");
});

test("account adoption is previewed, explicitly confirmed, materialized idempotently, and guarded by account CAS", async () => {
  const auth = await createAuthUser();
  const me = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}` } });
  const headers = { authorization: `Bearer ${auth.idToken}` };
  const recordState = { trackId: "coding-interview-dsa-problem-solving" };
  const snapshot = {
    guestSnapshotVersion: 1,
    guestUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    records: [{ fingerprint: createMergeRecordFingerprint({ recordId: "current", recordType: "active_track", state: recordState, trackId: "coding-interview-dsa-problem-solving" }), recordId: "current", recordType: "active_track", state: recordState, trackId: "coding-interview-dsa-problem-solving", version: 0 }],
    activeSession: false,
    pendingJournal: false,
  };
  const previewResponse = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/preview", headers, payload: snapshot });
  assert.equal(previewResponse.statusCode, 200);
  assert.equal(previewResponse.json().plan.caseId, "populatedLocalEmptyRemote");
  const preview = previewResponse.json().preview;
  const confirmation = { operationId: preview.operationId, previewFingerprint: preview.fingerprint, protocolVersion: 1, resolutions: [] };
  const request = { deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", snapshot, confirmation };
  const first = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/confirm", headers, payload: request });
  const replay = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/confirm", headers, payload: request });
  assert.equal(first.statusCode, 200);
  assert.equal(replay.statusCode, 200);
  assert.equal(first.json().accountRevision, 1);
  assert.deepEqual(replay.json().mutationIds, first.json().mutationIds);
  const remote = await context.app.inject({ method: "GET", url: "/v1/progress", headers });
  assert.equal(remote.json().accountRevision, 1);
  assert.equal(remote.json().records[0].recordType, "active_track");

  const staleMutationState = { trackId: "google-cloud-associate-cloud-engineer" };
  const staleMutation = { mutationId: `mutation-${Date.now()}-stale`, kind: "node" as const, recordType: "active_track" as const, trackId: "google-cloud-associate-cloud-engineer", targetId: "current", expectedVersion: 1, state: staleMutationState, fingerprint: createMergeRecordFingerprint({ recordId: "current", recordType: "active_track", state: staleMutationState, trackId: "google-cloud-associate-cloud-engineer" }) };
  const stale = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: { expectedAccountRevision: 0, mutations: [staleMutation] } });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "account_revision_conflict");
  const switchedTrack = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: { expectedAccountRevision: 1, mutations: [staleMutation] } });
  assert.equal(switchedTrack.statusCode, 200);
  const switchedRemote = await context.app.inject({ method: "GET", url: "/v1/progress", headers });
  assert.equal(switchedRemote.json().records.length, 1);
  assert.equal(switchedRemote.json().records[0].state.trackId, "google-cloud-associate-cloud-engineer");

  const blockedPreview = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/preview", headers, payload: { ...snapshot, guestSnapshotVersion: 2, activeSession: true } });
  assert.equal(blockedPreview.statusCode, 200);
  assert.equal(blockedPreview.json().plan.blockingReason, "active_session");
  const blockedConfirmation = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/confirm", headers, payload: { deviceId: request.deviceId, snapshot: { ...snapshot, guestSnapshotVersion: 2, activeSession: true }, confirmation: { operationId: blockedPreview.json().preview.operationId, previewFingerprint: blockedPreview.json().preview.fingerprint, protocolVersion: 1, resolutions: [] } } });
  assert.equal(blockedConfirmation.statusCode, 409);
  assert.equal(blockedConfirmation.json().error.code, "active_session_adoption_blocked");
  assert.equal(me.statusCode, 200);
});

test("anonymous reports require Firebase App Check before persistence", async () => {
  const response = await context.app.inject({ method: "POST", url: "/v1/content/reports", payload: reportBody("7f61e3f3-f23e-467c-b92a-9b8fd0514f25") });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: { code: "app_check_required" } });
  assert.equal((await firestore().collection("contentReports").get()).size, 0);
});

test("report persistence keeps default submissions unlinked and excludes response-shaped fields", async () => {
  const input = reportBody("8f61e3f3-f23e-467c-b92a-9b8fd0514f25");
  const result = await context.stores.contentReports.create(undefined, input, { rateLimitKey: "anonymous-test-client" });
  assert.equal(result.duplicate, false);
  assert.equal(result.report.linkage, "unlinked");
  const stored = (await firestore().collection("contentReports").doc(input.clientSubmissionId).get()).data();
  assert.ok(stored);
  for (const forbiddenField of ["accountId", "contactEmail", "email", "learnerResponse", "prompt", "feedback"]) assert.equal(forbiddenField in stored, false, forbiddenField);
  assert.equal(stored.description, input.description);
  assert.equal(stored.itemId, input.itemId);
  assert.deepEqual(stored.context, input.context);
  assert.ok(stored.expiresAt);
});

test("administrator report triage uses an idempotent monotonic state machine and records an audit event", async () => {
  const input = reportBody("4f61e3f3-f23e-467c-b92a-9b8fd0514f25");
  await context.stores.contentReports.create(undefined, input, { rateLimitKey: "triage-test-client" });
  const first = await context.stores.contentReports.transitionStatus(input.clientSubmissionId, "admin-user-id", "in_review");
  const duplicate = await context.stores.contentReports.transitionStatus(input.clientSubmissionId, "admin-user-id", "in_review");
  assert.equal(first.report.status, "in_review");
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(context.stores.contentReports.transitionStatus(input.clientSubmissionId, "admin-user-id", "closed"), { message: "content_report_transition_invalid" });
  const audit = await firestore().collection("contentReports").doc(input.clientSubmissionId).collection("audit").get();
  assert.equal(audit.size, 1);
  assert.deepEqual(audit.docs[0]?.data().toStatus, "in_review");
  assert.equal(audit.docs[0]?.data().actorId, "admin-user-id");
  const queue = await context.stores.contentReports.listQueue();
  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.status, "in_review");
});

test("administrator queue access is server-authorized and origin-bound", async () => {
  const nonAdmin = await createAuthUser();
  const denied = await context.app.inject({
    method: "GET",
    url: "/v1/admin/content-reports",
    headers: { authorization: `Bearer ${nonAdmin.idToken}` },
  });
  assert.equal(denied.statusCode, 403);

  const admin = await createAuthUser("lukasz.kurczab@gmail.com");
  const accepted = await context.app.inject({
    method: "GET",
    url: "/v1/admin/content-reports",
    headers: { authorization: `Bearer ${admin.idToken}` },
  });
  assert.equal(accepted.statusCode, 200);

  const preflight = await context.app.inject({
    method: "OPTIONS",
    url: "/v1/admin/content-reports",
    headers: { origin: "http://127.0.0.1:4173" },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "http://127.0.0.1:4173");

  const wrongOrigin = await context.app.inject({
    method: "OPTIONS",
    url: "/v1/admin/content-reports",
    headers: { origin: "http://malicious.example" },
  });
  assert.equal(wrongOrigin.statusCode, 403);
  assert.deepEqual(wrongOrigin.json(), { error: { code: "origin_not_allowed" } });
});

test("anonymous report rate limiting is transactionally enforced without storing the client key", async () => {
  await context.stores.contentReports.create(undefined, reportBody("af61e3f3-f23e-467c-b92a-9b8fd0514f25"), { rateLimitKey: "rate-limited-client" });
  await context.stores.contentReports.create(undefined, reportBody("bf61e3f3-f23e-467c-b92a-9b8fd0514f25"), { rateLimitKey: "rate-limited-client" });
  await assert.rejects(
    context.stores.contentReports.create(undefined, reportBody("cf61e3f3-f23e-467c-b92a-9b8fd0514f25"), { rateLimitKey: "rate-limited-client" }),
    { message: "report_rate_limited" },
  );
  const buckets = await firestore().collection("rateLimitBuckets").get();
  assert.equal(buckets.size, 1);
  assert.equal("rateLimitKey" in (buckets.docs[0]?.data() ?? {}), false);
});

test("recovery codes are eight one-time server-hashed credentials and replay is rejected", async () => {
  const auth = await createAuthUser();
  const headers = { authorization: `Bearer ${auth.idToken}` };
  const issued = await context.app.inject({ method: "POST", url: "/v1/account/recovery-codes", headers, payload: {} });
  assert.equal(issued.statusCode, 200);
  assert.equal(issued.json().codes.length, 8);
  const stored = await firestore().collection("recoveryCodeIndex").get();
  assert.equal(stored.size, 8);
  for (const document of stored.docs) {
    assert.equal("code" in document.data(), false);
    assert.equal("rawCode" in document.data(), false);
  }
  const consumed = await context.app.inject({ method: "POST", url: "/v1/public/recovery-codes/consume", payload: { code: issued.json().codes[0] } });
  assert.equal(consumed.statusCode, 200);
  assert.equal(consumed.json().customToken, "fixture-custom-token");
  assert.deepEqual(context.customTokenSubjects, [auth.localId]);
  assert.equal(context.revokedSubjects.includes(auth.localId), true);
  const replay = await context.app.inject({ method: "POST", url: "/v1/public/recovery-codes/consume", payload: { code: issued.json().codes[0] } });
  assert.equal(replay.statusCode, 409);
  assert.deepEqual(replay.json(), { error: { code: "recovery_code_used" } });
});

test("destructive deletion rejects an old authenticated session before touching Firestore", async () => {
  const auth = await createAuthUser();
  const staleApp = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: { verify: async () => ({ provider: "firebase", subject: auth.localId, email: auth.email, emailVerified: true, authTime: Math.floor(Date.now() / 1000) - 301 }) },
    appCheckVerifier: null,
    stores: context.stores,
  });
  const response = await staleApp.inject({ method: "POST", url: "/v1/account/deletion", headers: { authorization: "Bearer stale-but-otherwise-valid" }, payload: { operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } });
  await staleApp.close();
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: { code: "recent_reauthentication_required" } });
  assert.equal((await firestore().collection("accountDeletionOperations").get()).size, 0);
});

test("public deletion is non-enumerating, possession verified, tombstoned, and idempotent", async () => {
  const auth = await createAuthUser("fixture-deletion@example.invalid");
  await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}` } });
  const accepted = await context.app.inject({ method: "POST", url: "/v1/public/deletion-requests", payload: { email: "fixture-deletion@example.invalid" } });
  const unknown = await context.app.inject({ method: "POST", url: "/v1/public/deletion-requests", payload: { email: "unknown-deletion@example.invalid" } });
  assert.equal(accepted.statusCode, 202);
  assert.equal(unknown.statusCode, 202);
  assert.deepEqual(accepted.json(), unknown.json());
  const preflight = await context.app.inject({ method: "OPTIONS", url: "/v1/public/deletion-requests", headers: { origin: "http://127.0.0.1:4173" } });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "http://127.0.0.1:4173");
  const wrongOrigin = await context.app.inject({ method: "OPTIONS", url: "/v1/public/deletion-requests", headers: { origin: "http://malicious.example" } });
  assert.equal(wrongOrigin.statusCode, 403);
  assert.equal(context.deletionLinks.length, 1);
  const link = context.deletionLinks[0]!;
  const bad = await context.app.inject({ method: "POST", url: `/v1/public/deletion-requests/${link.requestId}/confirm`, payload: { token: "invalid-invalid-invalid-invalid" } });
  assert.equal(bad.statusCode, 400);
  const first = await context.app.inject({ method: "POST", url: `/v1/public/deletion-requests/${link.requestId}/confirm`, payload: { token: link.token } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().status, "deleted");
  const replay = await context.app.inject({ method: "POST", url: `/v1/public/deletion-requests/${link.requestId}/confirm`, payload: { token: link.token } });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), first.json());
  const tombstone = await firestore().collection("deletedIdentities").doc(identityDocumentId("firebase", auth.localId)).get();
  assert.equal(tombstone.exists, true);
  assert.equal((await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}` } })).statusCode, 401);
});

test("account deletion removes owned Firestore documents, preserves a tombstone, and redacts report linkage", async () => {
  const auth = await createAuthUser();
  const me = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}` } });
  const userId = me.json().user.id as string;
  const state = { value: true };
  const mutation = { mutationId: `mutation-${Date.now()}-delete`, kind: "item" as const, recordType: "training_attempt" as const, trackId: "coding-interview-dsa-problem-solving", targetId: "delete-item", expectedVersion: null, state, fingerprint: createMergeRecordFingerprint({ recordId: "delete-item", recordType: "training_attempt", state, trackId: "coding-interview-dsa-problem-solving" }) };
  await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers: { authorization: `Bearer ${auth.idToken}` }, payload: { expectedAccountRevision: 0, mutations: [mutation] } });
  const linked = createContentReportSchema.parse({ ...reportBody("9f61e3f3-f23e-467c-b92a-9b8fd0514f25"), linkAccount: true, contactEmail: "learner@example.com" });
  await context.stores.contentReports.create(userId, linked, { rateLimitKey: "account-test-client" });
  const deleted = await context.app.inject({ method: "POST", url: "/v1/account/deletion", headers: { authorization: `Bearer ${auth.idToken}` }, payload: { operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } });
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json().status, "deleted");
  assert.equal(context.revokedSubjects.includes(auth.localId), true);
  const proof = await context.app.inject({ method: "GET", url: `/v1/public/deletion-proofs/${deleted.json().proofId}` });
  assert.equal(proof.statusCode, 200);
  assert.equal((await firestore().collection("users").doc(userId).get()).exists, false);
  assert.equal((await firestore().collection("users").doc(userId).collection("progress").get()).size, 0);
  assert.equal((await firestore().collection("identityMappings").where("userId", "==", userId).get()).size, 0);
  const tombstoneId = identityDocumentId("firebase", auth.localId);
  assert.equal((await firestore().collection("deletedIdentities").doc(tombstoneId).get()).exists, true);
  const report = (await firestore().collection("contentReports").doc(linked.clientSubmissionId).get()).data();
  assert.ok(report);
  assert.equal("accountId" in report, false);
  assert.equal(report.contactEmail, linked.contactEmail);
  const oldTokenResponse = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}` } });
  assert.equal(oldTokenResponse.statusCode, 401);
});
