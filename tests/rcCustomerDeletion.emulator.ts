import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { resolve } from "node:path";
import test, { after, before, describe } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { validateIsolatedEmulatorRuntime } from "../scripts/isolated-emulator-test-runner.mjs";
import { COLLECTIONS } from "../src/infrastructure/firestore/paths.js";
import { createFirebaseAdminAuth } from "../src/infrastructure/firebase/adminAuth.js";
import { PseudonymKeyRing } from "../src/infrastructure/security/pseudonymKeyRing.js";
import { FirestoreAccountLifecycleStore } from "../src/modules/account-lifecycle/store.js";

const ENABLED = process.env.RC_CUSTOMER_DELETION_EMULATOR_TESTS === "1";
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? "";
const TEST_GROUP = ENABLED ? describe : describe.skip;
const REVENUECAT_PROJECT_ID = "projPatternlyAcceptance";
const FIXTURE_COLLECTION = "rcCustomerDeletionFixtures";
const testKey = () => randomBytes(32).toString("base64");

let app: ReturnType<typeof initializeApp>;
let db: ReturnType<typeof getFirestore>;
let adminAuth: ReturnType<typeof getAuth>;
let accountAuth: ReturnType<typeof createFirebaseAdminAuth>;
const owned = { users: [] as string[], uids: [] as string[], operations: [] as string[], proofs: [] as string[], identities: [] as string[], fixtures: [] as string[] };

function requireIsolatedEmulator(): void {
  if (!/^demo-patternly-rc-customer-deletion$/u.test(PROJECT_ID)) throw new Error("rc_delete_demo_project_required");
  validateIsolatedEmulatorRuntime(process.env, PROJECT_ID);
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GCLOUD_PROJECT !== PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT !== PROJECT_ID) throw new Error("rc_delete_emulator_only_environment_required");
}

async function makeAccount(): Promise<Readonly<{ userId: string; firebaseUid: string; operationId: string; secret: string; ring: PseudonymKeyRing; ringKeyBase64: string; identityId: string }>> {
  const userId = randomUUID();
  const firebaseUid = `rc-delete-${randomUUID()}`;
  const operationId = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const ringKeyBase64 = testKey();
  const ring = new PseudonymKeyRing([{ version: "rc_test_v1", status: "active", keyBase64: ringKeyBase64 }]);
  const pseudonym = ring.active("firebase", firebaseUid);
  await adminAuth.createUser({ uid: firebaseUid, disabled: false });
  await db.collection(COLLECTIONS.users).doc(userId).set({ authorizationGeneration: 1, authorizationState: "active", privateProfile: { retainedUntilDeletion: true } });
  await db.collection(COLLECTIONS.identityMappings).doc(pseudonym.documentId).set({
    keyVersion: pseudonym.keyVersion, provider: "firebase", subject: firebaseUid, subjectHmac: pseudonym.subjectHmac, userId,
  });
  owned.users.push(userId);
  owned.uids.push(firebaseUid);
  owned.operations.push(operationId);
  owned.identities.push(pseudonym.documentId);
  return Object.freeze({ userId, firebaseUid, operationId, secret, ring, ringKeyBase64, identityId: pseudonym.documentId });
}

function makeStore(fixture: Awaited<ReturnType<typeof makeAccount>>, client: { readonly projectId: string; deleteCustomer(appUserId: string): Promise<{ status: "accepted" | "absent" }> } | null, projectId = REVENUECAT_PROJECT_ID) {
  return new FirestoreAccountLifecycleStore(db, accountAuth, fixture.ring, { projectId, client });
}

async function cleanup(): Promise<void> {
  for (const operationId of owned.operations) {
    await db.collection(COLLECTIONS.accountDeletionOperations).doc(operationId).delete().catch(() => undefined);
    await db.collection(COLLECTIONS.sessionRevocationOperations).doc(operationId).delete().catch(() => undefined);
  }
  for (const proofId of owned.proofs) await db.collection(COLLECTIONS.deletionProofs).doc(proofId).delete().catch(() => undefined);
  for (const userId of owned.users) {
    await db.collection(COLLECTIONS.users).doc(userId).delete().catch(() => undefined);
    const mappings = await db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId).get();
    for (const mapping of mappings.docs) await mapping.ref.delete().catch(() => undefined);
  }
  for (const identityId of owned.identities) {
    await db.collection(COLLECTIONS.identityMappings).doc(identityId).delete().catch(() => undefined);
    await db.collection(COLLECTIONS.deletedIdentities).doc(identityId).delete().catch(() => undefined);
  }
  for (const uid of owned.uids) await adminAuth.deleteUser(uid).catch(() => undefined);
  for (const fixtureId of owned.fixtures) await db.collection(FIXTURE_COLLECTION).doc(fixtureId).delete().catch(() => undefined);
  owned.users = []; owned.uids = []; owned.operations = []; owned.proofs = []; owned.identities = []; owned.fixtures = [];
}

