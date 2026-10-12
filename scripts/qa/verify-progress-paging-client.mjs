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
    await saveTrainingSession(session("abandoned", sessionId), productionTrackAdmissionContext);
    await addTrainingAttempt(attempt(`paging-attempt-${index}`, sessionId), productionTrackAdmissionContext);
  }
  await addReviewQueueItems([review("paging-review-1", "paging-attempt-0")], productionTrackAdmissionContext);
  const before = await accountData.buildAccountDataSnapshot(productionLearningDataAdmissionContext);
  const calls = [];
  const api = createPatternlyApiClient({ apiOrigin: "https://paging.test.invalid", getIdToken: async () => auth.idToken, getAppCheckToken: async () => TEST_APP_CHECK_TOKEN,
    fetchImplementation: async (url, init) => {
      const parsed = new URL(String(url)); calls.push({ method: init.method, path: parsed.pathname, query: parsed.search });
      const response = await context.app.inject({ method: init.method, url: parsed.pathname + parsed.search, headers: Object.fromEntries(new Headers(init.headers).entries()), ...(init.body ? { payload: JSON.parse(String(init.body)) } : {}) });
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
  assert.equal(reads.length, 2 * Math.ceil(before.records.length / 100));
  assert.ok(reads.every((call) => call.query.includes("pageSize=100")));
  console.log(JSON.stringify({ stage: "producer_consumer_restore", result: "PASS", frontendSha: expectedSha, records: before.records.length, sessions: 105, attempts: 105, reviews: 1, sweeps: 2, pageRequests: reads.length, scope: "actual backend route/store and mobile client/application restore; synthetic MemoryStorage, not native" }));
} catch (error) {
  throw new Error(`paging_client_failed:${stage}`, { cause: error });
} finally { await context.close(); }
