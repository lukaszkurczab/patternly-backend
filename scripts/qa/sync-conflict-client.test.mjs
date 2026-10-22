import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createEmulatorContext, createVerifiedRegisteredAuthUser, TEST_APP_CHECK_TOKEN } from "../../tests/support.ts";
import { OPENAPI_DOCUMENT } from "../../src/api/openapi.ts";

if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:18119" || process.env.FIREBASE_PROJECT_ID !== "demo-patternly-sync-conflict") throw new Error("sync_conflict_isolated_emulator_required");
const root = resolve("../patternly");
const appRequire = createRequire(resolve(root, "package.json"));
const load = path => appRequire(resolve(root, "src", path));
const { terminalWireFixture } = load("testing/terminalWireFixture.ts");
const data = load("storage/repositories/accountDataRepository.ts");
const { bindGuestInstallationToAccount } = load("storage/repositories/guestInstallationRepository.ts");
const { inspectAccountSyncConflict, loadAccountDataSession, resolveAccountSyncConflict, retryPendingAccountDataSync } = load("application/account/accountDataService.ts");
const { createPatternlyApiClient, PatternlyApiClientError } = load("infrastructure/clients/PatternlyApiClientAdapter.ts");
const { productionLearningDataAdmissionContext: admission } = load("application/tracks/trackAdmissionContext.ts");
const { installLearningStateResetBarrier } = load("application/learningMutations/index.ts");
installLearningStateResetBarrier(async operation => operation());
const context = createEmulatorContext();
const subjects = [];
const validator = new Ajv2020({ strict: false, validateFormats: false });
const schema = name => validator.compile({ components: OPENAPI_DOCUMENT.components, $ref: `#/components/schemas/${name}` });
const validatesConflict = validator.compile({ components: OPENAPI_DOCUMENT.components, ...OPENAPI_DOCUMENT.paths["/v1/progress/sync"].post.responses["409"].content["application/json"].schema });
const validatesSuccess = schema("SyncResponse");
const wire = [];
let responseGate = null;
context.app.addHook("onSend", async (request, reply, payload) => {
  if (request.url === "/v1/progress/sync") wire.push({ status: reply.statusCode, body: JSON.parse(String(payload)) });
  if (responseGate && request.url === "/v1/progress/sync" && reply.statusCode === 200) {
    const gate = responseGate;
    responseGate = null;
    gate.observed.resolve({ batchId: request.body.batchId, response: JSON.parse(String(payload)) });
    await gate.release.promise;
  }
  return payload;
});
const origin = await context.app.listen({ host: "127.0.0.1", port: 0 });
function client(auth, calls, options = {}) {
  return createPatternlyApiClient({ apiOrigin: origin, allowLocalHttpForSimulator: true,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    getIdToken: async () => auth.idToken, getAppCheckToken: async () => TEST_APP_CHECK_TOKEN,
    fetchImplementation: async (url, init) => {
      calls.push({ path: new URL(url).pathname, method: init.method });
      options.observeRequest?.(url, init);
      return fetch(url, init);
    },
  });
}
function request(mutation, revision, batchId = randomUUID()) {
  return { canonicalVersion: "canonical-json-v1", deviceId: "00000000-0000-4000-8000-000000000000", expectedAccountRevision: revision, sessionId: "conflict-fixture", batchId, highWatermark: 1, mutations: [mutation] };
}
function mutation(record) {
  return { mutationId: `conflict-${randomUUID()}`, kind: "node", recordType: record.recordType, trackId: record.trackId, targetId: record.recordId, expectedVersion: null, fingerprint: record.fingerprint, state: record.state };
}
async function fixture() {
  const local = await terminalWireFixture();
  const auth = await createVerifiedRegisteredAuthUser(context); subjects.push(auth.userId);
  const calls = [], api = client(auth, calls);
  await bindGuestInstallationToAccount(auth.userId);
  data.saveAccountSyncState({ ...await data.getAccountSyncState(admission), accountId: auth.userId, status: "synced" }, admission);
  const before = await data.ensureAccountOutboxFromLocalDataset(admission);
  return { local, auth, api, calls, before };
}
test.after(async () => {
  for (const id of subjects) { await context.db.recursiveDelete(context.db.collection("users").doc(id)); await context.db.recursiveDelete(context.db.collection("accounts").doc(id)); }
  await context.close();
});

