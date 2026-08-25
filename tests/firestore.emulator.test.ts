import assert from "node:assert/strict";
import test from "node:test";
import { identityDocumentId } from "../src/infrastructure/firestore/paths.js";
import { createContentReportSchema } from "../src/modules/content-reports/contracts.js";
import { clearFirestore, createAuthUser, createEmulatorContext, firestore, type EmulatorContext } from "./support.js";

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
});

test("Firestore transaction preserves sync CAS and idempotency under concurrent retries", async () => {
  const auth = await createAuthUser();
  const mutation = {
    mutationId: `mutation-${Date.now()}-0001`,
    kind: "item" as const,
    trackId: "coding-interview-dsa-problem-solving",
    targetId: "item-1",
    expectedVersion: null,
    state: { mastery: "learning" },
  };
  const headers = { authorization: `Bearer ${auth.idToken}` };
  const [first, second] = await Promise.all([
    context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: { mutations: [mutation] } }),
    context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: { mutations: [mutation] } }),
  ]);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal([first, second].filter((response) => response.json().applied.length === 1).length, 1);
  assert.equal([first, second].filter((response) => response.json().duplicates.length === 1).length, 1);
  const conflict = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: { mutations: [{ ...mutation, mutationId: `${mutation.mutationId}-conflict`, expectedVersion: null, state: { mastery: "mastered" } }] } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().conflicts[0].current.version, 1);
  assert.equal(conflict.json().conflicts[0].current.state.mastery, "learning");
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

test("account deletion removes owned Firestore documents, preserves a tombstone, and redacts report linkage", async () => {
  const auth = await createAuthUser();
  const me = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}` } });
  const userId = me.json().user.id as string;
  const mutation = { mutationId: `mutation-${Date.now()}-delete`, kind: "item" as const, trackId: "coding-interview-dsa-problem-solving", targetId: "delete-item", expectedVersion: null, state: { value: true } };
  await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers: { authorization: `Bearer ${auth.idToken}` }, payload: { mutations: [mutation] } });
  const linked = createContentReportSchema.parse({ ...reportBody("9f61e3f3-f23e-467c-b92a-9b8fd0514f25"), linkAccount: true, contactEmail: "learner@example.com" });
  await context.stores.contentReports.create(userId, linked, { rateLimitKey: "account-test-client" });
  await context.stores.users.deleteAccount(userId);
  await context.stores.contentReports.unlinkAccount(userId);
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
