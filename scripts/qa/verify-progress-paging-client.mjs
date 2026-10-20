import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createEmulatorContext, createRegisteredAuthUser, TEST_APP_CHECK_TOKEN } from "../../tests/support.ts";

if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:18119" || process.env.FIREBASE_PROJECT_ID !== "demo-patternly-perf05-client") throw new Error("paging_client_isolated_emulator_required");
const frontendRoot = process.env.PATTERNLY_FRONTEND_ROOT;
const expectedSha = process.env.PATTERNLY_FRONTEND_EXPECTED_SHA;
if (!frontendRoot || !/^[a-f0-9]{40}$/u.test(expectedSha ?? "")) throw new Error("paging_client_frontend_pin_required");
if (execFileSync("git", ["-C", frontendRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== expectedSha) throw new Error("paging_client_frontend_pin_mismatch");
const frontendRequire = createRequire(resolve(frontendRoot, "package.json"));
const load = (path) => frontendRequire(resolve(frontendRoot, path));
const { createPatternlyApiClient } = load("src/infrastructure/clients/PatternlyApiClientAdapter.ts");
const { MemoryKeyValueStorage, installKeyValueStorageForTests, setActiveProfileLeaseForTests } = load("src/infrastructure/storage/mmkvClient.ts");
const accountData = load("src/storage/repositories/accountDataRepository.ts");
const guest = load("src/storage/repositories/guestInstallationRepository.ts");
const { productionLearningDataAdmissionContext, productionTrackAdmissionContext } = load("src/application/tracks/trackAdmissionContext.ts");
const { session, attempt, review } = load("src/testing/journalTestSupport.ts");
const { saveTrainingSession, getTrainingSessions } = load("src/storage/repositories/trainingSessionRepository.ts");
const { addTrainingAttempt, getTrainingAttempts } = load("src/storage/repositories/trainingAttemptRepository.ts");
const { addReviewQueueItems, getReviewQueueItems } = load("src/storage/repositories/reviewQueueRepository.ts");
const { saveActiveTrackId, getActiveTrackId } = load("src/storage/repositories/activeTrackRepository.ts");
const { resetAccountLocalLearningHistory } = load("src/application/account/accountDataService.ts");
const { installLearningStateResetBarrier } = load("src/application/learningMutations/index.ts");
installLearningStateResetBarrier(async (reset) => reset());
const context = createEmulatorContext();
let stage = "prepare";
try {
  const auth = await createRegisteredAuthUser(context);
  const storage = new MemoryKeyValueStorage(); installKeyValueStorageForTests(storage);
  setActiveProfileLeaseForTests({ id: "paging-client-synthetic", kind: "guest", accountId: null });
  await guest.provisionGuestInstallation({ async create() { return { installationId: "66666666-6666-4666-8666-666666666666", localDatasetId: "77777777-7777-4777-8777-777777777777" }; } });
  await guest.bindGuestInstallationToAccount(auth.userId);
  await accountData.saveAccountSyncState({ ...await accountData.getAccountSyncState(productionLearningDataAdmissionContext), accountId: auth.userId, status: "synced" }, productionLearningDataAdmissionContext);
  await saveActiveTrackId("coding-interview-dsa-problem-solving");
  for (let index = 0; index < 105; index++) {
    const sessionId = `paging-session-${index}`;
    // Match the mobile account-reset fixture's closed wire contract.
    await saveTrainingSession({
      ...session("abandoned", sessionId),
      modeId: "coding-interview-guided-practice",
      configurationSnapshot: { kind: "practice" },
    }, productionTrackAdmissionContext);
    await addTrainingAttempt({
      ...attempt(`paging-attempt-${index}`, sessionId),
      modeId: "coding-interview-guided-practice",
      response: { type: "choice_single", optionId: "a" },
    }, productionTrackAdmissionContext);
  }
  await addReviewQueueItems([{ ...review("paging-review-1", "paging-attempt-0"), sourceSessionId: "paging-session-0" }], productionTrackAdmissionContext);
  const before = await accountData.buildAccountDataSnapshot(productionLearningDataAdmissionContext);
  const calls = [];
  const api = createPatternlyApiClient({ apiOrigin: "https://paging.test.invalid", getIdToken: async () => auth.idToken, getAppCheckToken: async () => TEST_APP_CHECK_TOKEN,
    fetchImplementation: async (url, init) => {
      const parsed = new URL(String(url)); const call = { method: init.method, path: parsed.pathname, query: parsed.search }; calls.push(call);
      const response = await context.app.inject({ method: init.method, url: parsed.pathname + parsed.search, headers: Object.fromEntries(new Headers(init.headers).entries()), ...(init.body ? { payload: JSON.parse(String(init.body)) } : {}) });
      if (parsed.pathname === "/v1/progress" && response.statusCode === 200) call.unchanged = response.json().unchanged === true;
      return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
    } });
  stage = "producer_sync";
  let revision = 0;
  for (let start = 0; start < before.records.length; start += 100) {
    const records = before.records.slice(start, start + 100);
    const result = await api.syncProgress({ canonicalVersion: "canonical-json-v1", deviceId: "00000000-0000-4000-8000-000000000000", sessionId: "paging-client", batchId: `paging-client-${start}`, highWatermark: start + 1, expectedAccountRevision: revision,
      mutations: records.map((record, offset) => ({ mutationId: `paging-mutation-${String(start + offset).padStart(16, "0")}`, kind: ["training_attempt", "review_queue_entry"].includes(record.recordType) ? "item" : "node", recordType: record.recordType, trackId: record.trackId, targetId: record.recordId, fingerprint: record.fingerprint, state: record.state, expectedVersion: null })) });
    assert.equal(result.conflicts.length, 0); revision = result.accountRevision;
  }
  stage = "consumer_sweep";
  const remote = await api.getProgress();
  assert.equal(remote.records.length, before.records.length);
  assert.equal(remote.accountRevision, revision);
  const logical = (records) => [...records].map((record) => [record.recordType, record.trackId, record.recordId ?? record.targetId, record.fingerprint]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(logical(remote.records), logical(before.records));
  await accountData.saveAccountSyncState({ ...await accountData.getAccountSyncState(productionLearningDataAdmissionContext), accountId: auth.userId, status: "synced", outbox: [], remoteAccountRevision: revision }, productionLearningDataAdmissionContext);
  stage = "restore";
  const result = await resetAccountLocalLearningHistory(api, auth.userId);
  assert.equal(result.status, "synced");
  assert.equal((await getTrainingSessions(productionTrackAdmissionContext)).value.length, 105);
  assert.equal((await getTrainingAttempts(productionTrackAdmissionContext)).value.length, 105);
  assert.equal((await getReviewQueueItems(productionTrackAdmissionContext)).value.length, 1);
  assert.equal(await getActiveTrackId(), "coding-interview-dsa-problem-solving");
  const after = await accountData.buildAccountDataSnapshot(productionLearningDataAdmissionContext);
  assert.deepEqual(logical(after.records), logical(before.records));
  const reads = calls.filter((call) => call.path === "/v1/progress");
  assert.equal(reads.length, Math.ceil(before.records.length / 100) + 1, "restore must revalidate the complete cached snapshot in one guarded request");
  assert.ok(reads.every((call) => call.query.includes("pageSize=100")));
  console.log(JSON.stringify({ stage: "producer_consumer_restore", result: "PASS", frontendSha: expectedSha, records: before.records.length, sessions: 105, attempts: 105, reviews: 1, sweeps: 2, pageRequests: reads.length, scope: "actual backend route/store and mobile client/application restore; synthetic MemoryStorage, not native" }));
  if (process.env.COST03_VERIFY_JOURNALED_SYNC === "1") {
    stage = "journaled_account_sync";
    const { commitTrainingSessionStart, commitTrainingOutcome, commitSessionCompletion } = load("src/application/learningMutations/index.ts");
    const { retryPendingAccountDataSync } = load("src/application/account/accountDataService.ts");
    const { createTrainingSessionResult, createFamilyEnvelope } = load("src/domain/index.ts");
    const started = { ...session("active", "paging-journal-session"), modeId: "coding-interview-guided-practice", configurationSnapshot: { kind: "practice" } };
    await commitTrainingSessionStart({ session: started, draft: null, createdAt: started.startedAt });
    await commitTrainingOutcome({ attempt: { ...attempt("paging-journal-attempt", started.id), modeId: started.modeId, response: { type: "choice_single", optionId: "a" } }, session: started, reviews: [], createdAt: started.startedAt });
    const finished = { ...session("completed", started.id), modeId: started.modeId, configurationSnapshot: { kind: "practice" } };
    const outcome = createTrainingSessionResult({ id: `${finished.id}:result`, sessionId: finished.id, trackId: finished.trackId,
      totalOccurrences: 1, answeredOccurrenceIds: ["occurrence-1"], unansweredOccurrenceIds: [], completedAt: finished.completedAt,
      evidence: createFamilyEnvelope({ familyId: "coding_interview", details: { activeForegroundMs: 0, correctCount: 0, partialCount: 0, incorrectCount: 1, pointsEarned: 0, maxPoints: 1 } }) });
    await commitSessionCompletion(finished, outcome, finished.completedAt);
    const pending = await accountData.getAccountSyncState(productionLearningDataAdmissionContext);
    assert.equal(pending.status, "offlinePending");
    const beforeSync = await accountData.buildAccountDataSnapshot(productionLearningDataAdmissionContext);
    assert.equal(beforeSync.records.length, before.records.length + 3);
    const firstSyncCall = calls.length;
    const synchronized = await retryPendingAccountDataSync(api, auth.userId);
    assert.equal(synchronized.status, "synced");
    const syncState = await accountData.getAccountSyncState(productionLearningDataAdmissionContext);
    assert.equal(syncState.outbox.length, 0);
    const afterSync = await accountData.buildAccountDataSnapshot(productionLearningDataAdmissionContext);
    assert.deepEqual(logical(afterSync.records), logical(beforeSync.records));
    const historicalKeys = new Set(before.records.map((record) => JSON.stringify([record.recordType, record.trackId, record.recordId])));
    assert.deepEqual(logical(afterSync.records.filter((record) => historicalKeys.has(JSON.stringify([record.recordType, record.trackId, record.recordId])))), logical(before.records));
    const syncCalls = calls.slice(firstSyncCall);
    assert.equal(syncCalls.filter((call) => call.path === "/v1/progress/sync").length, 1);
    assert.equal(syncCalls.filter((call) => call.path === "/v1/progress").length, 1);
    assert.equal(syncCalls.find((call) => call.path === "/v1/progress").unchanged, true);
    console.log(JSON.stringify({ stage, result: "PASS", frontendSha: expectedSha, preservedRecords: before.records.length, finalRecords: afterSync.records.length, outboxEntries: syncState.outbox.length, syncRequests: 1, revalidationRequests: 1, revalidationUnchanged: true, scope: "production journal start/answer/completion, accountDataService sync, exact ACK and full local materialization; MemoryStorage/emulator boundary only" }));
  }
} catch (error) {
  throw new Error(`paging_client_failed:${stage}`, { cause: error });
} finally { await context.close(); }