for (const code of ["account_revision_conflict", "version_conflict"]) {
  test(`real store → HTTP route → adapter → account service preserves data on ${code}`, async () => {
    const f = await fixture();
    const activeTrack = f.local.snapshot.records.find(record => record.recordType === "active_track");
    const initial = await f.api.syncProgress(request(mutation(activeTrack), 0));
    assert.equal(initial.accountRevision, 1);
    assert.equal(validatesSuccess(wire.at(-1).body), true, JSON.stringify(validatesSuccess.errors));
    data.saveAccountSyncState({ ...f.before, remoteAccountRevision: code === "version_conflict" ? 1 : 0, status: "offlinePending" }, admission);
    const before = await data.getAccountSyncState(admission);
    const records = (await data.buildAccountDataSnapshot(admission)).records;
    const remoteBefore = await context.stores.progress.readSnapshot(f.auth.userId);
    f.calls.length = 0;
    const result = await retryPendingAccountDataSync(f.api, f.auth.userId);
    assert.equal(result.status, "conflict");
    assert.equal(result.blockingConflictCode, code);
    assert.equal(result.syncConflict.code, code);
    assert.deepEqual(f.calls, [{ path: "/v1/progress/sync", method: "POST" }]);
    const rejection = wire.at(-1);
    assert.equal(rejection.status, 409);
    assert.deepEqual(rejection.body, { error: { code, ...(code === "account_revision_conflict" ? { currentAccountRevision: 1 } : {}) } });
    assert.equal(validatesConflict(rejection.body), true, JSON.stringify(validatesConflict.errors));
    const after = await data.getAccountSyncState(admission);
    assert.deepEqual(after.outbox, before.outbox);
    assert.equal(after.remoteAccountRevision, before.remoteAccountRevision);
    assert.equal(after.lastSuccessfulSyncAt, before.lastSuccessfulSyncAt);
    assert.equal(after.materialization, null);
    assert.ok(after.syncPlan.items.every(item => item.status === "pending"));
    assert.deepEqual((await data.buildAccountDataSnapshot(admission)).records, records);
    assert.deepEqual(await context.stores.progress.readSnapshot(f.auth.userId), remoteBefore);
    assert.equal((await retryPendingAccountDataSync(f.api, f.auth.userId)).syncConflict.conflictId, result.syncConflict.conflictId);
    assert.equal(f.calls.length, 1, "persisted conflict blocks automatic retry and download");
    const latest = await f.api.getProgress();
    assert.equal(latest.accountRevision, 1);
    assert.equal(latest.records[0].version, 1, "fresh records remain available through the regular read path");
  });
}

test("real route and HTTP adapter classify every code-only store rejection without ACK", async () => {
  const original = context.stores.progress.applyBatch.bind(context.stores.progress);
  try {
    for (const code of ["content_identity_schema_conflict", "mutation_id_reuse", "progress_generation_conflict", "authorization_generation_conflict"]) {
      const f = await fixture();
      // Inject the store failure only: authentication, routing, serialization, HTTP,
      // parsing and account persistence remain production code. Real store conflicts are tested above.
      context.stores.progress.applyBatch = async () => { throw new Error(code); };
      f.calls.length = 0;
      const result = await retryPendingAccountDataSync(f.api, f.auth.userId);
      const body = wire.at(-1).body;
      assert.deepEqual(body, { error: { code } });
      assert.equal(validatesConflict(body), true, JSON.stringify(validatesConflict.errors));
      assert.equal(result.lastFailureCode, code);
      assert.equal(result.status, code === "content_identity_schema_conflict" ? "conflict" : "failed");
      const after = await data.getAccountSyncState(admission);
      assert.deepEqual(after.outbox, f.before.outbox);
      assert.equal(after.materialization, null);
      assert.ok(after.syncPlan.items.every(item => item.status === "pending"));
      assert.deepEqual(f.calls, [{ path: "/v1/progress/sync", method: "POST" }]);
      context.stores.progress.applyBatch = original;
    }
  } finally { context.stores.progress.applyBatch = original; }
});

