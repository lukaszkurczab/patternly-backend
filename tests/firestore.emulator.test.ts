import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { buildApplication, type ApplicationDependencies } from "../src/api/app.js";
import { loadEnvironment } from "../src/config/environment.js";
import { createFirebaseTokenVerifier } from "../src/infrastructure/firebase/verifier.js";
import { COLLECTIONS, identityDocumentId } from "../src/infrastructure/firestore/paths.js";
import { createContentReportSchema } from "../src/modules/content-reports/contracts.js";
import { FirestoreAccountLifecycleStore } from "../src/modules/account-lifecycle/store.js";
import { parsePseudonymKeyRing } from "../src/infrastructure/security/pseudonymKeyRing.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { TEST_APP_CHECK_TOKEN, accountRegistrationPayload, clearFirestore, createAuthUser, createEmulatorContext, createRegisteredAuthUser, createVerifiedAuthUser, firestore, registerAuthUser, setAuthCustomClaimsAndSignIn, testEnvironment, type EmulatorContext, verifyAuthUser } from "./support.js";
import type { BackendStores } from "../src/infrastructure/firestore/stores.js";

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

const canonicalSyncPayload = (expectedAccountRevision: number, mutations: readonly Record<string, unknown>[], batchId = `batch-${expectedAccountRevision}`) => ({
  canonicalVersion: "canonical-json-v1",
  expectedAccountRevision,
  deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  sessionId: "emulator-sync-session",
  batchId,
  highWatermark: expectedAccountRevision + 1,
  mutations,
});

let context: EmulatorContext;

function buildAppWithOverrides(overrides: Partial<BackendStores>, extras: Pick<ApplicationDependencies, "legalRequestEmailSender"> = {}) {
  return buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, ...overrides },
    ...extras,
  });
}

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

test("Firebase verifier preserves an optional positive authorization generation and rejects malformed claims", async () => {
  const verifier = createFirebaseTokenVerifier(testEnvironment);
  assert.ok(verifier);
  const user = await createAuthUser();
  const withoutClaim = await verifier.verify(user.idToken);
  assert.equal("authorizationGeneration" in withoutClaim, false);

  const claimed = await setAuthCustomClaimsAndSignIn(user, { authorizationGeneration: 9 });
  assert.equal((await verifier.verify(claimed.idToken)).authorizationGeneration, 9);

  const malformed = await setAuthCustomClaimsAndSignIn(user, { authorizationGeneration: "9" });
  await assert.rejects(verifier.verify(malformed.idToken), { message: "firebase_authorization_generation_invalid" });
});

test("account guards require a current signed authorization generation while optional bearer stays guest without a token", async () => {
  const auth = await createRegisteredAuthUser(context);
  const appCheck = { "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const currentHeaders = { ...appCheck, authorization: `Bearer ${auth.idToken}` };
  assert.equal((await context.app.inject({ method: "GET", url: "/v1/me", headers: currentHeaders })).statusCode, 200);
  const userRef = firestore().collection(COLLECTIONS.users).doc(auth.userId);
  await userRef.update({ authorizationGeneration: FieldValue.delete(), authorizationState: "active" });
  assert.equal((await context.app.inject({ method: "GET", url: "/v1/me", headers: currentHeaders })).statusCode, 200);
  await userRef.update({ authorizationState: "rotating" });
  const inactiveLegacy = await context.app.inject({ method: "GET", url: "/v1/me", headers: currentHeaders });
  assert.equal(inactiveLegacy.statusCode, 401);
  assert.deepEqual(inactiveLegacy.json(), { error: { code: "account_deleted" } });
  await userRef.update({ authorizationState: "active", authorizationGeneration: 1 });

  const claimless = await setAuthCustomClaimsAndSignIn(auth, {});
  const missing = await context.app.inject({ method: "GET", url: "/v1/me", headers: { ...appCheck, authorization: `Bearer ${claimless.idToken}` } });
  assert.equal(missing.statusCode, 401);
  assert.deepEqual(missing.json(), { error: { code: "authorization_generation_required" } });

  const malformed = await setAuthCustomClaimsAndSignIn(auth, { authorizationGeneration: "1" });
  const invalid = await context.app.inject({ method: "GET", url: "/v1/me", headers: { ...appCheck, authorization: `Bearer ${malformed.idToken}` } });
  assert.equal(invalid.statusCode, 401);
  assert.deepEqual(invalid.json(), { error: { code: "authorization_generation_invalid" } });

  const stale = await setAuthCustomClaimsAndSignIn(auth, { authorizationGeneration: 2 });
  const rejected = await context.app.inject({ method: "GET", url: "/v1/me", headers: { ...appCheck, authorization: `Bearer ${stale.idToken}` } });
  assert.equal(rejected.statusCode, 401);
  assert.deepEqual(rejected.json(), { error: { code: "authorization_generation_stale" } });

  const anonymous = await context.app.inject({
    method: "POST", url: "/v1/content/reports", headers: appCheck,
    payload: reportBody("ce938e14-6a1b-4f33-b27e-646b492b1a11"),
  });
  assert.equal(anonymous.statusCode, 201);
  const staleOptional = await context.app.inject({
    method: "POST", url: "/v1/content/reports", headers: { ...appCheck, authorization: `Bearer ${stale.idToken}` },
    payload: reportBody("ce938e14-6a1b-4f33-b27e-646b492b1a12"),
  });
  assert.equal(staleOptional.statusCode, 401);
  assert.deepEqual(staleOptional.json(), { error: { code: "authorization_generation_stale" } });
});

test("legal case creation fences authenticated and optional-bearer accounts before creating a case or sending email", async () => {
  const sent: string[] = [];
  const sender: import("../src/modules/legal-requests/store.js").LegalRequestEmailSender = { send: async (input) => { sent.push(input.requestId); } };
  for (const route of ["/v1/legal-requests", "/v1/public/legal-requests"] as const) {
    const auth = await registerAuthUser(context, await createVerifiedAuthUser());
    const userRef = firestore().collection(COLLECTIONS.users).doc(auth.userId);
    const original = context.stores.legalRequests;
    const legalRequests = new Proxy(original, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property !== "create" || typeof value !== "function") return value;
        return async (...args: Parameters<BackendStores["legalRequests"]["create"]>) => {
          await userRef.update({ authorizationGeneration: 2 });
          return value.apply(target, args);
        };
      },
    });
    const app = buildAppWithOverrides({ legalRequests }, { legalRequestEmailSender: sender });
    const response = await app.inject({
      method: "POST",
      url: route,
      headers: { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN },
      payload: route === "/v1/legal-requests"
        ? { kind: "complaint", narrative: "The paid feature was not available." }
        : { email: auth.email, kind: "complaint", narrative: "The paid feature was not available." },
    });
    await app.close();
    assert.equal(response.statusCode, 409, route);
    assert.deepEqual(response.json(), { error: { code: "authorization_generation_conflict" } });
  }
  assert.equal((await firestore().collection("legalRequests").get()).size, 0);
  assert.equal((await firestore().collection("legalRequestRateLimits").get()).size, 0);
  assert.deepEqual(sent, []);

  const guestApp = buildAppWithOverrides({}, { legalRequestEmailSender: sender });
  const guest = await guestApp.inject({
    method: "POST", url: "/v1/public/legal-requests", headers: { "x-firebase-appcheck": TEST_APP_CHECK_TOKEN },
    payload: { email: "guest-legal@example.com", kind: "withdrawal" },
  });
  await guestApp.close();
  assert.equal(guest.statusCode, 201);
  assert.equal(sent.length, 1);
});

