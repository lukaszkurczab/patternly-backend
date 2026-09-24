import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { FieldValue, getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import { createAuthUser, createEmulatorContext, firestore, registerAuthUser, TEST_APP_CHECK_TOKEN, type EmulatorContext } from "./support.js";
import { FirestoreProgressStore } from "../src/modules/progress/store.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { syncRequestSchema, type ProgressMutation } from "../src/modules/progress/contracts.js";

const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const authEmulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (!firestoreEmulatorHost || !authEmulatorHost) throw new Error("firebase_emulator_suite_required");

function isLoopbackEmulatorHost(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(`http://${value}`);
    return value === url.host
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      && Number(url.port) >= 1 && Number(url.port) <= 65535;
  } catch {
    return false;
  }
}

if (!isLoopbackEmulatorHost(firestoreEmulatorHost) || !isLoopbackEmulatorHost(authEmulatorHost)) {
  throw new Error("fixture_requires_local_emulators");
}

const projectId = `demo-patternly-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const trackId = "coding-interview-dsa-problem-solving";
const deviceId = "55d8fab9-1bfc-4e98-90e6-08dbbb73fb43";

function fixtureMutation(recordType: "training_attempt" | "review_queue_entry", targetId: string, state: Readonly<Record<string, unknown>>, ordinal: number): ProgressMutation {
  const base = { recordId: targetId, recordType, trackId, state };
  return {
    mutationId: `fixture-${String(ordinal).padStart(2, "0")}-${randomUUID()}`,
    kind: "item",
    recordType,
    trackId,
    targetId,
    expectedVersion: null,
    state,
    fingerprint: createMergeRecordFingerprint(base),
  };
}

async function attemptAllCleanupSteps(steps: readonly (() => Promise<void>)[]): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try { await step(); } catch (error: unknown) { failures.push(error); }
  }
  return failures;
}

test("fixture cleanup attempts remaining steps after a cleanup failure", async () => {
  const attempted: string[] = [];
  const failures = await attemptAllCleanupSteps([
    async () => { attempted.push("firestore"); throw new Error("injected_firestore_cleanup_failure"); },
    async () => { attempted.push("auth"); },
    async () => { attempted.push("app"); },
  ]);
  assert.deepEqual(attempted, ["firestore", "auth", "app"]);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /injected_firestore_cleanup_failure/u);
});

test("fixture guard rejects a non-loopback Auth emulator host", () => {
  assert.equal(isLoopbackEmulatorHost("firebase.example:9099"), false);
  assert.equal(isLoopbackEmulatorHost("127.0.0.1:19099"), true);
});

test("ordinary progress sync is rejected during a live adoption promotion lease", async () => {
  const context = createEmulatorContext();
  const authUser = await createAuthUser();
  let registered: Awaited<ReturnType<typeof registerAuthUser>> | undefined;
  try {
    registered = await registerAuthUser(context, authUser);
    const userRef = firestore().collection("users").doc(registered.userId);
    const metadataRef = userRef.collection("syncMetadata").doc("account");
    const leaseExpiry = Timestamp.fromMillis(Date.now() + 60_000);
    const headers = { authorization: `Bearer ${registered.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
    const makePayload = (sessionId: string, batchId: string, ordinal: number) => ({
      canonicalVersion: "canonical-json-v1",
      expectedAccountRevision: 0,
      deviceId,
      sessionId,
      batchId,
      highWatermark: ordinal,
      mutations: [fixtureMutation("training_attempt", `lease-attempt-${ordinal}`, { result: "correct" }, ordinal)],
    });

    await metadataRef.set({ accountRevision: 0, adoptionPromotionSessionId: "different-session", adoptionPromotionLeaseExpiresAt: leaseExpiry });
    const otherSession = makePayload(`sync-session-${randomUUID()}`, `lease-batch-other-${randomUUID()}`, 1);
    const blocked = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: otherSession });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.deepEqual(blocked.json(), { error: { code: "progress_generation_conflict" } });
    assert.deepEqual((await context.stores.progress.readSnapshot(registered.userId)).records, []);
    assert.equal((await userRef.collection("syncMutations").get()).size, 0);
    assert.equal((await userRef.collection("syncBatches").get()).size, 0);
    assert.equal((await metadataRef.get()).data()?.accountRevision, 0);

    const sameSession = makePayload("promoting-session", `lease-batch-same-${randomUUID()}`, 2);
    await metadataRef.set({ adoptionPromotionSessionId: sameSession.sessionId, adoptionPromotionLeaseExpiresAt: leaseExpiry }, { merge: true });
    const sameSessionBlocked = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: sameSession });
    assert.equal(sameSessionBlocked.statusCode, 409, sameSessionBlocked.body);
    assert.deepEqual(sameSessionBlocked.json(), { error: { code: "progress_generation_conflict" } });
    assert.deepEqual((await context.stores.progress.readSnapshot(registered.userId)).records, []);
    assert.equal((await userRef.collection("syncMutations").get()).size, 0);
    assert.equal((await userRef.collection("syncBatches").get()).size, 0);
    assert.equal((await metadataRef.get()).data()?.accountRevision, 0);

    await metadataRef.update({ adoptionPromotionSessionId: FieldValue.delete(), adoptionPromotionLeaseExpiresAt: FieldValue.delete() });
    const unleased = makePayload(`sync-session-${randomUUID()}`, `lease-batch-clear-${randomUUID()}`, 3);
    const accepted = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: unleased });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().accountRevision, 1);
    assert.equal((await context.stores.progress.readSnapshot(registered.userId)).records.length, 1);
    assert.equal((await userRef.collection("syncMutations").get()).size, 1);
    assert.equal((await userRef.collection("syncBatches").get()).size, 1);
    assert.equal((await metadataRef.get()).data()?.accountRevision, 1);

    const beforeReplay = {
      progress: (await userRef.collection("progress").get()).docs.map((document) => [document.id, document.data()]),
      mutations: (await userRef.collection("syncMutations").get()).docs.map((document) => [document.id, document.data()]),
      batches: (await userRef.collection("syncBatches").get()).docs.map((document) => [document.id, document.data()]),
    };
    await metadataRef.set({ adoptionPromotionSessionId: "replay-promotion-session", adoptionPromotionLeaseExpiresAt: leaseExpiry }, { merge: true });
    const leaseMetadata = (await metadataRef.get()).data();
    const replayBlocked = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: unleased });
    assert.equal(replayBlocked.statusCode, 409, replayBlocked.body);
    assert.deepEqual(replayBlocked.json(), { error: { code: "progress_generation_conflict" } });
    assert.equal((await metadataRef.get()).data()?.accountRevision, 1);
    assert.deepEqual((await metadataRef.get()).data(), leaseMetadata);
    assert.equal((await context.stores.progress.readSnapshot(registered.userId)).records.length, 1);
    assert.deepEqual({
      progress: (await userRef.collection("progress").get()).docs.map((document) => [document.id, document.data()]),
      mutations: (await userRef.collection("syncMutations").get()).docs.map((document) => [document.id, document.data()]),
      batches: (await userRef.collection("syncBatches").get()).docs.map((document) => [document.id, document.data()]),
    }, { progress: beforeReplay.progress, mutations: beforeReplay.mutations, batches: beforeReplay.batches });

    await metadataRef.update({ adoptionPromotionSessionId: FieldValue.delete(), adoptionPromotionLeaseExpiresAt: FieldValue.delete() });
    const replayAccepted = await context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload: unleased });
    assert.equal(replayAccepted.statusCode, 200, replayAccepted.body);
    assert.equal(replayAccepted.json().accountRevision, 1);
    assert.deepEqual((await context.stores.progress.readSnapshot(registered.userId)).records.length, 1);
    assert.equal((await userRef.collection("syncMutations").get()).size, 1);
    assert.equal((await userRef.collection("syncBatches").get()).size, 1);
    assert.equal((await metadataRef.get()).data()?.accountRevision, 1);
  } finally {
    const cleanup: Array<() => Promise<void>> = [];
    if (registered) {
      cleanup.push(() => firestore().recursiveDelete(firestore().collection("users").doc(registered!.userId)));
    }
    cleanup.push(async () => {
      try { await getAuth().deleteUser(authUser.localId); } catch (error: unknown) {
        const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
        if (code !== "auth/user-not-found" && code !== "user-not-found") throw error;
      }
    });
    cleanup.push(() => context.close());
    const failures = await attemptAllCleanupSteps(cleanup);
    if (failures.length > 0) throw new AggregateError(failures, "adoption_promotion_sync_fixture_cleanup_failed");
  }
});