test("real HTTP adapter retains revision detail and OpenAPI rejects old or incomplete bodies", async () => {
  const f = await fixture();
  const active = f.local.snapshot.records.find(record => record.recordType === "active_track");
  await f.api.syncProgress(request(mutation(active), 0));
  await assert.rejects(f.api.syncProgress(request(mutation(active), 0)), error => error instanceof PatternlyApiClientError && error.status === 409 && error.serverCode === "account_revision_conflict" && error.details.currentAccountRevision === 1);
  const legacy = { accountRevision: 1, applied: [], duplicates: [], conflicts: [{ mutationId: "conflict-legacy-0001", code: "version_conflict", current: null }] };
  assert.equal(validatesConflict(legacy), false);
  assert.equal(validatesSuccess(legacy), false);
  assert.equal(validatesConflict({ error: { code: "account_revision_conflict" } }), false);
  assert.equal(validatesConflict({ error: { code: "version_conflict", current: null } }), false);
});

test("schema-conflict rejection keeps route validation issues through actual HTTP", async () => {
  const f = await fixture();
  const active = f.local.snapshot.records.find(record => record.recordType === "active_track");
  const tamperingProxy = createPatternlyApiClient({ apiOrigin: origin, allowLocalHttpForSimulator: true,
    getIdToken: async () => f.auth.idToken, getAppCheckToken: async () => TEST_APP_CHECK_TOKEN,
    fetchImplementation: async (url, init) => {
      const body = JSON.parse(init.body);
      body.mutations[0].state.protocolVersion = "unsupported-wire";
      return fetch(url, { ...init, body: JSON.stringify(body) });
    },
  });
  await assert.rejects(tamperingProxy.syncProgress(request(mutation(active), 0)), error => {
    assert.ok(error instanceof PatternlyApiClientError);
    assert.equal(error.serverCode, "content_identity_schema_conflict");
    assert.equal(error.status, 409);
    assert.ok(error.details.issues.length > 0);
    assert.equal(validatesConflict(wire.at(-1).body), true, JSON.stringify(validatesConflict.errors));
    return true;
  });
  assert.equal((await context.stores.progress.readSnapshot(f.auth.userId)).records.length, 0);
});

const PAIR_TRACK = "coding-interview-dsa-problem-solving";
const OTHER_TRACK = "google-cloud-associate-cloud-engineer";
const pairRecord = record => record.trackId === PAIR_TRACK && ["goal", "learning_plan"].includes(record.recordType);
const { acceptedTargetFromGoal, createDefaultGoal, createLearningPlanSlotId } = load("domain/index.ts");
const { contentPackageRuntimeOwner } = load("application/contentPackageRuntimeOwner.ts");
const { recommendLearningPlanMode } = load("application/learningPlan/learningPlanModeRecommendation.ts");
const { commitGoalPlanAcceptance } = load("application/learningMutations/commitGoalPlanAcceptance.ts");
const { requireGoalPolicy } = load("domain/tracks/trackGoalPolicies.ts");
const { getGoalSnapshot } = load("storage/repositories/goalRepository.ts");
const { getLearningPlanSnapshot } = load("storage/repositories/learningPlanRepository.ts");
const { saveActiveTrackId } = load("storage/repositories/activeTrackRepository.ts");
const { openProfileStorageRouter } = load("infrastructure/storage/profileStorageRouter.ts");
const profileStorage = load("infrastructure/storage/mmkvClient.ts");
const runFile = promisify(execFile);

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