test("legal acceptance and purchase confirmation transactions reject a generation rotated after the request guard", async () => {
  async function appThatChangesAccountBefore(method: "recordLegalAcceptance" | "recordPurchaseConfirmation", userId: string, changes: Readonly<Record<string, unknown>> = { authorizationGeneration: 2, authorizationState: "rotating" }) {
    const originalUsers = context.stores.users;
    let rotated = false;
    const users = new Proxy(originalUsers, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === method && typeof value === "function") {
          return async (...args: unknown[]) => {
            if (!rotated) {
              rotated = true;
              await firestore().collection(COLLECTIONS.users).doc(userId).update(changes);
            }
            return value.apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return buildApplication({
      environment: testEnvironment,
      firestore: null,
      verifier: createFirebaseTokenVerifier(testEnvironment),
      appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
      stores: { ...context.stores, users },
    });
  }

  const legalAuth = await createRegisteredAuthUser(context);
  const legalApp = await appThatChangesAccountBefore("recordLegalAcceptance", legalAuth.userId);
  const legalResponse = await legalApp.inject({
    method: "POST", url: "/v1/legal-acceptances",
    headers: { authorization: `Bearer ${legalAuth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN },
    payload: { termsVersion: "generation-race-legal", minimumAgeConfirmed: 18 },
  });
  await legalApp.close();
  assert.equal(legalResponse.statusCode, 409);
  assert.deepEqual(legalResponse.json(), { error: { code: "authorization_generation_conflict" } });
  const legalEvidence = await firestore().collection(COLLECTIONS.users).doc(legalAuth.userId).collection("legalAcceptances").doc("terms-generation-race-legal").get();
  assert.equal(legalEvidence.exists, false);

  const inactiveAuth = await createRegisteredAuthUser(context);
  const inactiveApp = await appThatChangesAccountBefore("recordLegalAcceptance", inactiveAuth.userId, { authorizationState: "deleting" });
  const inactiveResponse = await inactiveApp.inject({
    method: "POST", url: "/v1/legal-acceptances",
    headers: { authorization: `Bearer ${inactiveAuth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN },
    payload: { termsVersion: "generation-race-inactive", minimumAgeConfirmed: 18 },
  });
  await inactiveApp.close();
  assert.equal(inactiveResponse.statusCode, 401);
  assert.deepEqual(inactiveResponse.json(), { error: { code: "account_deleted" } });
  const inactiveEvidence = await firestore().collection(COLLECTIONS.users).doc(inactiveAuth.userId).collection("legalAcceptances").doc("terms-generation-race-inactive").get();
  assert.equal(inactiveEvidence.exists, false);

  const purchaseAuth = await createRegisteredAuthUser(context);
  const purchasePayload = { confirmationId: "00000000-0000-4000-8000-000000000091", termsVersion: "test-baseline-v1", productIdentifier: "com.lkurczab.patternly.premium.monthly", storefrontPrice: "29,99 zł", locale: "pl", immediateStartRequested: true };
  const purchaseHeaders = { authorization: `Bearer ${purchaseAuth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const first = await context.app.inject({ method: "POST", url: "/v1/purchase-confirmations", headers: purchaseHeaders, payload: purchasePayload });
  assert.equal(first.statusCode, 201);
  const purchaseApp = await appThatChangesAccountBefore("recordPurchaseConfirmation", purchaseAuth.userId);
  const replay = await purchaseApp.inject({ method: "POST", url: "/v1/purchase-confirmations", headers: purchaseHeaders, payload: purchasePayload });
  await purchaseApp.close();
  assert.equal(replay.statusCode, 409);
  assert.deepEqual(replay.json(), { error: { code: "authorization_generation_conflict" } });
  const confirmations = await firestore().collection(COLLECTIONS.users).doc(purchaseAuth.userId).collection("purchaseConfirmations").get();
  assert.equal(confirmations.size, 1);
});

test("privacy request create and response audit reject authorization rotated after the route guard", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const userRef = firestore().collection(COLLECTIONS.users).doc(auth.userId);

  async function appThatChangesBefore(method: "createAccount" | "readAccount", changes: Readonly<Record<string, unknown>> = { authorizationGeneration: 2 }) {
    const original = context.stores.privacyRequests;
    let rotated = false;
    const privacyRequests = new Proxy(original, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === method && typeof value === "function") return async (...args: unknown[]) => {
          if (!rotated) {
            rotated = true;
            await userRef.update(changes);
          }
          return value.apply(target, args);
        };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return buildApplication({
      environment: testEnvironment,
      firestore: null,
      verifier: createFirebaseTokenVerifier(testEnvironment),
      appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
      stores: { ...context.stores, privacyRequests },
    });
  }

  const createRaceApp = await appThatChangesBefore("createAccount");
  const rejectedCreate = await createRaceApp.inject({ method: "POST", url: "/v1/privacy-requests", headers, payload: { right: "access" } });
  await createRaceApp.close();
  assert.equal(rejectedCreate.statusCode, 409);
  assert.deepEqual(rejectedCreate.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await firestore().collection(COLLECTIONS.privacyRequests).where("userId", "==", auth.userId).get()).size, 0);
  assert.equal((await firestore().collection(COLLECTIONS.privacyRequestSecrets).get()).size, 0);

  await userRef.update({ authorizationGeneration: 1, authorizationState: "active" });
  const inactiveCreateApp = await appThatChangesBefore("createAccount", { authorizationState: "deleting" });
  const inactiveCreate = await inactiveCreateApp.inject({ method: "POST", url: "/v1/privacy-requests", headers, payload: { right: "access" } });
  await inactiveCreateApp.close();
  assert.equal(inactiveCreate.statusCode, 401);
  assert.deepEqual(inactiveCreate.json(), { error: { code: "account_deleted" } });
  assert.equal((await firestore().collection(COLLECTIONS.privacyRequests).where("userId", "==", auth.userId).get()).size, 0);
  await userRef.update({ authorizationState: "active" });
  const created = await context.app.inject({ method: "POST", url: "/v1/privacy-requests", headers, payload: { right: "access" } });
  assert.equal(created.statusCode, 201);
  const requestId = created.json().request.requestId as string;
  const unavailableRaceApp = await appThatChangesBefore("readAccount");
  const rejectedUnavailableRead = await unavailableRaceApp.inject({ method: "GET", url: `/v1/privacy-requests/${requestId}`, headers });
  await unavailableRaceApp.close();
  assert.equal(rejectedUnavailableRead.statusCode, 409);
  assert.deepEqual(rejectedUnavailableRead.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal("response" in rejectedUnavailableRead.json(), false);
  assert.equal((await firestore().collection(COLLECTIONS.privacyRequests).doc(requestId).collection(COLLECTIONS.privacyRequestAudit).where("event", "==", "response_read").get()).size, 0);
  await userRef.update({ authorizationGeneration: 1, authorizationState: "active" });
  const noResponseYet = await context.app.inject({ method: "GET", url: `/v1/privacy-requests/${requestId}`, headers });
  assert.equal(noResponseYet.statusCode, 200);
  assert.equal(noResponseYet.json().response, null);
  assert.equal((await firestore().collection(COLLECTIONS.privacyRequests).doc(requestId).collection(COLLECTIONS.privacyRequestAudit).where("event", "==", "response_read").get()).size, 0);

  const admin = await createVerifiedAuthUser("lukasz.kurczab@gmail.com");
  const adminHeaders = { authorization: `Bearer ${admin.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const start = await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers: adminHeaders, payload: { action: "start_review", expectedRevision: 0 } });
  assert.equal(start.statusCode, 200);
  const prepare = await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers: adminHeaders, payload: { action: "prepare_response", expectedRevision: 1, outcome: "refused", response: "No qualifying data is available", reason: "No qualifying data is available", complaintInformationIncluded: true, executionEvidence: "operator_refusal_decision" } });
  assert.equal(prepare.statusCode, 200, prepare.body);
  const deliver = await context.app.inject({ method: "PATCH", url: `/v1/admin/privacy-requests/${requestId}`, headers: adminHeaders, payload: { action: "deliver", expectedRevision: 2 } });
  assert.equal(deliver.statusCode, 200);

  const readRaceApp = await appThatChangesBefore("readAccount");
  const rejectedRead = await readRaceApp.inject({ method: "GET", url: `/v1/privacy-requests/${requestId}`, headers });
  await readRaceApp.close();
  assert.equal(rejectedRead.statusCode, 409);
  assert.deepEqual(rejectedRead.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await firestore().collection(COLLECTIONS.privacyRequests).doc(requestId).collection(COLLECTIONS.privacyRequestAudit).where("event", "==", "response_read").get()).size, 0);
  assert.equal((await firestore().collection(COLLECTIONS.privacyRequests).doc(requestId).collection(COLLECTIONS.privacyRequestAudit).get()).docs.some((document) => document.data().event === "response_read"), false);

  await userRef.update({ authorizationGeneration: 1, authorizationState: "active" });
  const successfulRead = await context.app.inject({ method: "GET", url: `/v1/privacy-requests/${requestId}`, headers });
  assert.equal(successfulRead.statusCode, 200);
  assert.equal(successfulRead.json().response, "No qualifying data is available");
  assert.equal((await firestore().collection(COLLECTIONS.privacyRequests).doc(requestId).collection(COLLECTIONS.privacyRequestAudit).where("event", "==", "response_read").get()).size, 1);
});

test("a new Firebase identity cannot create a Patternly account through bearer or optional-bearer routes", async () => {
  const auth = await createAuthUser();
  const bearer = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  assert.equal(bearer.statusCode, 404);
  assert.deepEqual(bearer.json(), { error: { code: "account_not_found" } });
  const optionalApp = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: { verify: async () => ({ provider: "firebase", subject: auth.localId, email: auth.email, emailVerified: false, authTime: Math.floor(Date.now() / 1_000) }) },
    appCheckVerifier: { verify: async () => {} },
    stores: context.stores,
  });
  const optionalBearer = await optionalApp.inject({
    method: "POST",
    url: "/v1/content/reports",
    headers: { authorization: "Bearer verified-new-identity", "x-firebase-appcheck": "verified-app" },
    payload: reportBody("1f61e3f3-f23e-467c-b92a-9b8fd0514f25"),
  });
  await optionalApp.close();
  assert.equal(optionalBearer.statusCode, 404);
  assert.deepEqual(optionalBearer.json(), { error: { code: "account_not_found" } });
  const users = await firestore().collection("users").get();
  const identities = await firestore().collection("identityMappings").get();
  assert.equal(users.size, 0);
  assert.equal(identities.size, 0);
  assert.equal((await firestore().collection("contentReports").get()).size, 0);
});

test("explicit registration is atomic under concurrency and replay never changes existing legal evidence", async () => {
  const auth = await createAuthUser();
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const payload = { ...accountRegistrationPayload, termsVersion: "2026-09-05", privacyPolicyVersion: "2026-09-05" };
  const [first, second] = await Promise.all([
    context.app.inject({ method: "POST", url: "/v1/account/registration", headers, payload }),
    context.app.inject({ method: "POST", url: "/v1/account/registration", headers, payload }),
  ]);
  assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 201]);
  const created = [first, second].find((response) => response.statusCode === 201)!;
  const existing = [first, second].find((response) => response.statusCode === 200)!;
  assert.equal(created.json().registration.created, true);
  assert.equal(existing.json().registration.created, false);
  assert.equal(existing.json().registration.acceptance, null);
  assert.equal(existing.json().registration.user.id, created.json().registration.user.id);
  assert.equal(created.json().registration.acceptance.termsVersion, payload.termsVersion);
  assert.equal(created.json().registration.acceptance.termsLocale, "en");
  assert.equal(created.json().registration.acceptance.privacyPolicyVersion, payload.privacyPolicyVersion);
  assert.equal(created.json().registration.acceptance.privacyPolicyLocale, "en");
  assert.equal(created.json().registration.acceptance.privacyPolicyAcknowledged, true);
  assert.equal(typeof created.json().registration.acceptance.acceptedAt, "string");
  assert.deepEqual(Object.keys(created.json().registration.acceptance).sort(), ["acceptedAt", "privacyPolicyAcknowledged", "privacyPolicyLocale", "privacyPolicyVersion", "termsLocale", "termsVersion"]);
  const replay = await context.app.inject({ method: "POST", url: "/v1/account/registration", headers, payload: { ...payload, termsVersion: "2026-09-06", termsLocale: "pl", privacyPolicyVersion: "2026-09-06", privacyPolicyLocale: "pl" } });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().registration.created, false);
  assert.equal(replay.json().registration.acceptance, null);
  assert.equal(replay.json().registration.user.acceptedTermsVersion, payload.termsVersion);
  const users = await firestore().collection("users").get();
  const identities = await firestore().collection("identityMappings").get();
  assert.equal(users.size, 1);
  assert.equal(identities.size, 1);
  assert.equal(identities.docs[0]?.data().userId, created.json().registration.user.id);
  assert.equal(identities.docs[0]?.data().provider, "firebase");
  assert.equal(identities.docs[0]?.data().subject, auth.localId);
  const registeredUser = (await firestore().collection(COLLECTIONS.users).doc(created.json().registration.user.id).get()).data();
  assert.equal(registeredUser?.authorizationGeneration, 1);
  assert.equal(registeredUser?.authorizationState, "active");
  assert.equal(registeredUser?.authorizationRotatedAtSeconds, 0);
  const evidence = await firestore().collection("users").doc(created.json().registration.user.id).collection("legalAcceptances").get();
  assert.equal(evidence.size, 1);
  assert.deepEqual({
    kind: evidence.docs[0]?.data().kind,
    privacyPolicyAcknowledged: evidence.docs[0]?.data().privacyPolicyAcknowledged,
    privacyPolicyLocale: evidence.docs[0]?.data().privacyPolicyLocale,
    privacyPolicyVersion: evidence.docs[0]?.data().privacyPolicyVersion,
    termsLocale: evidence.docs[0]?.data().termsLocale,
    termsVersion: evidence.docs[0]?.data().termsVersion,
  }, {
    kind: "terms_acceptance_and_privacy_acknowledgement",
    privacyPolicyAcknowledged: true,
    privacyPolicyLocale: "en",
    privacyPolicyVersion: "2026-09-05",
    termsLocale: "en",
    termsVersion: "2026-09-05",
  });
  assert.deepEqual(Object.keys(evidence.docs[0]?.data() ?? {}).sort(), ["acceptedAt", "kind", "privacyPolicyAcknowledged", "privacyPolicyLocale", "privacyPolicyVersion", "termsLocale", "termsVersion"]);
  const currentSession = await setAuthCustomClaimsAndSignIn(auth, { authorizationGeneration: 1 });
  const me = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${currentSession.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.id, created.json().registration.user.id);
});