before(() => {
  if (!ENABLED) return;
  requireIsolatedEmulator();
  app = initializeApp({ projectId: PROJECT_ID }, `rc-customer-deletion-${process.pid}`);
  db = getFirestore(app);
  adminAuth = getAuth(app);
  accountAuth = createFirebaseAdminAuth(app);
});

after(async () => {
  if (!ENABLED || !app) return;
  await cleanup();
  await deleteApp(app);
});

TEST_GROUP("RC-DELETE-01 RevenueCat customer deletion isolated emulator tests", () => {
  test("uses the backend AppUserID and bound project, then leaves only a minimal terminal receipt", async () => {
    const fixture = await makeAccount();
    let calls: string[] = [];
    const client = { projectId: REVENUECAT_PROJECT_ID, deleteCustomer: async (id: string) => { calls.push(id); return { status: "accepted" as const }; } };
    const store = makeStore(fixture, client);
    const pending = await store.deleteAccount(fixture.userId, 1, fixture.operationId, fixture.secret);
    owned.proofs.push(pending.proofId);
    assert.equal(pending.status, "remote_deleted");
    assert.deepEqual(calls, [fixture.userId]);
    assert.notEqual(calls[0], fixture.firebaseUid);
    const operationRef = db.collection(COLLECTIONS.accountDeletionOperations).doc(fixture.operationId);
    const checkpoint = (await operationRef.get()).get("revenueCatDeletion");
    assert.deepEqual(checkpoint, { projectId: REVENUECAT_PROJECT_ID, status: "accepted" });
    assert.equal((await store.completeDeletion(fixture.operationId, pending.proofId)).status, "deleted");
    assert.equal((await db.collection(COLLECTIONS.users).doc(fixture.userId).get()).exists, false);
    const terminal = (await operationRef.get()).data()!;
    assert.deepEqual(terminal.revenueCatDeletion, { projectId: REVENUECAT_PROJECT_ID, status: "accepted" });
    for (const key of ["userId", "identityRefs", "authSubjects", "subjectHashes", "customer", "subscriber", "payload", "appUserId"]) assert.equal(terminal[key], undefined, `terminal receipt must omit ${key}`);
    assert.equal(calls.length, 1);
    await store.resumeDeletion(fixture.operationId, fixture.secret);
    assert.equal(calls.length, 1, "completed retry must not call the provider again");
  });

  test("missing key leaves own account pending after Auth deletion; same secret and project resume successfully", async () => {
    const fixture = await makeAccount();
    const unconfigured = makeStore(fixture, null);
    await assert.rejects(unconfigured.deleteAccount(fixture.userId, 1, fixture.operationId, fixture.secret), { message: "remote_deletion_pending" });
    const operationRef = db.collection(COLLECTIONS.accountDeletionOperations).doc(fixture.operationId);
    let operation = (await operationRef.get()).data()!;
    assert.equal(operation.phase, "revenuecat_deleting");
    assert.deepEqual(operation.revenueCatDeletion, { projectId: REVENUECAT_PROJECT_ID, status: "pending" });
    assert.equal(operation.failureCode, "revenuecat_deletion_configuration");
    const ownUserAfterAuth = await db.collection(COLLECTIONS.users).doc(fixture.userId).get();
    assert.equal(ownUserAfterAuth.exists, true);
    assert.equal(ownUserAfterAuth.get("authorizationState"), "deleting");
    assert.equal(ownUserAfterAuth.get("securityOperation.kind"), "account_delete");
    assert.equal((await db.collection(COLLECTIONS.identityMappings).doc(fixture.identityId).get()).exists, true);
    await assert.rejects(adminAuth.getUser(fixture.firebaseUid), (error: unknown) => (error as { code?: string }).code === "auth/user-not-found");
    let calls = 0;
    const resumed = makeStore(fixture, { projectId: REVENUECAT_PROJECT_ID, deleteCustomer: async (id) => { calls++; assert.equal(id, fixture.userId); return { status: "absent" }; } });
    assert.equal(await resumed.resumeDeletion(fixture.operationId, "f".repeat(64)), null);
    assert.equal((await db.collection(COLLECTIONS.users).doc(fixture.userId).get()).exists, true, "wrong secret must not advance the operation");
    const result = await resumed.resumeDeletion(fixture.operationId, fixture.secret);
    assert.equal(result?.status, "complete");
    owned.proofs.push(result!.proofId!);
    assert.equal(calls, 1);
    operation = (await operationRef.get()).data()!;
    assert.deepEqual(operation.revenueCatDeletion, { projectId: REVENUECAT_PROJECT_ID, status: "absent" });
    assert.equal(operation.userId, undefined);
    assert.equal((await db.collection(COLLECTIONS.users).doc(fixture.userId).get()).exists, false);
  });

  test("provider errors before and after a modeled effect preserve account data until a receipt is persisted", async () => {
    for (const afterEffect of [false, true]) {
      const fixture = await makeAccount();
      const markerId = randomUUID();
      owned.fixtures.push(markerId);
      let calls: string[] = [];
      const failing = makeStore(fixture, { projectId: REVENUECAT_PROJECT_ID, deleteCustomer: async (id) => {
        calls.push(id);
        if (afterEffect) await db.collection(FIXTURE_COLLECTION).doc(markerId).set({ appUserId: id, effect: "accepted-by-fake" });
        throw new Error("fixture_provider_failure");
      } });
      await assert.rejects(failing.deleteAccount(fixture.userId, 1, fixture.operationId, fixture.secret), { message: "remote_deletion_pending" });
      const operationRef = db.collection(COLLECTIONS.accountDeletionOperations).doc(fixture.operationId);
      const operation = (await operationRef.get()).data()!;
      assert.equal(operation.phase, "revenuecat_deleting");
      assert.deepEqual(operation.revenueCatDeletion, { projectId: REVENUECAT_PROJECT_ID, status: "pending" });
      assert.equal(operation.userId, fixture.userId);
      const ownUserAfterError = await db.collection(COLLECTIONS.users).doc(fixture.userId).get();
      assert.equal(ownUserAfterError.exists, true);
      assert.equal(ownUserAfterError.get("authorizationState"), "deleting");
      assert.equal(ownUserAfterError.get("securityOperation.kind"), "account_delete");
      assert.equal((await db.collection(COLLECTIONS.identityMappings).doc(fixture.identityId).get()).exists, true);
      assert.equal((await db.collection(FIXTURE_COLLECTION).doc(markerId).get()).exists, afterEffect);
      const resumed = makeStore(fixture, { projectId: REVENUECAT_PROJECT_ID, deleteCustomer: async (id) => { calls.push(id); return { status: "accepted" }; } });
      const result = await resumed.resumeDeletion(fixture.operationId, fixture.secret);
      assert.equal(result?.status, "complete");
      owned.proofs.push(result!.proofId!);
      assert.ok(calls.every((id) => id === fixture.userId));
    }
  });

  test("a killed process after the fake provider effect resumes with the same ID and secret", async () => {
    const fixture = await makeAccount();
    const markerId = randomUUID();
    owned.fixtures.push(markerId);
    const workerPath = resolve(import.meta.dirname, "fixtures", "rcCustomerDeletionCrashWorker.ts");
    const child = fork(workerPath, [fixture.userId, fixture.operationId, fixture.secret, markerId], {
      execArgv: ["--import", "tsx"],
      env: { ...process.env, RC_DELETE_PROJECT_ID: REVENUECAT_PROJECT_ID, RC_DELETE_PSEUDONYM_KEY: fixture.ringKeyBase64 },
      stdio: ["ignore", "inherit", "inherit", "ipc"], serialization: "advanced",
    });
    try {
      await new Promise<void>((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error("rc_delete_crash_worker_timeout")), 30_000);
        child.once("message", (message) => { clearTimeout(timer); if ((message as { type?: string }).type !== "fake_provider_effect_recorded") reject(new Error("rc_delete_crash_worker_unexpected_message")); else resolveReady(); });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`rc_delete_crash_worker_exited_early:${code}`)); });
      });
      child.kill("SIGKILL");
      await new Promise<void>((resolveExit, reject) => {
        child.once("exit", (_code, signal) => signal === "SIGKILL" ? resolveExit() : reject(new Error("rc_delete_crash_worker_not_killed")));
        setTimeout(() => reject(new Error("rc_delete_crash_worker_kill_timeout")), 10_000);
      });
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    const operationRef = db.collection(COLLECTIONS.accountDeletionOperations).doc(fixture.operationId);
    const retryBeforeLeaseExpiry = await makeStore(fixture, { projectId: REVENUECAT_PROJECT_ID, deleteCustomer: async () => { throw new Error("provider_must_not_be_called_before_lease_expiry"); } }).resumeDeletion(fixture.operationId, fixture.secret);
    assert.equal(retryBeforeLeaseExpiry?.status, "pending");
    const expiredLease = Timestamp.fromMillis(Date.now() - 1_000);
    await operationRef.update({ leaseUntil: expiredLease });
    await db.collection(COLLECTIONS.users).doc(fixture.userId).update({ "securityOperation.leaseUntil": expiredLease });
    const interrupted = (await operationRef.get()).data()!;
    assert.equal(interrupted.phase, "revenuecat_deleting");
    assert.deepEqual(interrupted.revenueCatDeletion, { projectId: REVENUECAT_PROJECT_ID, status: "pending" });
    assert.equal((await db.collection(FIXTURE_COLLECTION).doc(markerId).get()).get("appUserId"), fixture.userId);
    assert.equal((await db.collection(COLLECTIONS.users).doc(fixture.userId).get()).exists, true);
    const retryIds: string[] = [];
    const resumed = makeStore(fixture, { projectId: REVENUECAT_PROJECT_ID, deleteCustomer: async (id) => {
      retryIds.push(id);
      assert.equal((await db.collection(FIXTURE_COLLECTION).doc(markerId).get()).get("appUserId"), id);
      return { status: "accepted" };
    } });
    const result = await resumed.resumeDeletion(fixture.operationId, fixture.secret);
    assert.equal(result?.status, "complete");
    owned.proofs.push(result!.proofId!);
    assert.deepEqual(retryIds, [fixture.userId]);
  });

  test("wrong project cannot call another project's client; legacy unbound operation fails closed", async () => {
    const fixture = await makeAccount();
    const foreign = await makeAccount();
    const foreignUserRef = db.collection(COLLECTIONS.users).doc(foreign.userId);
    const foreignBefore = (await foreignUserRef.get()).data();
    let foreignCalls = 0;
    await assert.rejects(makeStore(fixture, null).deleteAccount(fixture.userId, 1, fixture.operationId, fixture.secret), { message: "remote_deletion_pending" });
    await assert.rejects(makeStore(foreign, null).deleteAccount(foreign.userId, 1, fixture.operationId, foreign.secret), { message: "account_deletion_conflict" });
    assert.deepEqual((await foreignUserRef.get()).data(), foreignBefore, "an operation bound to another account cannot be replayed in this account scope");
    await adminAuth.getUser(foreign.firebaseUid);
    assert.equal((await makeStore(fixture, { projectId: "projForeign", deleteCustomer: async () => { foreignCalls++; return { status: "accepted" }; } }).resumeDeletion(fixture.operationId, fixture.secret))?.status, "pending");
    assert.equal(foreignCalls, 0);
    await db.collection(COLLECTIONS.accountDeletionOperations).doc(fixture.operationId).update({ revenueCatDeletion: FieldValue.delete() });
    let legacyCalls = 0;
    const legacyRetry = makeStore(fixture, { projectId: REVENUECAT_PROJECT_ID, deleteCustomer: async () => { legacyCalls++; return { status: "accepted" }; } });
    assert.equal((await legacyRetry.resumeDeletion(fixture.operationId, fixture.secret))?.status, "pending");
    assert.equal(legacyCalls, 0);
    assert.equal((await db.collection(COLLECTIONS.users).doc(fixture.userId).get()).exists, true);
  });
});