async function localPair() {
  const policy = requireGoalPolicy(PAIR_TRACK);
  return { goal: await getGoalSnapshot(PAIR_TRACK, policy), plan: getLearningPlanSnapshot(PAIR_TRACK, policy) };
}

async function commitPair(targetDate) {
  const resolved = await contentPackageRuntimeOwner.resolveForDiscovery(PAIR_TRACK, "coding_interview");
  const recommendation = recommendLearningPlanMode({ binding: resolved.runtime.getPlanningModeBinding(), trackId: PAIR_TRACK, modes: resolved.track.modes, sessions: [], dueReviewCount: 0 });
  const before = await localPair();
  const goal = { ...(before.goal?.record ?? createDefaultGoal(requireGoalPolicy(PAIR_TRACK))), ...(targetDate ? { targetDate } : {}) };
  const now = new Date().toISOString();
  const id = `http-pair-${randomUUID()}`;
  return commitGoalPlanAcceptance({
    proposalId: id, trackId: PAIR_TRACK, proposedGoal: goal,
    expectedGoalRevision: before.goal?.revision ?? null, expectedPlanStorageRevision: before.plan?.revision ?? null,
    identity: "a21-http-canonical-producer", createdAt: now, revalidate() {},
    plan: {
      schemaVersion: 2, planId: id, trackId: PAIR_TRACK, goalRevision: (before.goal?.revision ?? 0) + 1,
      status: "accepted", timezone: "Europe/Warsaw", contentVersion: resolved.track.trainingIdentity.contentVersion,
      artifactSha256: resolved.track.trainingIdentity.artifactSha256, acceptedTarget: acceptedTargetFromGoal(goal),
      createdAt: now, updatedAt: now, planRevision: (before.plan?.plan.planRevision ?? 0) + 1, commandId: id,
      slots: [{ slotId: createLearningPlanSlotId(id), day: goal.preferredDays[0], localTime: "18:00", sessionLength: recommendation.mode.defaultRequestedLength }],
      minutesPerStudyDay: 60, executionPolicy: recommendation.executionPolicy, planningPolicyIdentity: resolved.planningPolicyIdentity,
    },
  });
}

async function accountPairFixture() {
  const auth = await createVerifiedRegisteredAuthUser(context);
  subjects.push(auth.userId);
  profileStorage.closeActiveProfileStorage();
  profileStorage.installKeyValueStorageForTests(new profileStorage.MemoryKeyValueStorage());
  const base = new profileStorage.MemoryKeyValueStorage();
  const controlValues = new Map();
  const control = { async get(key) { return controlValues.get(key) ?? null; }, async set(key, value) { controlValues.set(key, value); }, async remove(key) { controlValues.delete(key); } };
  const identity = { async create() { return { installationId: randomUUID(), localDatasetId: randomUUID() }; } };
  let router = await openProfileStorageRouter(base, control, { identity });
  const activate = async () => {
    profileStorage.setProfileStoragePreparationFactoryForTests(async () => ({ base, router }));
    await profileStorage.prepareProfileStorage();
    const { profile } = await profileStorage.selectPreparedAccountProfile(auth.userId);
    profileStorage.activatePreparedProfile(profile.id, profile.kind);
    assert.equal(profile.kind, "account");
    assert.equal(profile.accountId, auth.userId);
    return profile;
  };
  try {
    await activate();
    const lease = profileStorage.captureActiveProfileStorageLease();
    assert.ok(lease);
    await profileStorage.writeActiveAccountIdentityBinding({ lease, accountId: auth.userId, firebaseUid: auth.localId, canContinue: () => true });
    assert.equal((await profileStorage.readActiveAccountIdentityBinding(lease)).kind, "verified");
    data.saveAccountSyncState({ ...await data.getAccountSyncState(admission), accountId: auth.userId, status: "synced" }, admission);
    const calls = [], api = client(auth, calls);
    await commitPair();
    await saveActiveTrackId(PAIR_TRACK);
    assert.equal((await retryPendingAccountDataSync(api, auth.userId)).status, "synced");
    const initial = await api.getProgress();
    assert.equal(initial.records.filter(pairRecord).length, 2);
    return { auth, api, calls, initial,
      async reopen() {
        profileStorage.closeActiveProfileStorage();
        router = await openProfileStorageRouter(base, control, { identity });
        await activate();
        assert.equal((await profileStorage.readActiveAccountIdentityBinding(profileStorage.captureActiveProfileStorageLease())).kind, "verified");
      },
      close() { profileStorage.closeActiveProfileStorage(); profileStorage.setProfileStoragePreparationFactoryForTests(null); },
    };
  } catch (error) {
    profileStorage.closeActiveProfileStorage();
    profileStorage.setProfileStoragePreparationFactoryForTests(null);
    throw error;
  }
}