test("session exchange pins the active generation, supports legacy generation one, and rejects barriers or non-active accounts", async () => {
  const auth = await createAuthUser();
  const tokensBeforeExchange = context.customTokenSubjects.length;
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const { userId } = await registerAuthUser(context, auth);
  const userRef = firestore().collection(COLLECTIONS.users).doc(userId);

  await userRef.update({ authorizationGeneration: FieldValue.delete(), authorizationState: FieldValue.delete(), authorizationRotatedAtSeconds: FieldValue.delete() });
  const noBody = await context.app.inject({ method: "POST", url: "/v1/account/session/exchange", headers });
  assert.equal(noBody.statusCode, 200);
  assert.deepEqual(context.customTokenClaims.at(-1), { authorizationGeneration: 1 });
  const legacy = await context.app.inject({ method: "POST", url: "/v1/account/session/exchange", headers, payload: {} });
  assert.equal(legacy.statusCode, 200);
  assert.deepEqual(legacy.json(), { customToken: "fixture-custom-token" });
  assert.equal(legacy.headers["cache-control"], "private, no-store");
  assert.equal(context.customTokenSubjects.at(-1), auth.localId);
  assert.equal(context.customTokenSubjects.length, tokensBeforeExchange + 2);
  assert.deepEqual(context.customTokenClaims.at(-1), { authorizationGeneration: 1 });
  const invalidBody = await context.app.inject({ method: "POST", url: "/v1/account/session/exchange", headers, payload: { unexpected: true } });
  assert.equal(invalidBody.statusCode, 400);

  await userRef.update({ authorizationGeneration: 7, authorizationState: "active", authorizationRotatedAtSeconds: 0 });
  const current = await context.app.inject({ method: "POST", url: "/v1/account/session/exchange", headers, payload: {} });
  assert.equal(current.statusCode, 200);
  assert.equal(context.customTokenSubjects.at(-1), auth.localId);
  assert.deepEqual(context.customTokenClaims.at(-1), { authorizationGeneration: 7 });

  const verified = await createFirebaseTokenVerifier(testEnvironment)!.verify(auth.idToken);
  await userRef.update({ authorizationRotatedAtSeconds: verified.authTime });
  const stale = await context.app.inject({ method: "POST", url: "/v1/account/session/exchange", headers, payload: {} });
  assert.equal(stale.statusCode, 401);
  assert.deepEqual(stale.json(), { error: { code: "recent_reauthentication_required" } });

  await userRef.update({ authorizationRotatedAtSeconds: 0, authorizationState: "rotating" });
  const rotating = await context.app.inject({ method: "POST", url: "/v1/account/session/exchange", headers, payload: {} });
  assert.equal(rotating.statusCode, 401);
  assert.deepEqual(rotating.json(), { error: { code: "account_deleted" } });
  await userRef.update({ authorizationState: "deleting" });
  const deleting = await context.app.inject({ method: "POST", url: "/v1/account/session/exchange", headers, payload: {} });
  assert.equal(deleting.statusCode, 401);
  assert.deepEqual(deleting.json(), { error: { code: "account_deleted" } });
  await userRef.update({ authorizationState: "active" });
  const identity = parsePseudonymKeyRing(testEnvironment.deletionPseudonymKeysJson).active("firebase", auth.localId);
  await firestore().collection(COLLECTIONS.deletedIdentities).doc(identity.documentId).set({ deletedAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 60_000) });
  const tombstoned = await context.app.inject({ method: "POST", url: "/v1/account/session/exchange", headers, payload: {} });
  assert.equal(tombstoned.statusCode, 401);
  assert.deepEqual(tombstoned.json(), { error: { code: "account_deleted" } });
});

test("registration rejects an active deletion tombstone and replaces only an expired tombstone", async () => {
  const auth = await createAuthUser();
  const pseudonym = parsePseudonymKeyRing(testEnvironment.deletionPseudonymKeysJson).active("firebase", auth.localId);
  const tombstoneRef = firestore().collection(COLLECTIONS.deletedIdentities).doc(pseudonym.documentId);
  const deletedAt = Timestamp.now();
  await tombstoneRef.set({ provider: "firebase", keyVersion: pseudonym.keyVersion, subjectHmac: pseudonym.subjectHmac, deletedAt, expiresAt: Timestamp.fromMillis(Date.now() + 60_000) });
  const blocked = await context.app.inject({ method: "POST", url: "/v1/account/registration", headers: { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN }, payload: accountRegistrationPayload });
  assert.equal(blocked.statusCode, 401);
  assert.deepEqual(blocked.json(), { error: { code: "account_deleted" } });
  assert.equal((await firestore().collection(COLLECTIONS.users).get()).size, 0);
  assert.equal((await firestore().collection(COLLECTIONS.identityMappings).get()).size, 0);
  await tombstoneRef.update({ expiresAt: Timestamp.fromMillis(Date.now() - 1) });
  const registered = await registerAuthUser(context, auth);
  assert.match(registered.userId, /^[0-9a-f-]{36}$/u);
  assert.equal((await firestore().collection(COLLECTIONS.users).get()).size, 1);
  assert.equal((await firestore().collection(COLLECTIONS.identityMappings).get()).size, 1);
  assert.equal((await tombstoneRef.get()).exists, false);
});

test("legal acceptance is versioned, immutable, and exposed by the account profile", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const created = await context.app.inject({ method: "POST", url: "/v1/legal-acceptances", headers, payload: { termsVersion: "2026-09-05", minimumAgeConfirmed: 18 } });
  assert.equal(created.statusCode, 201);
  const repeated = await context.app.inject({ method: "POST", url: "/v1/legal-acceptances", headers, payload: { termsVersion: "2026-09-05", minimumAgeConfirmed: 18 } });
  assert.deepEqual(repeated.json(), created.json());
  const me = await context.app.inject({ method: "GET", url: "/v1/me", headers });
  assert.equal(me.json().user.acceptedTermsVersion, "2026-09-05");
  const evidence = await firestore().collection("users").doc(me.json().user.id).collection("legalAcceptances").get();
  assert.equal(evidence.size, 2);
  assert.equal(evidence.docs.find((document) => document.data().termsVersion === "2026-09-05")?.data().minimumAgeConfirmed, 18);
  const invalid = await context.app.inject({ method: "POST", url: "/v1/legal-acceptances", headers, payload: { termsVersion: "2026-09-05", minimumAgeConfirmed: 17 } });
  assert.equal(invalid.statusCode, 400);
});

test("purchase confirmation requires current Terms acceptance and preserves the immediate-start evidence", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const payload = { confirmationId: "00000000-0000-4000-8000-000000000059", termsVersion: "2026-09-05", productIdentifier: "com.lkurczab.patternly.premium.monthly", storefrontPrice: "29,99 zł", locale: "pl", immediateStartRequested: true };
  assert.equal((await context.app.inject({ method: "POST", url: "/v1/purchase-confirmations", headers, payload })).statusCode, 409);
  await context.app.inject({ method: "POST", url: "/v1/legal-acceptances", headers, payload: { termsVersion: payload.termsVersion, minimumAgeConfirmed: 18 } });
  const created = await context.app.inject({ method: "POST", url: "/v1/purchase-confirmations", headers, payload });
  assert.equal(created.statusCode, 201);
  assert.equal(typeof created.json().confirmation.attemptExpiresAt, "string");
  assert.equal((await context.app.inject({ method: "POST", url: "/v1/purchase-confirmations", headers, payload })).statusCode, 201);
  const competing = await context.app.inject({ method: "POST", url: "/v1/purchase-confirmations", headers, payload: { ...payload, confirmationId: "00000000-0000-4000-8000-000000000060" } });
  assert.equal(competing.statusCode, 409);
  assert.equal(competing.json().error.code, "purchase_attempt_active");
  const me = await context.app.inject({ method: "GET", url: "/v1/me", headers });
  const records = await firestore().collection("users").doc(me.json().user.id).collection("purchaseConfirmations").get();
  assert.equal(records.size, 1);
  assert.deepEqual({ autoRenews: records.docs[0]?.data().autoRenews, immediateStartRequested: records.docs[0]?.data().immediateStartRequested, trialOffered: records.docs[0]?.data().trialOffered }, { autoRenews: true, immediateStartRequested: true, trialOffered: false });
});

test("invalid Firebase bearer tokens fail closed without exposing identity details", async () => {
  const response = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: "Bearer invalid-emulator-bearer", "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: { code: "authentication_required" } });
});

test("production excludes hosted admin origin while local admin requires loopback", () => {
  const production = {
    NODE_ENV: "production",
    FIREBASE_PROJECT_ID: "patternly-app-sandbox",
    FIREBASE_AUTH_ISSUER: "https://securetoken.google.com/patternly-app-sandbox",
    ADMINISTRATOR_EMAIL: "admin@example.com",
    REPORT_RATE_LIMIT_HASH_SECRET: "test-only-report-rate-limit-secret-0123456789",
    DELETION_PSEUDONYM_KEYS_JSON: JSON.stringify([{ version: "test-v1", status: "active", keyBase64: Buffer.alloc(32, 7).toString("base64") }]),
    PRIVACY_RESPONSE_KEY_BASE64: Buffer.alloc(32, 11).toString("base64"),
    PRIVACY_AUDIT_HMAC_SECRET: "test-only-privacy-audit-hmac-secret-0123456789",
    SMTP_HOST: "smtp-relay.gmail.com",
    SMTP_PORT: "465",
    SMTP_USERNAME: "sender@example.com",
    SMTP_PASSWORD: "test-secret",
    SMTP_FROM_EMAIL: "privacy@example.com",
    SMTP_FROM_NAME: "Patternly",
    REVENUECAT_WEBHOOK_SECRET: "Bearer test-revenuecat-secret",
    REVENUECAT_APP_ID: "app-1",
    REVENUECAT_ENTITLEMENT_ID: "premium",
    REVENUECAT_PRODUCT_ID: "monthly",
    REVENUECAT_WEBHOOK_ENVIRONMENT: "PRODUCTION",
  };
  assert.equal(loadEnvironment(production).adminWebOrigin, undefined);
  for (const ADMIN_WEB_ORIGIN of ["https://admin.example.com", "http://admin.example.com", "http://127.0.0.1:4173", "https://admin.example.com/", "https://admin.example.com/admin", "https://admin.example.com?query=value", "https://user:password@admin.example.com"]) {
    assert.throws(() => loadEnvironment({ ...production, ADMIN_WEB_ORIGIN }), { message: "invalid_admin_web_origin" });
  }
  const localAdmin = {
    ...production,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    ADMIN_WEB_ORIGIN: "http://127.0.0.1:4173",
    FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST,
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
  };
  assert.equal(loadEnvironment(localAdmin).adminWebOrigin, localAdmin.ADMIN_WEB_ORIGIN);
  for (const invalid of [
    { HOST: "0.0.0.0" },
    { HOST: "192.168.1.2" },
    { FIREBASE_AUTH_EMULATOR_HOST: undefined },
    { FIRESTORE_EMULATOR_HOST: undefined },
    { FIREBASE_AUTH_EMULATOR_HOST: "firebase.example:9099" },
    { FIRESTORE_EMULATOR_HOST: "firestore.example:8080" },
    { ADMIN_WEB_ORIGIN: "https://admin.example.com" },
  ]) assert.throws(() => loadEnvironment({ ...localAdmin, ...invalid }), { message: "invalid_admin_web_origin" });
  assert.throws(() => loadEnvironment({ ...localAdmin, NODE_ENV: "development" }), { message: "invalid_admin_web_origin" });
  assert.equal(loadEnvironment({ ...localAdmin, NODE_ENV: "development", FIREBASE_PROJECT_ID: "demo-patternly-admin" }).adminWebOrigin, localAdmin.ADMIN_WEB_ORIGIN);
});

test("administrator routes are unavailable in production before Firebase verification", async () => {
  const app = buildApplication({
    environment: { ...testEnvironment, nodeEnv: "production", adminWebOrigin: undefined },
    firestore: null,
    verifier: { verify: async () => { throw new Error("verifier_must_not_run"); } },
    appCheckVerifier: null,
    stores: context.stores,
  });
  const response = await app.inject({ method: "GET", url: "/v1/admin/overview", headers: { authorization: "Bearer any-token", origin: "https://admin.example.com" } });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: { code: "admin_unavailable" } });
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  const options = await app.inject({ method: "OPTIONS", url: "/v1/admin/overview", headers: { origin: "https://admin.example.com" } });
  assert.equal(options.statusCode, 404);
  assert.deepEqual(options.json(), { error: { code: "admin_unavailable" } });
  await app.close();
});

