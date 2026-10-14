import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { FirestoreProgressStore } from "../../src/modules/progress/store.ts";
import { buildGuestMergePreview, createMergeRecordFingerprint, guestMergeRecordSchema } from "../../src/modules/users/merge.ts";
import { adoptionTransferRecordKey, createAdoptionTransferChunkFingerprint } from "../../src/modules/users/adoptionTransfer.ts";
import { syncRequestSchema } from "../../src/modules/progress/contracts.ts";
import { canonicalJson, canonicalJsonBytes } from "../../src/infrastructure/identity/canonicalJson.ts";
import { RECORD_FINGERPRINT_PROFILE, recordFingerprintPayload } from "../../src/infrastructure/identity/recordFingerprint.ts";
import { progressDocumentId } from "../../src/infrastructure/firestore/paths.ts";

if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:18119" || process.env.FIREBASE_PROJECT_ID !== "demo-patternly-record-fingerprint") throw new Error("record_fingerprint_isolated_emulator_required");
const frontendRoot = resolve(process.env.PATTERNLY_FRONTEND_ROOT ?? "../patternly");
const requireApp = createRequire(resolve(frontendRoot, "package.json"));
const load = (path) => requireApp(resolve(frontendRoot, "src", path));
const accountData = load("storage/repositories/accountDataRepository.ts");
const { canonicalSerialize } = load("domain/identity/canonicalSerialization.ts");
const appProfile = load("domain/identity/recordFingerprint.ts");
const { installMemoryStorage } = load("testing/journalTestSupport.ts");
const { productionLearningDataAdmissionContext: admission, productionTrackAdmissionContext: tracks } = load("application/tracks/trackAdmissionContext.ts");
const { provisionGuestInstallation, bindGuestInstallationToAccount } = load("storage/repositories/guestInstallationRepository.ts");
const { saveTrainingSession } = load("storage/repositories/trainingSessionRepository.ts");
const { saveTrainingSessionResult } = load("storage/repositories/trainingSessionResultRepository.ts");
const { isTrainingSessionResult } = load("storage/repositories/trainingModelGuards.ts");
const { createTrainingSessionDraft } = load("domain/index.ts");
const { loadCanonicalRuntimeCatalog } = load("content/canonical/runtimeCatalog.ts");
const { createCanonicalTrainingFamilyRuntime } = load("application/canonicalTrainingFamilyComposition.ts");
const vectors = JSON.parse(readFileSync(resolve(frontendRoot, "integration/contracts/record-fingerprint/vectors.json"), "utf8"));
const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const deviceId = "00000000-0000-4000-8000-000000000000";
const guestUserId = "66666666-6666-4666-8666-666666666666";
const now = "2026-01-01T00:00:00.000Z";
const firebaseApp = initializeApp({ projectId: "demo-patternly-record-fingerprint" }, `record-fingerprint-${randomUUID()}`);
const db = getFirestore(firebaseApp);
const store = new FirestoreProgressStore(db);
const accounts = [];
test.after(async () => {
  for (const id of accounts) await db.recursiveDelete(db.collection("users").doc(id));
  await db.terminate();
  await deleteApp(firebaseApp);
});

test("both implementations and actual fingerprint producers match shared historical vectors", () => {
  assert.equal(vectors.profile, RECORD_FINGERPRINT_PROFILE);
  assert.equal(appProfile.RECORD_FINGERPRINT_PROFILE, RECORD_FINGERPRINT_PROFILE);
  for (const vector of vectors.cases) {
    assert.equal(recordFingerprintPayload(vector.record), vector.payload, vector.name);
    assert.equal(appProfile.recordFingerprintPayload(vector.record), vector.payload, vector.name);
    assert.equal(createMergeRecordFingerprint(vector.record), vector.sha256, vector.name);
    assert.equal(accountData.accountDataRecordFingerprint(vector.record), vector.sha256, vector.name);
    assert.equal(digest(vector.payload), vector.sha256);
  }
  const base = vectors.cases[0].record;
  const sparse = new Array(2); sparse[1] = 1;
  const cycle = {}; cycle.self = cycle;
  for (const value of [undefined, NaN, Infinity, 1n, Symbol("x"), () => 1, new Date(), sparse, cycle, { "é": 1, "e\u0301": 2 }]) {
    assert.throws(() => recordFingerprintPayload({ ...base, state: { nested: value } }), TypeError);
    assert.throws(() => appProfile.recordFingerprintPayload({ ...base, state: { nested: value } }), TypeError);
  }
  assert.equal(recordFingerprintPayload({ ...base, state: { zero: -0 } }), recordFingerprintPayload({ ...base, state: { zero: 0 } }));
});