async function competingPair(f) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "patternly-a21-second-client-")));
  try {
    await chmod(directory, 0o700);
    // The producer partitions remote DTOs, including their verified updatedAt;
    // local record projection would discard required transport evidence.
    const input = { accountId: f.auth.userId, accountRevision: f.initial.accountRevision, generation: f.initial.generation, nextPageToken: f.initial.nextPageToken ?? null, records: f.initial.records };
    await writeFile(join(directory, "input.json"), JSON.stringify(input), { mode: 0o600 });
    const { stdout } = await runFile(process.execPath, ["--import", "tsx", resolve(root, "scripts/qa/goalPlanSecondClientProducer.mjs"), "--private-root", directory, "--input", "input.json", "--output-root", directory], { timeout: 20_000, maxBuffer: 64 * 1024 });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.result, "ready", "the existing canonical second-client producer must pass its own guards");
    const body = JSON.parse(await readFile(join(directory, result.requestFile), "utf8"));
    const receipt = JSON.parse(await readFile(join(directory, result.receiptFile), "utf8"));
    assert.equal(receipt.memoryProfile.kind, "account");
    assert.equal(receipt.accountId, f.auth.userId);
    assert.equal(body.mutations.length, 2);
    assert.ok(body.mutations.every(pairRecord));
    await f.api.syncProgress(body);
    const remote = await f.api.getProgress();
    return { receipt, remote };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function serverSyncRecords(userId) {
  return Promise.all(["progress", "syncMetadata", "syncMutations", "syncBatches"].map(async collection =>
    (await context.db.collection("users").doc(userId).collection(collection).orderBy("__name__").get()).docs.map(doc => [doc.id, doc.data()])));
}