test("revoked Firebase verifier results fail closed at the backend boundary", async () => {
  const revokedApp = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: { verify: async () => { throw new Error("firebase_token_invalid"); } },
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: context.stores,
  });
  const response = await revokedApp.inject({ method: "GET", url: "/v1/me", headers: { authorization: "Bearer revoked-session", "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  await revokedApp.close();
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: { code: "authentication_required" } });
});

test("Firestore transaction preserves sync CAS and idempotency under concurrent retries", async () => {
  const auth = await createRegisteredAuthUser(context);
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
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const userId = (await context.app.inject({ method: "GET", url: "/v1/me", headers })).json().user.id as string;
  const [first, second] = await Promise.all([
    context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: canonicalSyncPayload(0, [mutation]) }),
    context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: canonicalSyncPayload(0, [mutation]) }),
  ]);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(first.json().applied.length, 1);
  assert.equal(second.json().applied.length, 1);
  const persistedMutation = (await firestore().collection("users").doc(userId).collection("syncMutations").doc(mutation.mutationId).get()).data();
  assert.ok(persistedMutation?.createdAt instanceof Timestamp);
  assert.ok(persistedMutation?.expiresAt instanceof Timestamp);
  assert.equal(persistedMutation.expiresAt.toMillis() - persistedMutation.createdAt.toMillis(), 30 * 24 * 60 * 60 * 1_000);
  const retryCreatedAt = persistedMutation.createdAt.toMillis();
  const retryExpiresAt = persistedMutation.expiresAt.toMillis();
  const replay = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: canonicalSyncPayload(0, [mutation]) });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().applied.length, 1);
  const replayedMutation = (await firestore().collection("users").doc(userId).collection("syncMutations").doc(mutation.mutationId).get()).data();
  assert.equal(replayedMutation?.createdAt.toMillis(), retryCreatedAt);
  assert.equal(replayedMutation?.expiresAt.toMillis(), retryExpiresAt);
  const conflictState = { mastery: "mastered" };
  const conflict = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: canonicalSyncPayload(1, [{ ...mutation, mutationId: `${mutation.mutationId}-conflict`, expectedVersion: null, state: conflictState, fingerprint: createMergeRecordFingerprint({ recordId: "item-1", recordType: "training_attempt", state: conflictState, trackId: mutation.trackId }) }]) });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().conflicts[0].current.version, 1);
  assert.equal(conflict.json().conflicts[0].current.state.mastery, "learning");
});

test("progress sync rejects fresh writes and batch replays when authorization rotates after the request guard", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const userRef = firestore().collection(COLLECTIONS.users).doc(auth.userId);
  const state = { mastery: "learning" };
  const trackId = "coding-interview-dsa-problem-solving";
  const syncMutation = {
    mutationId: `generation-race-sync-${Date.now()}`,
    kind: "item" as const,
    recordType: "training_attempt" as const,
    trackId,
    targetId: "generation-race-attempt",
    expectedVersion: null,
    state,
    fingerprint: createMergeRecordFingerprint({ recordId: "generation-race-attempt", recordType: "training_attempt", state, trackId }),
  };
  const payload = canonicalSyncPayload(0, [syncMutation], "authorization-generation-race-sync");

  async function appThatChangesBeforeSync(changes: Readonly<Record<string, unknown>> = { authorizationGeneration: 2 }) {
    const originalProgress = context.stores.progress;
    let rotated = false;
    const progress = new Proxy(originalProgress, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === "applyBatch" && typeof value === "function") return async (...args: unknown[]) => {
          if (!rotated) {
            rotated = true;
            await userRef.update(changes);
          }
          return value.apply(target, args);
        };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return buildApplication({ environment: testEnvironment, firestore: null, verifier: createFirebaseTokenVerifier(testEnvironment), appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } }, stores: { ...context.stores, progress } });
  }

  const freshRaceApp = await appThatChangesBeforeSync();
  const fresh = await freshRaceApp.inject({ method: "POST", url: "/v1/progress/sync", headers, payload });
  await freshRaceApp.close();
  assert.equal(fresh.statusCode, 409);
  assert.deepEqual(fresh.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await userRef.collection("progress").get()).size, 0);
  assert.equal((await userRef.collection("syncMutations").get()).size, 0);
  assert.equal((await userRef.collection("syncBatches").get()).size, 0);

  await userRef.update({ authorizationGeneration: 1 });
  const first = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload });
  assert.equal(first.statusCode, 200, first.body);
  const replayRaceApp = await appThatChangesBeforeSync();
  const replay = await replayRaceApp.inject({ method: "POST", url: "/v1/progress/sync", headers, payload });
  await replayRaceApp.close();
  assert.equal(replay.statusCode, 409);
  assert.deepEqual(replay.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await userRef.collection("progress").get()).size, 1);
  assert.equal((await userRef.collection("syncMutations").get()).size, 1);
  assert.equal((await userRef.collection("syncBatches").get()).size, 1);

  await userRef.update({ authorizationGeneration: 1, authorizationState: "active" });
  const inactiveRaceApp = await appThatChangesBeforeSync({ authorizationState: "rotating" });
  const inactive = await inactiveRaceApp.inject({ method: "POST", url: "/v1/progress/sync", headers, payload });
  await inactiveRaceApp.close();
  assert.equal(inactive.statusCode, 401);
  assert.deepEqual(inactive.json(), { error: { code: "account_deleted" } });
  assert.equal((await userRef.collection("progress").get()).size, 1);
  assert.equal((await userRef.collection("syncMutations").get()).size, 1);
  assert.equal((await userRef.collection("syncBatches").get()).size, 1);
});

test("one-shot adoption rejects fresh confirmation and operation replay when authorization rotates after the request guard", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const userRef = firestore().collection(COLLECTIONS.users).doc(auth.userId);
  const state = { trackId: "coding-interview-dsa-problem-solving" };
  const guestUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const snapshot = {
    guestSnapshotVersion: 1,
    guestUserId,
    records: [{ fingerprint: createMergeRecordFingerprint({ recordId: "generation-race-active", recordType: "active_track", state, trackId: state.trackId }), recordId: "generation-race-active", recordType: "active_track" as const, state, trackId: state.trackId, version: 0 }],
    activeSession: false,
    pendingJournal: false,
  };
  const previewResponse = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/preview", headers, payload: snapshot });
  assert.equal(previewResponse.statusCode, 200, previewResponse.body);
  const preview = previewResponse.json().preview;
  const payload = { deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", snapshot, confirmation: { operationId: preview.operationId, previewFingerprint: preview.fingerprint, resolutions: [], groupChoices: [] } };

  async function appThatChangesBeforeConfirm(changes: Readonly<Record<string, unknown>> = { authorizationGeneration: 2 }) {
    const originalProgress = context.stores.progress;
    let rotated = false;
    const progress = new Proxy(originalProgress, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === "confirmAdoption" && typeof value === "function") return async (...args: unknown[]) => {
          if (!rotated) {
            rotated = true;
            await userRef.update(changes);
          }
          return value.apply(target, args);
        };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return buildApplication({ environment: testEnvironment, firestore: null, verifier: createFirebaseTokenVerifier(testEnvironment), appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } }, stores: { ...context.stores, progress } });
  }

  const freshRaceApp = await appThatChangesBeforeConfirm();
  const fresh = await freshRaceApp.inject({ method: "POST", url: "/v1/account-data/adoption/confirm", headers, payload });
  await freshRaceApp.close();
  assert.equal(fresh.statusCode, 409);
  assert.deepEqual(fresh.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await userRef.collection("progress").get()).size, 0);
  assert.equal((await userRef.collection("syncMutations").get()).size, 0);
  assert.equal((await userRef.collection("syncOperations").get()).size, 0);

  await userRef.update({ authorizationGeneration: 1 });
  const first = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/confirm", headers, payload });
  assert.equal(first.statusCode, 200, first.body);
  const replayRaceApp = await appThatChangesBeforeConfirm();
  const replay = await replayRaceApp.inject({ method: "POST", url: "/v1/account-data/adoption/confirm", headers, payload });
  await replayRaceApp.close();
  assert.equal(replay.statusCode, 409);
  assert.deepEqual(replay.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await userRef.collection("progress").get()).size, 1);
  assert.equal((await userRef.collection("syncMutations").get()).size, 1);
  assert.equal((await userRef.collection("syncOperations").get()).size, 1);

  await userRef.update({ authorizationGeneration: 1, authorizationState: "active" });
  const inactiveRaceApp = await appThatChangesBeforeConfirm({ authorizationState: "rotating" });
  const inactive = await inactiveRaceApp.inject({ method: "POST", url: "/v1/account-data/adoption/confirm", headers, payload });
  await inactiveRaceApp.close();
  assert.equal(inactive.statusCode, 401);
  assert.deepEqual(inactive.json(), { error: { code: "account_deleted" } });
  assert.equal((await userRef.collection("progress").get()).size, 1);
  assert.equal((await userRef.collection("syncMutations").get()).size, 1);
  assert.equal((await userRef.collection("syncOperations").get()).size, 1);
});

test("sync rejects duplicate mutations before writing and applies distinct targets", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const userId = auth.userId;
  const mutation = (mutationId: string, targetId: string, mastery: string) => ({
    mutationId,
    kind: "item" as const,
    recordType: "training_attempt" as const,
    trackId: "coding-interview-dsa-problem-solving",
    targetId,
    expectedVersion: null,
    state: { mastery },
    fingerprint: createMergeRecordFingerprint({ recordId: targetId, recordType: "training_attempt", state: { mastery }, trackId: "coding-interview-dsa-problem-solving" }),
  });
  const original = mutation(`duplicate-id-${Date.now()}-001`, "item-1", "learning");
  const duplicateId = { ...mutation(`duplicate-id-${Date.now()}-002`, "item-2", "mastered"), mutationId: original.mutationId };
  const duplicateTarget = mutation(`duplicate-target-${Date.now()}-001`, "item-1", "mastered");
  for (const [index, mutations] of [[0, [original, duplicateId]], [1, [original, duplicateTarget]]] as const) {
    const response = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: canonicalSyncPayload(0, mutations, `duplicate-batch-${index}-${Date.now()}`) });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, "invalid_request");
    assert.equal((await firestore().collection("users").doc(userId).collection("progress").get()).size, 0);
    assert.equal((await firestore().collection("users").doc(userId).collection("syncMutations").get()).size, 0);
    assert.equal((await firestore().collection("users").doc(userId).collection("syncBatches").get()).size, 0);
    assert.equal((await firestore().collection("users").doc(userId).collection("syncMetadata").doc("account").get()).exists, false);
  }

  const valid = await context.app.inject({
    method: "POST",
    url: "/v1/progress/sync",
    headers,
    payload: canonicalSyncPayload(0, [mutation(`distinct-target-${Date.now()}-001`, "item-1", "learning"), mutation(`distinct-target-${Date.now()}-002`, "item-2", "mastered")], "distinct-target-batch"),
  });
  assert.equal(valid.statusCode, 200, valid.body);
  assert.equal(valid.json().applied.length, 2);
  assert.equal((await firestore().collection("users").doc(userId).collection("progress").get()).size, 2);
});