test("isolated emulator fixture preserves canonical progress across service reinitialization", async () => {
  let fixtureApp: App | undefined;
  let refreshedApp: App | undefined;
  let cleanupApp: App | undefined;
  let auth: Auth | undefined;
  let initialDb: Firestore | undefined;
  let refreshedDb: Firestore | undefined;
  let context: EmulatorContext | undefined;
  let contextClosed = false;
  let initialAppDeleted = false;
  let authUid: string | undefined;

  try {
    fixtureApp = initializeApp({ projectId }, `progress-fixture-${randomUUID()}`);
    auth = getAuth(fixtureApp);
    initialDb = getFirestore(fixtureApp);
    context = createEmulatorContext({ projectId });

    const authUser = await auth.createUser({
      email: `fixture-${randomUUID()}@example.test`,
      displayName: "Synthetic progress fixture",
    });
    authUid = authUser.uid;
    await initialDb.collection("users").doc(authUid).create({ id: authUid, fixture: true });

    const empty = await context.stores.progress.readSnapshot(authUid);
    assert.deepEqual(empty.records, []);
    assert.equal(empty.accountRevision, 0);

    const identity = {
      kind: "resolved" as const,
      ref: { trackId, questionId: "two-sum-001", contentVersion: "2026.09.1", artifactSha256: "a".repeat(64) },
    };
    const mutations = [
      fixtureMutation("training_attempt", "fixture-attempt-001", { result: "correct", identity }, 1),
      fixtureMutation("review_queue_entry", "fixture-review-001", { status: "due", dueAt: "2026-09-25T09:00:00.000Z", identity }, 2),
    ];
    const request = syncRequestSchema.parse({
      canonicalVersion: "canonical-json-v1",
      expectedAccountRevision: 0,
      deviceId,
      sessionId: `fixture-session-${randomUUID()}`,
      batchId: `fixture-batch-${randomUUID()}`,
      highWatermark: 2,
      mutations,
    });
    const applied = await context.stores.progress.applyBatch(authUid, 1, request.deviceId, request.expectedAccountRevision, request.mutations, {
      sessionId: request.sessionId,
      batchId: request.batchId,
      highWatermark: request.highWatermark,
    });
    assert.equal(applied.applied.length, 2);
    assert.equal(applied.accountRevision, 2);
    assert.deepEqual(new Set(applied.applied.map((record) => record.recordType)), new Set(["training_attempt", "review_queue_entry"]));

    await context.close();
    contextClosed = true;
    await deleteApp(fixtureApp);
    initialAppDeleted = true;

    refreshedApp = initializeApp({ projectId }, `progress-fixture-refresh-${randomUUID()}`);
    auth = getAuth(refreshedApp);
    refreshedDb = getFirestore(refreshedApp);
    const reinitializedStore = new FirestoreProgressStore(refreshedDb);
    const firstRead = await reinitializedStore.readSnapshot(authUid);
    const secondRead = await new FirestoreProgressStore(refreshedDb).readSnapshot(authUid);
    assert.equal(firstRead.accountRevision, 2);
    assert.deepEqual(firstRead.records.map((record) => [record.recordType, record.targetId, record.state]).sort(), [
      ["review_queue_entry", "fixture-review-001", { status: "due", dueAt: "2026-09-25T09:00:00.000Z", identity }],
      ["training_attempt", "fixture-attempt-001", { result: "correct", identity }],
    ]);
    assert.deepEqual(secondRead, firstRead);
  } finally {
    const failures: unknown[] = [];
    try {
      cleanupApp = initializeApp({ projectId }, `progress-fixture-cleanup-${randomUUID()}`);
    } catch (error: unknown) {
      failures.push(error);
    }
    let recoveredDb: Firestore | undefined;
    let recoveredAuth: Auth | undefined;
    if (cleanupApp) {
      try { recoveredDb = getFirestore(cleanupApp); } catch (error: unknown) { failures.push(error); }
      try { recoveredAuth = getAuth(cleanupApp); } catch (error: unknown) { failures.push(error); }
    }
    const cleanupDb = recoveredDb ?? refreshedDb ?? (!contextClosed ? initialDb : undefined);
    const cleanupAuth = recoveredAuth ?? auth;
    const steps: Array<() => Promise<void>> = [];
    if (authUid && !cleanupDb) failures.push(new Error("fixture_firestore_cleanup_handle_unavailable"));
    if (authUid && !cleanupAuth) failures.push(new Error("fixture_auth_cleanup_handle_unavailable"));
    if (authUid && cleanupDb) steps.push(() => cleanupDb!.recursiveDelete(cleanupDb!.collection("users").doc(authUid!)));
    if (authUid && cleanupAuth) steps.push(async () => {
      try { await cleanupAuth!.deleteUser(authUid!); } catch (error: unknown) {
        const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
        if (code !== "auth/user-not-found" && code !== "user-not-found") throw error;
      }
    });
    if (context && !contextClosed) steps.push(async () => { await context!.close(); contextClosed = true; });
    if (fixtureApp && !initialAppDeleted) steps.push(async () => { await deleteApp(fixtureApp!); initialAppDeleted = true; });
    if (refreshedDb) steps.push(() => refreshedDb!.terminate());
    if (refreshedApp) steps.push(() => deleteApp(refreshedApp!));
    if (recoveredDb) steps.push(() => recoveredDb!.terminate());
    if (cleanupApp) steps.push(() => deleteApp(cleanupApp!));
    failures.push(...await attemptAllCleanupSteps(steps));
    if (failures.length > 0) throw new AggregateError(failures, "isolated_emulator_fixture_cleanup_failed");
  }
});