for (const resolution of ["keep_account", "keep_local"]) {
  test(`A21 HTTP changed pair requires explicit ${resolution} and preserves unrelated pending work`, { timeout: 30_000 }, async () => {
    const f = await accountPairFixture();
    try {
      const competitor = await competingPair(f);
      const local = await commitPair("2027-02-02");
      assert.notEqual(local.goal.record.targetDate, competitor.receipt.committedGoalPlanEnvelopes.goal.payload.targetDate);
      await saveActiveTrackId(OTHER_TRACK);
      const pending = await data.ensureAccountOutboxFromLocalDataset(admission);
      const unrelatedPending = pending.outbox.filter(entry => !pairRecord(entry));
      const unrelatedAcknowledged = Object.fromEntries(Object.entries(pending.acknowledged).filter(([, entry]) => !pairRecord(entry)));
      assert.ok(unrelatedPending.length > 0);
      assert.ok(Object.keys(unrelatedAcknowledged).length > 0);
      const localBefore = await localPair();
      const remoteBefore = await serverSyncRecords(f.auth.userId);
      f.calls.length = 0;
      const conflicted = await retryPendingAccountDataSync(f.api, f.auth.userId);
      assert.equal(conflicted.syncConflict.code, "account_revision_conflict");
      assert.equal(wire.at(-1).status, 409);
      assert.deepEqual(f.calls, [{ path: "/v1/progress/sync", method: "POST" }]);
      assert.deepEqual((await data.getAccountSyncState(admission)).outbox, pending.outbox);
      assert.deepEqual(await localPair(), localBefore);
      assert.deepEqual(await serverSyncRecords(f.auth.userId), remoteBefore);
      await f.reopen();
      f.calls.length = 0;
      assert.equal((await loadAccountDataSession(f.api, f.auth.userId)).syncConflict.conflictId, conflicted.syncConflict.conflictId);
      assert.equal((await retryPendingAccountDataSync(f.api, f.auth.userId)).syncConflict.conflictId, conflicted.syncConflict.conflictId);
      assert.deepEqual(f.calls, [], "durable conflict permits neither automatic POST nor GET after profile reopen");
      const preview = await inspectAccountSyncConflict(f.api, f.auth.userId);
      assert.equal(preview.kind, "pair_choice_required");
      assert.deepEqual(preview.changedPairTrackIds, [PAIR_TRACK]);
      assert.deepEqual(f.calls, [{ path: "/v1/progress", method: "GET" }]);
      const oldIds = pending.outbox.filter(pairRecord).map(entry => entry.mutationId);
      await resolveAccountSyncConflict({ api: f.api, accountId: f.auth.userId, conflictId: preview.conflictId, resolution, trackId: PAIR_TRACK });
      assert.deepEqual(f.calls, [{ path: "/v1/progress", method: "GET" }, { path: "/v1/progress", method: "GET" }]);
      const selected = await localPair(), after = await data.getAccountSyncState(admission);
      assert.equal(after.syncConflict, null);
      assert.deepEqual(after.outbox.filter(entry => !pairRecord(entry)), unrelatedPending);
      assert.deepEqual(Object.fromEntries(Object.entries(after.acknowledged).filter(([, entry]) => !pairRecord(entry))), unrelatedAcknowledged);
      assert.equal(selected.plan.plan.goalRevision, selected.goal.revision);
      assert.deepEqual(selected.plan.plan.acceptedTarget, acceptedTargetFromGoal(selected.goal.record));
      if (resolution === "keep_account") {
        assert.deepEqual(selected.goal.record, competitor.receipt.committedGoalPlanEnvelopes.goal.payload);
        assert.deepEqual(selected.plan.plan, competitor.receipt.committedGoalPlanEnvelopes.learningPlan.payload);
        assert.equal(after.outbox.filter(pairRecord).length, 0);
        assert.deepEqual(await serverSyncRecords(f.auth.userId), remoteBefore, "keep-account choice performs no remote write");
      } else {
        assert.deepEqual(selected, localBefore);
        const pairOutbox = after.outbox.filter(pairRecord);
        assert.equal(pairOutbox.length, 2);
        for (const entry of pairOutbox) {
          assert.ok(!oldIds.includes(entry.mutationId));
          assert.equal(entry.expectedVersion, competitor.remote.records.find(record => record.recordType === entry.recordType && record.trackId === PAIR_TRACK).version);
        }
        assert.equal((await retryPendingAccountDataSync(f.api, f.auth.userId)).status, "synced");
        const remote = await f.api.getProgress();
        assert.deepEqual(remote.records.find(record => record.trackId === PAIR_TRACK && record.recordType === "goal").state.record, localBefore.goal.record);
        assert.deepEqual(remote.records.find(record => record.trackId === PAIR_TRACK && record.recordType === "learning_plan").state.plan, localBefore.plan.plan);
        assert.deepEqual(await localPair(), localBefore);
      }
    } finally { f.close(); }
  });
}