test("account adoption is previewed, explicitly confirmed, materialized idempotently, and guarded by account CAS", async () => {
  const auth = await createRegisteredAuthUser(context);
  const me = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
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
  const confirmation = { operationId: preview.operationId, previewFingerprint: preview.fingerprint, resolutions: [], groupChoices: [] };
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
  const operation = (await firestore().collection("users").doc(me.json().user.id).collection("syncOperations").doc(confirmation.operationId).get()).data();
  assert.ok(operation?.createdAt instanceof Timestamp);
  assert.ok(operation?.expiresAt instanceof Timestamp);
  assert.equal(operation.expiresAt.toMillis() - operation.createdAt.toMillis(), 30 * 24 * 60 * 60 * 1_000);
  const adoptionMutation = (await firestore().collection("users").doc(me.json().user.id).collection("syncMutations").doc(first.json().mutationIds[0]).get()).data();
  assert.ok(adoptionMutation?.createdAt instanceof Timestamp);
  assert.ok(adoptionMutation?.expiresAt instanceof Timestamp);
  assert.equal(adoptionMutation.expiresAt.toMillis() - adoptionMutation.createdAt.toMillis(), 30 * 24 * 60 * 60 * 1_000);

  const staleMutationState = { trackId: "google-cloud-associate-cloud-engineer" };
  const staleMutation = { mutationId: `mutation-${Date.now()}-stale`, kind: "node" as const, recordType: "active_track" as const, trackId: "google-cloud-associate-cloud-engineer", targetId: "current", expectedVersion: null, state: staleMutationState, fingerprint: createMergeRecordFingerprint({ recordId: "current", recordType: "active_track", state: staleMutationState, trackId: "google-cloud-associate-cloud-engineer" }) };
  const stale = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: canonicalSyncPayload(0, [staleMutation], "stale-batch") });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "account_revision_conflict");
  const switchedTrack = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: canonicalSyncPayload(1, [staleMutation], "switched-batch") });
  assert.equal(switchedTrack.statusCode, 200);
  const switchedRemote = await context.app.inject({ method: "GET", url: "/v1/progress", headers });
  assert.equal(switchedRemote.json().records.length, 2);
  assert.ok(switchedRemote.json().records.some((record: { state: { trackId?: string } }) => record.state.trackId === "google-cloud-associate-cloud-engineer"));

  const blockedPreview = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/preview", headers, payload: { ...snapshot, guestSnapshotVersion: 2, activeSession: true } });
  assert.equal(blockedPreview.statusCode, 200);
  assert.equal(blockedPreview.json().plan.blockingReason, "active_session");
  const blockedConfirmation = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/confirm", headers, payload: { deviceId: request.deviceId, snapshot: { ...snapshot, guestSnapshotVersion: 2, activeSession: true }, confirmation: { operationId: blockedPreview.json().preview.operationId, previewFingerprint: blockedPreview.json().preview.fingerprint, resolutions: [], groupChoices: [] } } });
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
  const result = await context.stores.contentReports.create(undefined, undefined, input, { rateLimitKey: "anonymous-test-client" });
  assert.equal(result.duplicate, false);
  assert.equal(result.report.linkage, "unlinked");
  const stored = (await firestore().collection("contentReports").doc(input.clientSubmissionId).get()).data();
  assert.ok(stored);
  for (const forbiddenField of ["accountId", "contactEmail", "email", "learnerResponse", "prompt", "feedback"]) assert.equal(forbiddenField in stored, false, forbiddenField);
  assert.equal(stored.description, input.description);
  assert.equal(stored.itemId, input.itemId);
  assert.deepEqual(stored.context, input.context);
  assert.ok(stored.expiresAt);
  assert.equal(stored.expiresAt.toMillis() - stored.createdAt.toMillis(), 30 * 24 * 60 * 60 * 1_000);
});

test("content report expiry is classified at creation and unlinking does not extend it", async () => {
  const anonymous = reportBody("3f61e3f3-f23e-467c-b92a-9b8fd0514f25");
  const contact = createContentReportSchema.parse({ ...reportBody("3f61e3f3-f23e-467c-b92a-9b8fd0514f26"), contactEmail: "contact@example.com" });
  await context.stores.contentReports.create(undefined, undefined, anonymous, { rateLimitKey: "anonymous-expiry" });
  await context.stores.contentReports.create(undefined, undefined, contact, { rateLimitKey: "contact-expiry" });
  const auth = await createRegisteredAuthUser(context);
  const me = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  const userId = me.json().user.id as string;
  const linked = createContentReportSchema.parse({ ...reportBody("3f61e3f3-f23e-467c-b92a-9b8fd0514f27"), linkAccount: true });
  await context.stores.contentReports.create(userId, 1, linked, { rateLimitKey: "account-expiry" });
  const anonymousStored = (await firestore().collection("contentReports").doc(anonymous.clientSubmissionId).get()).data();
  const contactStored = (await firestore().collection("contentReports").doc(contact.clientSubmissionId).get()).data();
  const linkedStored = (await firestore().collection("contentReports").doc(linked.clientSubmissionId).get()).data();
  assert.equal(anonymousStored?.expiresAt.toMillis() - anonymousStored?.createdAt.toMillis(), 30 * 24 * 60 * 60 * 1_000);
  assert.equal(contactStored?.expiresAt.toMillis() - contactStored?.createdAt.toMillis(), 180 * 24 * 60 * 60 * 1_000);
  assert.equal(linkedStored?.expiresAt.toMillis() - linkedStored?.createdAt.toMillis(), 180 * 24 * 60 * 60 * 1_000);
  const linkedExpiry = linkedStored?.expiresAt.toMillis();
  await context.stores.contentReports.unlinkAccount(userId);
  const unlinked = (await firestore().collection("contentReports").doc(linked.clientSubmissionId).get()).data();
  assert.equal("accountId" in (unlinked ?? {}), false);
  assert.equal(unlinked?.expiresAt.toMillis(), linkedExpiry);
});

test("content reports canonicalize an empty description without persisting learner-provided text", async () => {
  const input = createContentReportSchema.parse({ ...reportBody("1f61e3f3-f23e-467c-b92a-9b8fd0514f25"), reason: "technical_issue", description: "   " });
  const result = await context.stores.contentReports.create(undefined, undefined, input, { rateLimitKey: "empty-description-client" });
  assert.equal(result.report.description, "No additional details provided.");
  const stored = (await firestore().collection("contentReports").doc(input.clientSubmissionId).get()).data();
  assert.equal(stored?.description, result.report.description);
});

test("content report descriptions reject contact data and obvious secrets before persistence", async () => {
  const base = reportBody("2f61e3f3-f23e-467c-b92a-9b8fd0514f25");
  const app = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: { verify: async () => { throw new Error("authentication_required"); } },
    appCheckVerifier: { verify: async () => {} },
    stores: context.stores,
  });
  for (const description of [
    "Please reply to learner@example.com.",
    "Call me on +48 600 700 800.",
    "The issue is shown at https://example.com/report.",
    "password: hunter2",
    "kod jednorazowy: 123456",
    "ABCD-EFGH-IJKL-MNOP",
  ]) {
    const parsed = createContentReportSchema.safeParse({ ...base, description });
    assert.equal(parsed.success, false, description);
    const response = await app.inject({ method: "POST", url: "/v1/content/reports", headers: { "x-firebase-appcheck": "test-app-check" }, payload: { ...base, description } });
    assert.equal(response.statusCode, 400, description);
  }
  await app.close();
  assert.equal((await firestore().collection("contentReports").get()).size, 0);
});

test("content report retries are idempotent and do not consume the rate-limit bucket twice", async () => {
  const app = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: { verify: async () => { throw new Error("authentication_required"); } },
    appCheckVerifier: { verify: async () => {} },
    stores: context.stores,
  });
  const input = reportBody("6f61e3f3-f23e-467c-b92a-9b8fd0514f25");
  const headers = { "x-firebase-appcheck": "test-app-check" };
  const first = await app.inject({ method: "POST", url: "/v1/content/reports", headers, payload: input });
  const second = await app.inject({ method: "POST", url: "/v1/content/reports", headers, payload: input });
  await app.close();
  assert.equal(first.statusCode, 201);
  assert.equal(first.json().duplicate, false);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().duplicate, true);
  assert.equal(second.json().report.id, first.json().report.id);
  const reports = await firestore().collection("contentReports").get();
  assert.equal(reports.size, 1);
  const buckets = await firestore().collection("rateLimitBuckets").get();
  assert.equal(buckets.size, 1);
  assert.equal(buckets.docs[0]?.data().count, 1);
});

test("optional-bearer content report writes fence linked, unlinked and duplicate requests before rate limits", async () => {
  for (const linkAccount of [false, true]) {
    const auth = await createRegisteredAuthUser(context);
    const input = createContentReportSchema.parse({ ...reportBody(linkAccount ? "a161e3f3-f23e-467c-b92a-9b8fd0514f25" : "a261e3f3-f23e-467c-b92a-9b8fd0514f25"), linkAccount });
    const original = context.stores.contentReports;
    const contentReports = new Proxy(original, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property !== "create" || typeof value !== "function") return value;
        return async (...args: Parameters<BackendStores["contentReports"]["create"]>) => {
          await firestore().collection(COLLECTIONS.users).doc(auth.userId).update({ authorizationGeneration: 2 });
          return value.apply(target, args);
        };
      },
    });
    const app = buildAppWithOverrides({ contentReports });
    const response = await app.inject({
      method: "POST", url: "/v1/content/reports",
      headers: { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN },
      payload: input,
    });
    await app.close();
    assert.equal(response.statusCode, 409, `linkAccount=${linkAccount}`);
    assert.deepEqual(response.json(), { error: { code: "authorization_generation_conflict" } });
    assert.equal((await firestore().collection(COLLECTIONS.contentReports).doc(input.clientSubmissionId).get()).exists, false);
  }
  assert.equal((await firestore().collection(COLLECTIONS.rateLimitBuckets).get()).size, 0);

  const auth = await createRegisteredAuthUser(context);
  const duplicateInput = reportBody("a361e3f3-f23e-467c-b92a-9b8fd0514f25");
  let createCount = 0;
  const original = context.stores.contentReports;
  const contentReports = new Proxy(original, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property !== "create" || typeof value !== "function") return value;
      return async (...args: Parameters<BackendStores["contentReports"]["create"]>) => {
        createCount += 1;
        if (createCount === 2) await firestore().collection(COLLECTIONS.users).doc(auth.userId).update({ authorizationGeneration: 2 });
        return value.apply(target, args);
      };
    },
  });
  const app = buildAppWithOverrides({ contentReports });
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const first = await app.inject({ method: "POST", url: "/v1/content/reports", headers, payload: duplicateInput });
  const replay = await app.inject({ method: "POST", url: "/v1/content/reports", headers, payload: duplicateInput });
  await app.close();
  assert.equal(first.statusCode, 201);
  assert.equal(replay.statusCode, 409);
  assert.deepEqual(replay.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await firestore().collection(COLLECTIONS.contentReports).doc(duplicateInput.clientSubmissionId).get()).exists, true);
  const buckets = await firestore().collection(COLLECTIONS.rateLimitBuckets).get();
  assert.equal(buckets.size, 1);
  assert.equal(buckets.docs[0]?.data().count, 1);
});

test("administrator report triage uses an idempotent monotonic state machine and records an audit event", async () => {
  const input = reportBody("4f61e3f3-f23e-467c-b92a-9b8fd0514f25");
  await context.stores.contentReports.create(undefined, undefined, input, { rateLimitKey: "triage-test-client" });
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
  const report = (await firestore().collection("contentReports").doc(input.clientSubmissionId).get()).data();
  assert.equal(audit.docs[0]?.data().expiresAt.toMillis(), report?.expiresAt.toMillis());
  const queue = await context.stores.contentReports.listQueue();
  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.status, "in_review");
});