for (const [name, text] of [["ASCII", "API users need a stable interface."], ["NFC", "Café users need a stable API."], ["NFD", "Cafe\u0301 users need a stable API."]]) {
  test(`real Design runtime → APP persisted snapshot/outbox → merge, progress and adoption: ${name}`, async () => {
    const userId = randomUUID(); accounts.push(userId);
    await db.collection("users").doc(userId).create({ id: userId });
    const storage = installMemoryStorage();
    await provisionGuestInstallation({ async create() { return { installationId: guestUserId, localDatasetId: "77777777-7777-4777-8777-777777777777" }; } });
    // ASCII IDs isolate the original F-13 defect to the user's exact stage text.
    const track = (await loadCanonicalRuntimeCatalog()).getTrack("backend-system-design-interview");
    const profile = track.simulationProfiles[0];
    const runtime = createCanonicalTrainingFamilyRuntime(track);
    const prepared = await runtime.prepare({ trackId: track.trackId, modeId: profile.modeId, request: { sessionId: "design-record-profile", scope: { simulationProfileId: profile.profileId } }, attempts: [], reviews: [], now });
    const responses = { requirements: "Users need reliable delivery.", architecture: "Durable queue and bounded workers.", tradeoffs: "Duplicates require idempotency.", final_answer: text };
    const draft = createTrainingSessionDraft({ sessionId: prepared.session.id, trackId: track.trackId, familyId: "design_interview", revision: 1, responsesByOccurrenceId: { [prepared.session.itemOrder[0].occurrenceId]: responses }, flaggedOccurrenceIds: [], updatedAt: now });
    const finalized = await runtime.finalizeSimulation({ session: prepared.session, draft, attempts: [], reviews: [], now: "2026-01-01T00:11:00.000Z" });
    assert.equal(isTrainingSessionResult(finalized.result, tracks), true);
    assert.deepEqual(finalized.result.evidence.details.stageCompleteness, { requirements: true, architecture: true, tradeoffs: true, final_answer: true });
    await saveTrainingSession(finalized.session, tracks);
    await saveTrainingSessionResult(finalized.result, tracks);
    const snapshot = await accountData.buildAccountDataSnapshot(admission);
    accountData.assertValidAccountDataRecords(snapshot.records, admission);
    const result = snapshot.records.find((record) => record.recordType === "training_session_result");
    assert.ok(result);
    assert.equal(result.state.evidence.details.responsesByStage.final_answer, text);
    assert.equal(guestMergeRecordSchema.safeParse(result).success, true);
    assert.equal(result.fingerprint, digest(canonicalSerialize({ recordId: result.recordId, recordType: result.recordType, state: result.state, trackId: result.trackId })));
    const guestSnapshot = { guestSnapshotVersion: snapshot.guestSnapshotVersion, guestUserId, records: snapshot.records, activeSession: false, pendingJournal: false };
    buildGuestMergePreview({ accountUserId: userId, accountSnapshotVersion: 0, guestSnapshot, remoteRecords: [] });
    await bindGuestInstallationToAccount(userId);
    accountData.saveAccountSyncState({ ...await accountData.getAccountSyncState(admission), accountId: userId, status: "synced" }, admission);
    const firstOutbox = await accountData.ensureAccountOutboxFromLocalDataset(admission);
    const learningBeforeRetry = new Map([...storage.snapshot()].filter(([key]) => !key.endsWith(":account-sync")));
    const retryOutbox = await accountData.ensureAccountOutboxFromLocalDataset(admission);
    assert.deepEqual(retryOutbox.outbox, firstOutbox.outbox);
    assert.deepEqual(new Map([...storage.snapshot()].filter(([key]) => !key.endsWith(":account-sync"))), learningBeforeRetry);
    assert.deepEqual(await accountData.getAccountSyncState(admission), retryOutbox);
    const persistedAfterRetry = storage.snapshot();
    for (const entry of firstOutbox.outbox) {
      const legacyId = `mutation_${digest(canonicalSerialize({ accountId: userId, key: accountData.accountDataRecordKey(entry), expectedVersion: entry.expectedVersion, fingerprint: entry.fingerprint }))}`;
      assert.equal(entry.mutationId, legacyId);
    }
    const mutations = firstOutbox.outbox.map((entry) => ({ mutationId: entry.mutationId, kind: ["training_attempt", "review_queue_entry"].includes(entry.recordType) ? "item" : "node", recordType: entry.recordType, trackId: entry.trackId, targetId: entry.recordId, expectedVersion: entry.expectedVersion, fingerprint: entry.fingerprint, state: entry.state }));
    const metadata = { sessionId: `sync-${name}`, batchId: `sync-${name}:0`, highWatermark: firstOutbox.outboxSequence };
    const request = { canonicalVersion: "canonical-json-v1", deviceId, expectedAccountRevision: 0, ...metadata, mutations };
    assert.equal(syncRequestSchema.safeParse(request).success, true);
    assert.equal(syncRequestSchema.safeParse({ ...request, canonicalVersion: RECORD_FINGERPRINT_PROFILE }).success, false);
    const applied = await store.applyBatch(userId, 1, deviceId, 0, mutations, metadata);
    const replay = await store.applyBatch(userId, 1, deviceId, 0, mutations, metadata);
    assert.deepEqual(replay, applied);
    const remote = await store.readSnapshot(userId);
    assert.equal(remote.records.length, snapshot.records.length);
    const remoteResult = remote.records.find((record) => record.recordType === "training_session_result");
    assert.equal(remoteResult.state.evidence.details.responsesByStage.final_answer, text);
    assert.equal(remoteResult.fingerprint, result.fingerprint);
    const dedup = buildGuestMergePreview({ accountUserId: userId, accountSnapshotVersion: remote.accountRevision, guestSnapshot, remoteRecords: remote.records.map((record) => ({ ...record, recordId: record.targetId })) });
    assert.equal(dedup.plan.deduplicatedRecordIds.length, snapshot.records.length);
    const changed = { ...result, state: { ...result.state, evidence: { ...result.state.evidence, details: { ...result.state.evidence.details, responsesByStage: { ...responses, final_answer: `${text} changed` } } } } };
    assert.throws(() => buildGuestMergePreview({ accountUserId: userId, accountSnapshotVersion: 0, guestSnapshot: { ...guestSnapshot, records: [changed] }, remoteRecords: [] }), /progress_fingerprint_mismatch/u);
    assert.throws(() => accountData.assertValidAccountDataRecords([changed], admission), { code: "account_data_record_invalid" });
    await assert.rejects(accountData.applyRemoteAccountData([changed], admission));
    const changedMutation = { ...mutations.find((mutation) => mutation.recordType === "training_session_result"), state: changed.state };
    await assert.rejects(store.applyBatch(userId, 1, deviceId, remote.accountRevision, [changedMutation], { ...metadata, batchId: `tamper-${name}` }), /progress_fingerprint_mismatch/u);
    if (name === "NFD") {
      const wrongProfile = { ...result, fingerprint: digest(canonicalJson({ recordId: result.recordId, recordType: result.recordType, state: result.state, trackId: result.trackId })) };
      assert.notEqual(wrongProfile.fingerprint, result.fingerprint);
      assert.throws(() => buildGuestMergePreview({ accountUserId: userId, accountSnapshotVersion: 0, guestSnapshot: { ...guestSnapshot, records: [wrongProfile] }, remoteRecords: [] }), /progress_fingerprint_mismatch/u);
    }
    assert.deepEqual(await store.readSnapshot(userId), remote, "rejected payloads cause no progress write");
    const oneShotPreview = await store.previewAdoption(userId, guestSnapshot);
    const confirmation = { operationId: oneShotPreview.preview.operationId, previewFingerprint: oneShotPreview.preview.fingerprint, resolutions: [], groupChoices: [] };
    const oneShot = await store.confirmAdoption(userId, 1, deviceId, guestSnapshot, confirmation);
    assert.deepEqual(await store.confirmAdoption(userId, 1, deviceId, guestSnapshot, confirmation), oneShot);
    assert.equal(oneShot.records.find((record) => record.recordType === "training_session_result").fingerprint, result.fingerprint);
    const sessionId = `adoption-${name}`;
    await store.startAdoptionTransfer(userId, 1, { canonicalVersion: "canonical-json-v1", deviceId, guestUserId, snapshotVersion: 1, sessionId, expectedGeneration: 0, idempotencyKey: sessionId });
    const recordKeys = snapshot.records.map(adoptionTransferRecordKey).sort();
    const chunkBase = { chunkId: `chunk-${name}`, index: 0, recordKeys, bytes: canonicalJsonBytes(snapshot.records) };
    const upload = { canonicalVersion: "canonical-json-v1", deviceId, records: snapshot.records, chunk: { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) } };
    await store.uploadAdoptionTransfer(userId, 1, sessionId, upload);
    await store.uploadAdoptionTransfer(userId, 1, sessionId, upload);
    await assert.rejects(store.uploadAdoptionTransfer(userId, 1, sessionId, { ...upload, records: snapshot.records.map((record) => record === result ? changed : record) }), /progress_fingerprint_mismatch/u);
    assert.deepEqual(storage.snapshot(), persistedAfterRetry, "consumer acceptance and refusal do not rewrite APP data");
  });
}