test("A21 HTTP retries an identical committed pair batch after the real ACK times out", { timeout: 30_000 }, async () => {
  const f = await accountPairFixture();
  const gate = { observed: deferred(), release: deferred() };
  let firstAttempt;
  try {
    await commitPair("2027-02-02");
    const pending = await data.ensureAccountOutboxFromLocalDataset(admission);
    assert.equal(pending.outbox.length, 2);
    assert.ok(pending.outbox.every(pairRecord));
    const rawRequests = [], calls = [];
    const timedApi = client(f.auth, calls, { timeoutMs: 3000, observeRequest(url, init) {
      if (new URL(url).pathname === "/v1/progress/sync") rawRequests.push(init.body);
    } });
    let observedError;
    const observedApi = { ...timedApi, async syncProgress(input) {
      try { return await timedApi.syncProgress(input); }
      catch (error) { observedError = error; throw error; }
    } };
    responseGate = gate;
    firstAttempt = retryPendingAccountDataSync(observedApi, f.auth.userId);
    const firstBoundary = await Promise.race([
      gate.observed.promise.then(value => ({ kind: "committed", value })),
      firstAttempt.then(() => ({ kind: "finished-before-commit" })),
    ]);
    assert.equal(firstBoundary.kind, "committed", "lost ACK requires observed production commit before the client deadline");
    const committed = await serverSyncRecords(f.auth.userId);
    const committedSnapshot = await context.stores.progress.readSnapshot(f.auth.userId);
    assert.equal(firstBoundary.value.batchId, JSON.parse(rawRequests[0]).batchId);
    assert.equal(firstBoundary.value.response.applied.length, 2);
    assert.equal(committedSnapshot.accountRevision, f.initial.accountRevision + 2);
    const timedOut = await firstAttempt;
    assert.equal(timedOut.status, "offlinePending");
    assert.ok(observedError instanceof PatternlyApiClientError);
    assert.equal(observedError.code, "request_timeout");
    const waiting = await data.getAccountSyncState(admission);
    assert.equal(waiting.syncConflict, null);
    assert.deepEqual(waiting.outbox, pending.outbox);
    assert.deepEqual(waiting.syncPlan, pending.syncPlan);
    assert.deepEqual(calls, [{ path: "/v1/progress/sync", method: "POST" }]);
    gate.release.resolve();
    assert.equal((await retryPendingAccountDataSync(timedApi, f.auth.userId)).status, "synced");
    assert.equal(rawRequests.length, 2);
    assert.equal(rawRequests[1], rawRequests[0], "retry must preserve the exact serialized request, not rebase it");
    assert.deepEqual(await serverSyncRecords(f.auth.userId), committed, "replay preserves record revisions, mutation receipts, batch response and TTL timestamps");
    assert.deepEqual(await context.stores.progress.readSnapshot(f.auth.userId), committedSnapshot);
    const selected = await localPair();
    assert.equal(selected.plan.plan.goalRevision, selected.goal.revision);
    assert.deepEqual(selected.plan.plan.acceptedTarget, acceptedTargetFromGoal(selected.goal.record));
    assert.equal((await data.getAccountSyncState(admission)).outbox.length, 0);
  } finally {
    responseGate = null;
    gate.release.resolve();
    if (firstAttempt) await firstAttempt;
    f.close();
  }
});