test("administrator report routes require a current verified administrator token and allow only the full state machine", async () => {
  const input = reportBody("5f61e3f3-f23e-467c-b92a-9b8fd0514f25");
  await context.stores.contentReports.create(undefined, undefined, input, { rateLimitKey: "admin-route-test-client" });
  const patch = { method: "PATCH" as const, url: `/v1/admin/content-reports/${input.clientSubmissionId}`, payload: { status: "in_review" } };
  const protectedRoutes = [{ method: "GET" as const, url: "/v1/admin/content-reports" }, patch];
  const nonAdmin = await createVerifiedAuthUser();
  const unverifiedAdmin = await createAuthUser("lukasz.kurczab@gmail.com");
  for (const route of protectedRoutes) {
    const missing = await context.app.inject(route);
    assert.equal(missing.statusCode, 401);
    const invalid = await context.app.inject({ ...route, headers: { authorization: "Bearer invalid-emulator-bearer" } });
    assert.equal(invalid.statusCode, 401);
    const denied = await context.app.inject({ ...route, headers: { authorization: `Bearer ${nonAdmin.idToken}` } });
    assert.equal(denied.statusCode, 403);
    const unverified = await context.app.inject({ ...route, headers: { authorization: `Bearer ${unverifiedAdmin.idToken}` } });
    assert.equal(unverified.statusCode, 403);
  }

  const admin = await verifyAuthUser(unverifiedAdmin);
  const headers = { authorization: `Bearer ${admin.idToken}` };
  const overview = await context.app.inject({ method: "GET", url: "/v1/admin/overview", headers });
  assert.equal(overview.statusCode, 200);
  assert.equal(overview.json().questionBank.status, "unavailable");
  const unavailableQuestions = await context.app.inject({ method: "GET", url: "/v1/admin/questions?page=1&pageSize=25", headers });
  assert.equal(unavailableQuestions.statusCode, 503);
  assert.deepEqual(unavailableQuestions.json(), { error: { code: "question_inspection_unavailable", reason: "canonical_package_inspection_not_configured" } });
  const accepted = await context.app.inject({ method: "GET", url: "/v1/admin/content-reports", headers });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().reports[0]?.clientSubmissionId, input.clientSubmissionId);

  const inReview = await context.app.inject({ ...patch, headers });
  assert.equal(inReview.statusCode, 200);
  assert.equal(inReview.json().report.status, "in_review");
  const resolved = await context.app.inject({ method: "PATCH", url: patch.url, headers, payload: { status: "resolved" } });
  assert.equal(resolved.statusCode, 200);
  const resolvedQueue = await context.app.inject({ method: "GET", url: "/v1/admin/content-reports", headers });
  assert.equal(resolvedQueue.statusCode, 200);
  assert.equal(resolvedQueue.json().reports[0]?.status, "resolved");
  const closed = await context.app.inject({ method: "PATCH", url: patch.url, headers, payload: { status: "closed" } });
  assert.equal(closed.statusCode, 200);
  const repeated = await context.app.inject({ method: "PATCH", url: patch.url, headers, payload: { status: "closed" } });
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json().duplicate, true);
  const queueAfterClose = await context.app.inject({ method: "GET", url: "/v1/admin/content-reports", headers });
  assert.equal(queueAfterClose.statusCode, 200);
  assert.equal(queueAfterClose.json().reports.length, 0);
  const audit = await firestore().collection("contentReports").doc(input.clientSubmissionId).collection("audit").get();
  assert.equal(audit.size, 3);
  const invalidTransition = await context.app.inject({ method: "PATCH", url: patch.url, headers, payload: { status: "resolved" } });
  assert.equal(invalidTransition.statusCode, 409);

  const preflight = await context.app.inject({
    method: "OPTIONS",
    url: "/v1/admin/content-reports",
    headers: { origin: "http://127.0.0.1:4173" },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "http://127.0.0.1:4173");
  assert.equal(preflight.headers["access-control-allow-methods"], "GET, POST, PATCH, OPTIONS");
  assert.equal(preflight.headers["access-control-allow-credentials"], undefined);

  const corsGet = await context.app.inject({ method: "GET", url: "/v1/admin/content-reports", headers: { ...headers, origin: "http://127.0.0.1:4173" } });
  assert.equal(corsGet.headers["access-control-allow-origin"], "http://127.0.0.1:4173");
  assert.equal(corsGet.headers["access-control-allow-credentials"], undefined);

  const wrongOrigin = await context.app.inject({
    method: "OPTIONS",
    url: "/v1/admin/content-reports",
    headers: { origin: "http://malicious.example" },
  });
  assert.equal(wrongOrigin.statusCode, 403);
  assert.deepEqual(wrongOrigin.json(), { error: { code: "origin_not_allowed" } });
  assert.equal((await firestore().collection(COLLECTIONS.users).get()).size, 0);
  assert.equal((await firestore().collection(COLLECTIONS.identityMappings).get()).size, 0);
});

test("anonymous report rate limiting is transactionally enforced without storing the client key", async () => {
  await context.stores.contentReports.create(undefined, undefined, reportBody("af61e3f3-f23e-467c-b92a-9b8fd0514f25"), { rateLimitKey: "rate-limited-client" });
  await context.stores.contentReports.create(undefined, undefined, reportBody("bf61e3f3-f23e-467c-b92a-9b8fd0514f25"), { rateLimitKey: "rate-limited-client" });
  await assert.rejects(
    context.stores.contentReports.create(undefined, undefined, reportBody("cf61e3f3-f23e-467c-b92a-9b8fd0514f25"), { rateLimitKey: "rate-limited-client" }),
    { message: "report_rate_limited" },
  );
  const buckets = await firestore().collection("rateLimitBuckets").get();
  assert.equal(buckets.size, 1);
  assert.equal("rateLimitKey" in (buckets.docs[0]?.data() ?? {}), false);
});

test("recovery codes are ten one-time server-hashed credentials, reissue invalidates the previous set, and replay is rejected", async () => {
  const auth = await createRegisteredAuthUser(context);
  const tokensBeforeRecovery = context.customTokenSubjects.length;
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const firstIssued = await context.app.inject({ method: "POST", url: "/v1/account/recovery-codes", headers, payload: {} });
  assert.equal(firstIssued.statusCode, 200);
  const firstCodes = firstIssued.json().codes as string[];
  const firstRecoveryCode = firstCodes[0]!;
  assert.equal(firstCodes.length, 10);
  assert.equal(new Set(firstCodes).size, 10);
  for (const code of firstCodes) assert.match(code, /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/u);
  const firstStored = await firestore().collection("recoveryCodeIndex").get();
  assert.equal(firstStored.size, 10);
  for (const document of firstStored.docs) {
    assert.match(document.id, /^[a-f0-9]{64}$/u);
    assert.equal("code" in document.data(), false);
    assert.equal("rawCode" in document.data(), false);
  }

  const secondIssued = await context.app.inject({ method: "POST", url: "/v1/account/recovery-codes", headers, payload: {} });
  assert.equal(secondIssued.statusCode, 200);
  const secondCodes = secondIssued.json().codes as string[];
  const secondRecoveryCode = secondCodes[0]!;
  assert.equal(secondCodes.length, 10);
  assert.equal(new Set(secondCodes).size, 10);
  assert.notDeepEqual(secondCodes, firstCodes);
  const secondStored = await firestore().collection("recoveryCodeIndex").get();
  assert.equal(secondStored.size, 10);
  for (const document of secondStored.docs) {
    assert.match(document.id, /^[a-f0-9]{64}$/u);
    assert.equal("code" in document.data(), false);
    assert.equal("rawCode" in document.data(), false);
  }

  const userRef = firestore().collection(COLLECTIONS.users).doc(auth.userId);
  await userRef.update({ authorizationState: "unknown" });
  const inactive = await context.app.inject({ method: "POST", url: "/v1/public/recovery-codes/consume", headers: { "x-firebase-appcheck": TEST_APP_CHECK_TOKEN }, payload: { code: secondRecoveryCode } });
  assert.equal(inactive.statusCode, 401);
  assert.deepEqual(inactive.json(), { error: { code: "recovery_code_invalid" } });
  await userRef.update({ authorizationState: "active", authorizationGeneration: 0 });
  const malformedGeneration = await context.app.inject({ method: "POST", url: "/v1/public/recovery-codes/consume", headers: { "x-firebase-appcheck": TEST_APP_CHECK_TOKEN }, payload: { code: secondRecoveryCode } });
  assert.equal(malformedGeneration.statusCode, 401);
  assert.deepEqual(malformedGeneration.json(), { error: { code: "recovery_code_invalid" } });
  await userRef.update({ authorizationGeneration: 1 });
  const pseudonym = parsePseudonymKeyRing(testEnvironment.deletionPseudonymKeysJson).active("firebase", auth.localId);
  const tombstoneRef = firestore().collection(COLLECTIONS.deletedIdentities).doc(pseudonym.documentId);
  await tombstoneRef.set({ deletedAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 60_000) });
  const tombstoned = await context.app.inject({ method: "POST", url: "/v1/public/recovery-codes/consume", headers: { "x-firebase-appcheck": TEST_APP_CHECK_TOKEN }, payload: { code: secondRecoveryCode } });
  assert.equal(tombstoned.statusCode, 401);
  assert.deepEqual(tombstoned.json(), { error: { code: "recovery_code_invalid" } });
  await tombstoneRef.delete();
  assert.equal((await firestore().collection(COLLECTIONS.recoveryCodeIndex).doc(createHash("sha256").update(secondRecoveryCode, "utf8").digest("hex")).get()).data()?.usedAt, null);

  const previousSet = await context.app.inject({ method: "POST", url: "/v1/public/recovery-codes/consume", headers: { "x-firebase-appcheck": TEST_APP_CHECK_TOKEN }, payload: { code: firstRecoveryCode } });
  assert.equal(previousSet.statusCode, 401);
  assert.deepEqual(previousSet.json(), { error: { code: "recovery_code_invalid" } });

  const consumed = await context.app.inject({ method: "POST", url: "/v1/public/recovery-codes/consume", headers: { "x-firebase-appcheck": TEST_APP_CHECK_TOKEN }, payload: { code: secondRecoveryCode } });
  assert.equal(consumed.statusCode, 200);
  assert.equal(consumed.json().customToken, "fixture-custom-token");
  assert.equal(context.customTokenSubjects.length, tokensBeforeRecovery + 1);
  assert.equal(context.customTokenSubjects.at(-1), auth.localId);
  assert.deepEqual(context.customTokenClaims.at(-1), { authorizationGeneration: 1 });
  assert.equal(context.revokedSubjects.includes(auth.localId), true);
  const replay = await context.app.inject({ method: "POST", url: "/v1/public/recovery-codes/consume", headers: { "x-firebase-appcheck": TEST_APP_CHECK_TOKEN }, payload: { code: secondRecoveryCode } });
  assert.equal(replay.statusCode, 409);
  assert.deepEqual(replay.json(), { error: { code: "recovery_code_used" } });
});