test("an existing incompatible backend NFC hash is refused on read and preserved exactly", async () => {
  const userId = randomUUID(); accounts.push(userId);
  await db.collection("users").doc(userId).create({ id: userId });
  const record = { recordId: "existing-record", recordType: "training_session_result", trackId: "backend-system-design-interview", state: {
    id: "existing-record", sessionId: "historical-session", trackId: "backend-system-design-interview", totalOccurrences: 1,
    answeredOccurrenceIds: ["historical-occurrence"], unansweredOccurrenceIds: [], completedAt: now,
    evidence: { familyId: "design_interview", details: { profileId: "historical-profile", profileVersion: "1", caseId: "historical-case", caseVersion: "1",
      responsesByStage: { requirements: "API", architecture: "Queue", tradeoffs: "Retry", final_answer: "Cafe\u0301" },
      stageCompleteness: { requirements: true, architecture: true, tradeoffs: true, final_answer: true } } },
  } };
  const stored = { kind: "node", recordType: record.recordType, trackId: record.trackId, targetId: record.recordId, state: record.state, version: 1, fingerprint: digest(canonicalJson(record)), lastMutationId: "historical-mutation", updatedAt: new Date(now) };
  assert.notEqual(stored.fingerprint, createMergeRecordFingerprint(record));
  const ref = db.collection("users").doc(userId).collection("progress").doc(progressDocumentId(stored));
  await ref.create(stored);
  const before = (await ref.get()).data();
  await assert.rejects(store.readSnapshot(userId), /progress_fingerprint_mismatch/u);
  assert.deepEqual((await ref.get()).data(), before);
});