test("A21 HTTP keep_account accepts a remotely deleted whole pair and preserves unrelated pending work", { timeout: 30_000 }, async () => {
  const f = await accountPairFixture();
  try {
    const { createMergeRecordFingerprint } = await import("../../src/modules/users/merge.ts");
    const { getActiveMutationJournal } = load("storage/repositories/mutationJournalRepository.ts");
    const initialPair = f.initial.records.filter(pairRecord);
    assert.equal(initialPair.length, 2);
    assert.ok(initialPair.every(record => record.state.deleted !== true));
    const tombstones = initialPair.map(record => {
      const state = { deleted: true };
      const identity = { recordId: record.targetId, recordType: record.recordType, trackId: record.trackId, state };
      return { mutationId: `a21-delete-${randomUUID()}`, kind: record.kind, recordType: record.recordType, trackId: record.trackId,
        targetId: record.targetId, expectedVersion: record.version, fingerprint: createMergeRecordFingerprint(identity), state };
    });
    const deleted = await f.api.syncProgress({ ...request(tombstones[0], f.initial.accountRevision), mutations: tombstones });
    assert.equal(wire.at(-1).status, 200);
    assert.equal(deleted.applied.length, 2);
    assert.equal(deleted.accountRevision, f.initial.accountRevision + 2);
    const remoteDeleted = await f.api.getProgress();
    const remotePair = remoteDeleted.records.filter(pairRecord);
    assert.equal(remotePair.length, 2);
    assert.equal(remoteDeleted.accountRevision, f.initial.accountRevision + 2);
    for (const record of remotePair) {
      const initial = initialPair.find(entry => entry.targetId === record.targetId && entry.recordType === record.recordType);
      const mutation = tombstones.find(entry => entry.recordType === record.recordType);
      assert.ok(initial && mutation);
      assert.deepEqual(record.state, { deleted: true });
      assert.equal(record.version, initial.version + 1);
      assert.equal(record.fingerprint, mutation.fingerprint);
    }

    await commitPair("2027-02-02");
    await saveActiveTrackId(OTHER_TRACK);
    const pending = await data.ensureAccountOutboxFromLocalDataset(admission);
    const unrelatedPending = pending.outbox.filter(entry => !pairRecord(entry));
    const unrelatedAcknowledged = Object.fromEntries(Object.entries(pending.acknowledged).filter(([, entry]) => !pairRecord(entry)));
    assert.ok(unrelatedPending.length > 0);
    assert.ok(Object.keys(unrelatedAcknowledged).length > 0);
    const localBefore = await localPair();
    assert.ok(localBefore.goal && localBefore.plan);
    const serverBefore = await serverSyncRecords(f.auth.userId);
    f.calls.length = 0;
    const conflicted = await retryPendingAccountDataSync(f.api, f.auth.userId);
    assert.equal(conflicted.syncConflict.code, "account_revision_conflict");
    assert.equal(wire.at(-1).status, 409);
    assert.deepEqual(f.calls, [{ path: "/v1/progress/sync", method: "POST" }]);
    assert.deepEqual(await localPair(), localBefore);
    assert.deepEqual((await data.getAccountSyncState(admission)).outbox, pending.outbox);
    assert.deepEqual(await serverSyncRecords(f.auth.userId), serverBefore);

    f.calls.length = 0;
    const preview = await inspectAccountSyncConflict(f.api, f.auth.userId);
    assert.equal(preview.kind, "pair_choice_required");
    assert.deepEqual(preview.changedPairTrackIds, [PAIR_TRACK]);
    await resolveAccountSyncConflict({ api: f.api, accountId: f.auth.userId, conflictId: preview.conflictId, resolution: "keep_account", trackId: PAIR_TRACK });
    assert.deepEqual(f.calls, [{ path: "/v1/progress", method: "GET" }, { path: "/v1/progress", method: "GET" }]);
    assert.deepEqual(await localPair(), { goal: null, plan: null });
    const after = await data.getAccountSyncState(admission);
    assert.equal(after.syncConflict, null);
    assert.equal(after.status, "offlinePending");
    assert.equal(after.outbox.filter(pairRecord).length, 0);
    assert.deepEqual(after.outbox, unrelatedPending);
    assert.deepEqual(Object.fromEntries(Object.entries(after.acknowledged).filter(([, entry]) => !pairRecord(entry))), unrelatedAcknowledged);
    for (const remote of remotePair) {
      assert.deepEqual(after.acknowledged[data.accountDataRecordKey({ ...remote, recordId: remote.targetId })], {
        fingerprint: remote.fingerprint, recordId: remote.targetId, recordType: remote.recordType,
        remoteVersion: remote.version, trackId: remote.trackId,
      });
    }
    assert.equal(getActiveMutationJournal(admission), null);
    assert.deepEqual(await serverSyncRecords(f.auth.userId), serverBefore);
    assert.deepEqual((await f.api.getProgress()).records.filter(pairRecord), remotePair);
    await f.reopen();
    assert.deepEqual(await localPair(), { goal: null, plan: null });
    assert.deepEqual(await data.getAccountSyncState(admission), after);
    assert.equal(getActiveMutationJournal(admission), null);
  } finally { f.close(); }
});