test("destructive deletion rejects an old authenticated session before touching Firestore", async () => {
  const auth = await createRegisteredAuthUser(context);
  const staleApp = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: { verify: async () => ({ provider: "firebase", subject: auth.localId, email: auth.email, emailVerified: true, authTime: Math.floor(Date.now() / 1000) - 301, authorizationGeneration: 1 }) },
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: context.stores,
  });
  const response = await staleApp.inject({ method: "POST", url: "/v1/account/deletion", headers: { authorization: "Bearer stale-but-otherwise-valid", "x-firebase-appcheck": TEST_APP_CHECK_TOKEN }, payload: { operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } });
  await staleApp.close();
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: { code: "recent_reauthentication_required" } });
  assert.equal((await firestore().collection("accountDeletionOperations").get()).size, 0);
});

test("recovery-code issue rejects a generation rotated after the request guard without changing the issued set", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const initial = await context.app.inject({ method: "POST", url: "/v1/account/recovery-codes", headers, payload: {} });
  assert.equal(initial.statusCode, 200);

  const userRef = firestore().collection(COLLECTIONS.users).doc(auth.userId);
  const metadataRef = userRef.collection("security").doc("recoveryCodes");
  const index = firestore().collection(COLLECTIONS.recoveryCodeIndex);
  const indexBefore = await index.where("userId", "==", auth.userId).get();
  const metadataBefore = await metadataRef.get();
  assert.equal(indexBefore.size, 10);
  assert.equal(metadataBefore.exists, true);
  const priorGenerationId = metadataBefore.data()?.generationId;

  const originalLifecycle = context.stores.accountLifecycle;
  let rotatedAfterGuard = false;
  const accountLifecycle = new Proxy(originalLifecycle, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "issueRecoveryCodes" && typeof value === "function") {
        return async (...args: unknown[]) => {
          if (!rotatedAfterGuard) {
            rotatedAfterGuard = true;
            await userRef.update({ authorizationGeneration: 2 });
          }
          return value.apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const raceApp = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, accountLifecycle },
  });

  const rejected = await raceApp.inject({ method: "POST", url: "/v1/account/recovery-codes", headers, payload: {} });
  await raceApp.close();
  assert.equal(rotatedAfterGuard, true);
  assert.equal(rejected.statusCode, 409);
  assert.deepEqual(rejected.json(), { error: { code: "authorization_generation_conflict" } });

  const indexAfter = await index.where("userId", "==", auth.userId).get();
  const metadataAfter = await metadataRef.get();
  assert.equal(indexAfter.size, indexBefore.size);
  assert.deepEqual(indexAfter.docs.map((document) => document.id).sort(), indexBefore.docs.map((document) => document.id).sort());
  assert.ok(indexAfter.docs.every((document) => document.data().generationId === priorGenerationId));
  assert.equal(metadataAfter.data()?.generationId, priorGenerationId);
  assert.equal(metadataAfter.data()?.count, 10);

  const inactiveAuth = await createRegisteredAuthUser(context);
  const inactiveUserRef = firestore().collection(COLLECTIONS.users).doc(inactiveAuth.userId);
  const inactiveLifecycle = new Proxy(originalLifecycle, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "issueRecoveryCodes" && typeof value === "function") {
        return async (...args: unknown[]) => {
          await inactiveUserRef.update({ authorizationState: "deleting" });
          return value.apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const inactiveApp = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, accountLifecycle: inactiveLifecycle },
  });
  const inactive = await inactiveApp.inject({
    method: "POST", url: "/v1/account/recovery-codes",
    headers: { authorization: `Bearer ${inactiveAuth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN }, payload: {},
  });
  await inactiveApp.close();
  assert.equal(inactive.statusCode, 401);
  assert.deepEqual(inactive.json(), { error: { code: "account_deleted" } });
  assert.equal((await index.where("userId", "==", inactiveAuth.userId).get()).size, 0);
  assert.equal((await inactiveUserRef.collection("security").doc("recoveryCodes").get()).exists, false);
});

test("account deletion removes owned Firestore documents, preserves a tombstone, and redacts report account contact fields", async () => {
  const auth = await createRegisteredAuthUser(context);
  const me = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  const userId = me.json().user.id as string;
  const state = { value: true };
  const mutation = { mutationId: `mutation-${Date.now()}-delete`, kind: "item" as const, recordType: "training_attempt" as const, trackId: "coding-interview-dsa-problem-solving", targetId: "delete-item", expectedVersion: null, state, fingerprint: createMergeRecordFingerprint({ recordId: "delete-item", recordType: "training_attempt", state, trackId: "coding-interview-dsa-problem-solving" }) };
  await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers: { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN }, payload: canonicalSyncPayload(0, [mutation], "deletion-batch") });
  const linked = createContentReportSchema.parse({ ...reportBody("9f61e3f3-f23e-467c-b92a-9b8fd0514f25"), linkAccount: true, contactEmail: "learner@example.com" });
  await context.stores.contentReports.create(userId, 1, linked, { rateLimitKey: "account-test-client" });
  const exportAuditTimestamp = Timestamp.now();
  await firestore().collection(COLLECTIONS.accountDataExportAudits).doc("deletion-export-audit").set({ exportId: "deletion-export-audit", userId, createdAt: exportAuditTimestamp, status: "completed", schemaVersion: "account-data-export-v1", scope: [], expiresAt: Timestamp.fromMillis(exportAuditTimestamp.toMillis() + 30 * 86_400_000) });
  await firestore().collection(COLLECTIONS.accountDataExportRateLimits).doc(userId).set({ windowStartedAt: exportAuditTimestamp, count: 1, updatedAt: exportAuditTimestamp, expiresAt: Timestamp.fromMillis(exportAuditTimestamp.toMillis() + 3_600_000) });
  const deleted = await context.app.inject({ method: "POST", url: "/v1/account/deletion", headers: { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN }, payload: { operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operationSecret: "a".repeat(64) } });
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json().status, "deleted");
  assert.equal(context.revokedSubjects.includes(auth.localId), true);
  assert.equal(context.deletedSubjects.includes(auth.localId), true);
  const proof = await context.app.inject({ method: "GET", url: `/v1/public/deletion-proofs/${deleted.json().proofId}`, headers: { "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  assert.equal(proof.statusCode, 200);
  assert.equal((await firestore().collection("users").doc(userId).get()).exists, false);
  assert.equal((await firestore().collection("users").doc(userId).collection("progress").get()).size, 0);
  assert.equal((await firestore().collection("identityMappings").where("userId", "==", userId).get()).size, 0);
  assert.equal((await firestore().collection(COLLECTIONS.accountDataExportAudits).where("userId", "==", userId).get()).size, 0);
  assert.equal((await firestore().collection(COLLECTIONS.accountDataExportRateLimits).doc(userId).get()).exists, false);
  const tombstoneId = parsePseudonymKeyRing(testEnvironment.deletionPseudonymKeysJson).active("firebase", auth.localId).documentId;
  const tombstone = (await firestore().collection("deletedIdentities").doc(tombstoneId).get()).data();
  assert.ok(tombstone?.deletedAt instanceof Timestamp);
  assert.ok(tombstone?.expiresAt instanceof Timestamp);
  assert.equal(tombstone.expiresAt.toMillis() - tombstone.deletedAt.toMillis(), 45 * 24 * 60 * 60 * 1_000);
  assert.equal("subject" in (tombstone ?? {}), false);
  const report = (await firestore().collection("contentReports").doc(linked.clientSubmissionId).get()).data();
  assert.ok(report);
  assert.equal("accountId" in report, false);
  assert.equal("contactEmail" in report, false);
  assert.equal(report.description, linked.description);
  assert.deepEqual(report.context, linked.context);
  const operation = (await firestore().collection("accountDeletionOperations").doc(deleted.json().operationId).get()).data();
  const deletionProof = (await firestore().collection("deletionProofs").doc(deleted.json().proofId).get()).data();
  assert.ok(operation?.completedAt instanceof Timestamp);
  assert.ok(operation?.expiresAt instanceof Timestamp);
  assert.equal(operation.expiresAt.toMillis() - operation.completedAt.toMillis(), 3 * 365 * 24 * 60 * 60 * 1_000);
  assert.equal(deletionProof?.expiresAt.toMillis(), operation.expiresAt.toMillis());
  const oldTokenResponse = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  assert.equal(oldTokenResponse.statusCode, 401);
});

test("account deletion persists subjects and phases, resumes through the bound status route, and accepts Auth user-not-found", async () => {
  const auth = await createRegisteredAuthUser(context);
  const me = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  const userId = me.json().user.id as string;
  const linked = createContentReportSchema.parse({ ...reportBody("af61e3f3-f23e-467c-b92a-9b8fd0514f25"), linkAccount: true, contactEmail: "resume@example.com" });
  await context.stores.contentReports.create(userId, 1, linked, { rateLimitKey: "resume-deletion-client" });
  await firestore().collection("recoveryCodeIndex").doc("resume-recovery-code").set({ userId, usedAt: null });
  await firestore().collection("sessionRevocationOperations").doc("resume-session-revocation").set({ userId, status: "revoked" });
  await firestore().collection("users").doc(userId).collection("drafts").doc("resume-draft").set({ value: "private" });

  let failAuthDeletion = true;
  let deleteAttempts = 0;
  const lifecycle = new FirestoreAccountLifecycleStore(firestore(), {
    createCustomToken: async () => "unused-custom-token",
    revokeRefreshTokens: async () => undefined,
    deleteUser: async (subject) => {
      deleteAttempts += 1;
      if (failAuthDeletion) throw new Error("fixture_auth_delete_failed");
      await getAuth().deleteUser(subject);
    },
  }, parsePseudonymKeyRing(testEnvironment.deletionPseudonymKeysJson));
  const operationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await assert.rejects(lifecycle.deleteAccount(userId, operationId, "a".repeat(64)), { message: "remote_deletion_pending" });
  assert.equal(deleteAttempts, 1);
  const pendingOperation = await firestore().collection("accountDeletionOperations").doc(operationId).get();
  assert.equal(pendingOperation.data()?.phase, "auth_deleting");
  assert.equal("authSubjects" in (pendingOperation.data() ?? {}), false);
  assert.equal("subjectHashes" in (pendingOperation.data() ?? {}), false);
  assert.equal((await firestore().collection("recoveryCodeIndex").where("userId", "==", userId).get()).size, 1);
  assert.equal((await firestore().collection("sessionRevocationOperations").where("userId", "==", userId).get()).size, 1);
  assert.equal((await firestore().collection("users").doc(userId).collection("drafts").get()).size, 1);
  const report = (await firestore().collection("contentReports").doc(linked.clientSubmissionId).get()).data();
  assert.ok(report);
  assert.equal(report.accountId, userId);
  assert.equal(report.contactEmail, linked.contactEmail);
  assert.equal(report.description, linked.description);
  assert.deepEqual(report.context, linked.context);
  assert.equal((await firestore().collection("deletionProofs").get()).size, 0);

  const resumeApp = buildApplication({ environment: testEnvironment, firestore: null, verifier: null, appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } }, stores: { ...context.stores, accountLifecycle: lifecycle } });
  try {
    const operationSecret = "a".repeat(64);
    const wrongBinding = await resumeApp.inject({ method: "POST", url: "/v1/public/deletion-operations/status", headers: { "x-firebase-appcheck": TEST_APP_CHECK_TOKEN }, payload: { operationId, operationSecret: "d".repeat(64) } });
    assert.equal(wrongBinding.statusCode, 404);
    assert.equal(deleteAttempts, 1);

    await getAuth().deleteUser(auth.localId);
    failAuthDeletion = false;
    const resumed = await resumeApp.inject({ method: "POST", url: "/v1/public/deletion-operations/status", headers: { "x-firebase-appcheck": TEST_APP_CHECK_TOKEN }, payload: { operationId, operationSecret } });
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumed.json().status, "complete");
    assert.equal(deleteAttempts, 2);
    const completedOperation = (await firestore().collection("accountDeletionOperations").doc(operationId).get()).data();
    assert.equal(completedOperation?.phase, "complete");
    assert.equal("authSubjects" in (completedOperation ?? {}), false);
    assert.equal("userId" in (completedOperation ?? {}), false);
    assert.equal("identityRefs" in (completedOperation ?? {}), false);
    const completedReport = (await firestore().collection("contentReports").doc(linked.clientSubmissionId).get()).data();
    assert.ok(completedReport);
    assert.equal("accountId" in completedReport, false);
    assert.equal("contactEmail" in completedReport, false);
    const pseudonym = parsePseudonymKeyRing(testEnvironment.deletionPseudonymKeysJson).active("firebase", auth.localId);
    const completedTombstone = (await firestore().collection("deletedIdentities").doc(pseudonym.documentId).get()).data();
    assert.ok(completedTombstone);
    assert.equal("subject" in completedTombstone, false);
    assert.equal((await firestore().collection("deletionProofs").doc(resumed.json().proofId).get()).data()?.status, "deleted");
    await assert.rejects(getAuth().getUser(auth.localId), (error: unknown) => {
      const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
      return code === "auth/user-not-found";
    });
  } finally {
    await resumeApp.close();
  }
});

test("simultaneous deletion operation IDs each complete with their own proof", async () => {
  const auth = await createRegisteredAuthUser(context);
  const me = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  const userId = me.json().user.id as string;
  const firstOperationId = "11111111-1111-4111-8111-111111111111";
  const secondOperationId = "22222222-2222-4222-8222-222222222222";
  const lifecycle = context.stores.accountLifecycle;
  const [first, second] = await Promise.all([
    lifecycle.deleteAccount(userId, firstOperationId, "a".repeat(64)),
    lifecycle.deleteAccount(userId, secondOperationId, "b".repeat(64)),
  ]);
  assert.equal(first.status, "remote_deleted");
  assert.equal(second.status, "remote_deleted");
  assert.notEqual(first.proofId, second.proofId);
  const firstCompleted = await lifecycle.completeDeletion(first.operationId, first.proofId);
  const secondCompleted = await lifecycle.completeDeletion(second.operationId, second.proofId);
  assert.deepEqual(firstCompleted, { status: "deleted", operationId: firstOperationId, proofId: first.proofId });
  assert.deepEqual(secondCompleted, { status: "deleted", operationId: secondOperationId, proofId: second.proofId });
  for (const operation of [first, second]) {
    const stored = (await firestore().collection("accountDeletionOperations").doc(operation.operationId).get()).data();
    assert.equal(stored?.phase, "complete");
    assert.equal("authSubjects" in (stored ?? {}), false);
    assert.equal((await firestore().collection("deletionProofs").doc(operation.proofId).get()).data()?.operationId, operation.operationId);
  }
  const pseudonym = parsePseudonymKeyRing(testEnvironment.deletionPseudonymKeysJson).active("firebase", auth.localId);
  const tombstone = (await firestore().collection("deletedIdentities").doc(pseudonym.documentId).get()).data();
  assert.ok(tombstone);
  assert.equal(tombstone?.provider, "firebase");
  assert.equal(tombstone?.subjectHmac, pseudonym.subjectHmac);
  assert.equal(tombstone?.keyVersion, pseudonym.keyVersion);
  assert.ok(tombstone?.expiresAt);
  assert.equal("subject" in tombstone, false);
  assert.equal("operationId" in tombstone, false);
  assert.equal("proofId" in tombstone, false);
});

test("a redacted tombstone is never repopulated by a later operation", async () => {
  const auth = await createRegisteredAuthUser(context);
  const me = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  const userId = me.json().user.id as string;
  const operationId = "33333333-3333-4333-8333-333333333333";
  const proofId = "proof_redacted_tombstone_fixture_123456";
  const pseudonym = parsePseudonymKeyRing(testEnvironment.deletionPseudonymKeysJson).active("firebase", auth.localId);
  const identityId = pseudonym.documentId;
  const timestamp = Timestamp.now();
  await firestore().collection("accountDeletionOperations").doc(operationId).set({
    operationId,
    userId,
    status: "remote_deleting",
    phase: "firestore_deleting",
    proofId,
    operationSecretHash: createHash("sha256").update("a".repeat(64), "utf8").digest("hex"),
    identityRefs: [{ identityId, provider: "firebase", keyVersion: pseudonym.keyVersion, subjectHmac: pseudonym.subjectHmac }],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await firestore().collection("deletedIdentities").doc(identityId).set({ provider: "firebase", keyVersion: pseudonym.keyVersion, subjectHmac: pseudonym.subjectHmac, deletedAt: timestamp, expiresAt: Timestamp.fromMillis(timestamp.toMillis() + 45 * 24 * 60 * 60 * 1000) });
  const result = await context.stores.accountLifecycle.deleteAccount(userId, operationId, "a".repeat(64));
  assert.equal(result.status, "remote_deleted");
  await context.stores.accountLifecycle.completeDeletion(result.operationId, result.proofId);
  const tombstone = (await firestore().collection("deletedIdentities").doc(identityId).get()).data();
  assert.ok(tombstone);
  assert.equal("subject" in tombstone, false);
  assert.equal(tombstone?.provider, "firebase");
  assert.equal(tombstone?.subjectHmac, pseudonym.subjectHmac);
});

test("legacy terminal records without phase and auth deletion marker never report proof", async () => {
  const auth = await createRegisteredAuthUser(context);
  const me = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  const userId = me.json().user.id as string;
  const operationId = "55555555-5555-4555-8555-555555555555";
  const proofId = "proof_legacy_terminal_fixture_123456";
  const subjectHash = createHash("sha256").update(auth.localId, "utf8").digest("hex");
  await firestore().collection("accountDeletionOperations").doc(operationId).set({ operationId, userId, status: "complete", proofId, subjectHashes: [subjectHash] });
  await firestore().collection("deletionProofs").doc(proofId).set({ status: "deleted", operationId, proofId, completedAt: Timestamp.now() });
  assert.equal(await context.stores.accountLifecycle.readDeletionProof(proofId), null);
  assert.equal(await context.stores.accountLifecycle.readDeletionOperationStatus(operationId, subjectHash), null);
  assert.equal(await context.stores.accountLifecycle.resumeDeletion(operationId, subjectHash), null);
  await assert.rejects(context.stores.accountLifecycle.deleteAccount(userId, operationId, "a".repeat(64)), { message: "remote_deletion_pending" });
  await firestore().collection("accountDeletionOperations").doc(operationId).update({ phase: "complete", authDeletedAt: Timestamp.now() });
  assert.equal(await context.stores.accountLifecycle.readDeletionProof(proofId), null);
  assert.equal(await context.stores.accountLifecycle.readDeletionOperationStatus(operationId, subjectHash), null);
  await assert.rejects(context.stores.accountLifecycle.completeDeletion(operationId, proofId), { message: "remote_deletion_pending" });
});

test("expired deletion proofs fail closed and are purged", async () => {
  const operationId = "66666666-6666-4666-8666-666666666666";
  const proofId = "proof_expired_fixture_123456";
  const timestamp = Timestamp.now();
  await firestore().collection("accountDeletionOperations").doc(operationId).set({ operationId, status: "complete", phase: "complete", proofId, operationSecretHash: "a".repeat(64), authDeletedAt: timestamp, completedAt: timestamp });
  await firestore().collection("deletionProofs").doc(proofId).set({ status: "deleted", operationId, proofId, completedAt: timestamp, expiresAt: Timestamp.fromMillis(Date.now() - 1) });
  assert.equal(await context.stores.accountLifecycle.readDeletionProof(proofId), null);
  assert.equal((await firestore().collection("deletionProofs").doc(proofId).get()).exists, false);
});

test("a verify-only predecessor key completes an Auth-deleted operation after rotation", async () => {
  const auth = await createRegisteredAuthUser(context);
  const me = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  const userId = me.json().user.id as string;
  const operationId = "88888888-8888-4888-8888-888888888888";
  const secret = "c".repeat(64);
  const v1 = Buffer.alloc(32, 11).toString("base64");
  const v2 = Buffer.alloc(32, 12).toString("base64");
  const ringV1 = parsePseudonymKeyRing(JSON.stringify([{ version: "v1", status: "active", keyBase64: v1 }]));
  const first = new FirestoreAccountLifecycleStore(firestore(), { createCustomToken: async () => "unused", revokeRefreshTokens: async () => undefined, deleteUser: async () => { throw new Error("fixture_auth_delete_failed"); } }, ringV1);
  await assert.rejects(first.deleteAccount(userId, operationId, secret), { message: "remote_deletion_pending" });
  await getAuth().deleteUser(auth.localId);
  const ringV2 = parsePseudonymKeyRing(JSON.stringify([{ version: "v2", status: "active", keyBase64: v2 }, { version: "v1", status: "verify_only", keyBase64: v1 }]));
  const rotated = new FirestoreAccountLifecycleStore(firestore(), { createCustomToken: async () => "unused", revokeRefreshTokens: async () => undefined, deleteUser: async () => undefined }, ringV2);
  const result = await rotated.deleteAccount(userId, operationId, secret);
  await rotated.completeDeletion(result.operationId, result.proofId);
  const original = ringV1.active("firebase", auth.localId);
  assert.equal((await firestore().collection("deletedIdentities").doc(original.documentId).get()).exists, true);
});

test("account-owned writers reject a tombstoned or missing user after authentication", async () => {
  const auth = await createRegisteredAuthUser(context);
  const me = await context.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  const userId = me.json().user.id as string;
  const userRef = firestore().collection("users").doc(userId);
  const snapshot = { guestSnapshotVersion: 1, guestUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", records: [], activeSession: false, pendingJournal: false };
  const preview = await context.stores.progress.previewAdoption(userId, snapshot);
  const confirmation = { operationId: preview.preview.operationId, previewFingerprint: preview.preview.fingerprint, resolutions: [], groupChoices: [] };
  for (const state of ["tombstoned", "missing"]) {
    if (state === "tombstoned") await userRef.update({ deletedAt: Timestamp.now() });
    else await userRef.delete();
    await assert.rejects(context.stores.progress.applyBatch(userId, 1, "fixture-device", 0, [], { sessionId: "fixture-session", batchId: `fixture-${state}`, highWatermark: 0 }), { message: "account_deleted" });
    await assert.rejects(context.stores.progress.confirmAdoption(userId, 1, "fixture-device", snapshot, confirmation), { message: "account_deleted" });
    await assert.rejects(context.stores.devices.touch(userId, { deviceKey: "fixture-device", platform: "ios", appVersion: "test" }), { message: "account_deleted" });
    await assert.rejects(context.stores.contentReports.create(userId, 1, { ...reportBody("88888888-8888-4888-8888-888888888888"), linkAccount: true, contactEmail: "fixture@example.invalid" }, { rateLimitKey: "late-write" }), { message: "account_deleted" });
    await assert.rejects(context.stores.accountLifecycle.revokeSessions(userId, `late-revoke-${state}`), { message: "account_deleted" });
  }
  assert.deepEqual((await userRef.listCollections()).map((collection) => collection.id), ["legalAcceptances"]);
  assert.equal((await firestore().collection("contentReports").get()).size, 0);
  assert.equal((await firestore().collection("sessionRevocationOperations").get()).size, 0);
});
