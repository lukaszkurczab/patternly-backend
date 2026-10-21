import { attemptState } from "./progressFixtures.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FieldValue, Timestamp, type Firestore, type Transaction } from "firebase-admin/firestore";

import { buildApplication } from "../src/api/app.js";
import { FirestoreProgressStore } from "../src/modules/progress/store.js";
import { adoptionTransferRecordKey, createAdoptionSnapshotSeal, createAdoptionTransferChunkFingerprint } from "../src/modules/users/adoptionTransfer.js";
import { assertGoalPlanBundles, buildGuestMergePreview, mergeRecordKey, progressRecordToMergeRecord, createMergeRecordFingerprint, type GuestMergeConfirmation, type GuestMergeRecord } from "../src/modules/users/merge.js";
import { createFirebaseTokenVerifier } from "../src/infrastructure/firebase/verifier.js";
import { progressDocumentId } from "../src/infrastructure/firestore/paths.js";
import { testEnvironment } from "./support.js";
import { TEST_APP_CHECK_TOKEN, clearFirestore, createEmulatorContext, createRegisteredAuthUser, firestore, setAuthCustomClaimsAndSignIn, type EmulatorContext } from "./support.js";

const deviceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const guestUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const trackId = "coding-interview-dsa-problem-solving";
const canonicalVersion = "canonical-json-v1" as const;
let context: EmulatorContext;

function learningRecord(recordId: string, recordTrackId: string, value = recordId): Readonly<{ recordType: "training_attempt"; recordId: string; trackId: string; state: Readonly<Record<string, unknown>>; version: number; fingerprint: string }> {
  const state = attemptState(recordId, recordTrackId, value);
  return { recordType: "training_attempt", recordId, trackId: recordTrackId, state, version: 0, fingerprint: createMergeRecordFingerprint({ recordType: "training_attempt", recordId, trackId: recordTrackId, state }) };
}

async function prepareConfirmedTransfer(auth: Awaited<ReturnType<typeof createRegisteredAuthUser>>, sessionId: string, records: GuestMergeRecord[], groupChoices: Array<{ groupId: string; resolution: "keep_guest" | "keep_account" }> = []) {
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const recordKeys = records.map(adoptionTransferRecordKey);
  const chunkBase = { chunkId: "chunk-0", index: 0, recordKeys, bytes: 512 };
  const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
  const start = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { canonicalVersion, sessionId, idempotencyKey: sessionId, guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } });
  assert.equal(start.statusCode, 200, JSON.stringify(start.json()));
  if (records.length > 0) {
    const upload = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/upload`, headers, payload: { canonicalVersion, deviceId, chunk, records } });
    assert.equal(upload.statusCode, 200, JSON.stringify(upload.json()));
  }
  const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records, chunks: records.length > 0 ? [chunk] : [] });
  const seal = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/seal`, headers, payload: { canonicalVersion, deviceId, snapshotFingerprint, recordCount: records.length, chunkCount: records.length > 0 ? 1 : 0 } });
  assert.equal(seal.statusCode, 200, JSON.stringify(seal.json()));
  const preview = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/preview`, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.json()));
  const confirmation = { canonicalVersion, deviceId, operationId: preview.json().preview.operationId as string, previewFingerprint: preview.json().preview.fingerprint as string, resolutions: [], groupChoices };
  const confirm = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/confirm`, headers, payload: confirmation });
  assert.equal(confirm.statusCode, 200, JSON.stringify(confirm.json()));
  return { headers, confirm, preview, chunk, confirmation };
}

function goalPlanState(track: string, targetDate: string, goalRevision = 1, planRevision = 1) {
  return {
    goal: { schemaVersion: 1, revision: goalRevision, record: { goalType: "prepare_for_a_certification", preferredDays: ["mon"], status: "active", targetDate, trackId: track, weeklySessionTarget: 1 } },
    learning_plan: { schemaVersion: 1, revision: planRevision, plan: { schemaVersion: 2, planId: `plan-${track}`, trackId: track, goalRevision, status: "accepted", timezone: "Europe/Warsaw", contentVersion: "content-v1", artifactSha256: "a".repeat(64), acceptedTarget: { meaning: "event", targetDate }, createdAt: "2026-09-09T08:00:00.000Z", updatedAt: "2026-09-09T08:00:00.000Z", planRevision, commandId: `command-${planRevision}`, slots: [{ slotId: `slot-${planRevision}`, day: "mon", localTime: "18:00", sessionLength: 25 }], minutesPerStudyDay: 25, executionPolicy: { policyVersion: "patternly-learning-execution-v1", initialDiagnosis: null, practice: { modeId: "coding-interview-guided-practice", requestedLength: 10 } }, planningPolicyIdentity: { contentVersion: "content-v1", artifactSha256: "a".repeat(64), policyVersion: "policy-v1" } } },
  };
}

function goalPlanRecords(track: string, targetDate: string, goalRevision = 1, planRevision = 1): GuestMergeRecord[] {
  const states = goalPlanState(track, targetDate, goalRevision, planRevision);
  return (["goal", "learning_plan"] as const).map((recordType) => {
    const state = states[recordType];
    return { recordId: track, recordType, trackId: track, state, version: 0, fingerprint: createMergeRecordFingerprint({ recordId: track, recordType, trackId: track, state }) };
  });
}

async function seedAccountGoalPlan(auth: Awaited<ReturnType<typeof createRegisteredAuthUser>>, records: GuestMergeRecord[]) {
  const result = await context.stores.progress.applyBatch(auth.userId, 1, deviceId, 0, records.map((record, index) => ({
    mutationId: `seed-group-mutation-${String(index).padStart(4, "0")}`,
    kind: "node" as const,
    recordType: record.recordType as "goal" | "learning_plan",
    trackId: record.trackId,
    targetId: record.recordId,
    expectedVersion: null,
    fingerprint: record.fingerprint,
    state: record.state,
  })), { sessionId: "seed-group-session", batchId: "seed-group-batch", highWatermark: 1 });
  assert.equal(result.applied.length, records.length);
  return context.stores.progress.readSnapshot(auth.userId);
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

test("canonical transfer persists chunks, applies one generation, and retries safely", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const accountId = (await context.app.inject({ method: "GET", url: "/v1/me", headers })).json().user.id as string;
  const records = Array.from({ length: 201 }, (_, index) => learningRecord(`record-${index}`, `track-${index}`));
  const sessionId = "canonical-transfer-test";
  const { confirm, preview } = await prepareConfirmedTransfer(auth, sessionId, records);
  assert.equal(preview.json().plan.uploadRecordIds.length, records.length);
  const apply = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: confirm.json().decisionFingerprint } });
  assert.equal(apply.statusCode, 200, JSON.stringify(apply.json()));
  const retry = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: confirm.json().decisionFingerprint } });
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.json()));
  const status = await context.app.inject({ method: "GET", url: `/v1/account-data/adoption/transfer/${sessionId}/status?deviceId=${deviceId}`, headers });
  assert.equal(status.statusCode, 200, JSON.stringify(status.json()));
  assert.equal(status.json().state, "complete");
  assert.equal(status.json().applyCursor, records.length);
  assert.equal(Object.hasOwn(status.json(), "protocolVersion"), false);
  assert.equal(Object.hasOwn(status.json(), "contentIdentitySchema"), false);

  const restored = [];
  let pageToken: string | null = null;
  let revision: number | null = null;
  do {
    const progress: Awaited<ReturnType<typeof context.app.inject>> = await context.app.inject({ method: "GET", url: `/v1/progress${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ""}`, headers });
    assert.equal(progress.statusCode, 200);
    const page = progress.json();
    assert.ok(page.records.length <= 100);
    assert.equal(page.generation, 1);
    if (revision === null) revision = page.accountRevision;
    assert.equal(page.accountRevision, revision);
    restored.push(...page.records);
    pageToken = page.nextPageToken;
  } while (pageToken);
  assert.equal(restored.length, records.length);
  assert.deepEqual(restored.map((record) => record.targetId).sort(), records.map((record) => record.recordId).sort());
  const operation = (await firestore().collection("accounts").doc(accountId).collection("adoptionTransfers").doc(sessionId).get()).data();
  assert.ok(operation);
  assert.equal(Object.hasOwn(operation!, "protocolVersion"), false);
  assert.equal(Object.hasOwn(operation!, "contentIdentitySchema"), false);
  assert.equal((await firestore().collection("users").doc(accountId).collection("progressGenerations").doc("1").collection("records").get()).size, records.length);
});

async function assertStagedGoalPlanGroupChoice(resolution: "keep_account" | "keep_guest") {
  const track = "aws-certified-solutions-architect-associate";
  const auth = await createRegisteredAuthUser(context);
  const accountPair = goalPlanRecords(track, "2027-09-09");
  const seed = await seedAccountGoalPlan(auth, accountPair);
  const guestPair = goalPlanRecords(track, "2027-10-10");
  const ungrouped = Array.from({ length: 199 }, (_, index) => learningRecord(`group-${resolution}-record-${index}`, `group-${resolution}-track-${index}`));
  const records: GuestMergeRecord[] = [...guestPair, ...ungrouped];
  const sessionId = `staged-group-${resolution}`;
  const groupChoices = [{ groupId: `track:${track}`, resolution }];
  const { headers, confirm, preview, confirmation } = await prepareConfirmedTransfer(auth, sessionId, records, groupChoices);
  assert.deepEqual(preview.json().preview.goalPlanConflictGroups.map((group: { groupId: string }) => group.groupId), [`track:${track}`]);
  assert.deepEqual(confirmation.resolutions, []);

  const interruptedApp = buildTransferTransactionRotationApp(auth.userId, 3);
  const applyPayload = { canonicalVersion, deviceId, decisionFingerprint: confirm.json().decisionFingerprint };
  const interrupted = await interruptedApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload: applyPayload });
  assert.equal(interrupted.statusCode, 409, JSON.stringify(interrupted.json()));
  assert.deepEqual(interrupted.json(), { error: { code: "authorization_generation_conflict" } });
  const transferRef = transferRefFor(auth.userId, sessionId);
  const applying = (await transferRef.get()).data()!;
  assert.equal(applying.state, "applying");
  assert.equal(applying.applyCursor, 200);
  const source = await context.stores.progress.readSnapshot(auth.userId);
  assert.equal(source.generation, 0);
  assert.equal(source.accountRevision, seed.accountRevision);
  assert.equal(source.records.length, accountPair.length);
  assert.deepEqual(source.records.map((record) => record.fingerprint).sort(), accountPair.map((record) => record.fingerprint).sort());
  await interruptedApp.close();

  const refreshed = await setAuthCustomClaimsAndSignIn(auth, { authorizationGeneration: 2 });
  const freshHeaders = { ...headers, authorization: `Bearer ${refreshed.idToken}` };
  const resumed = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers: freshHeaders, payload: applyPayload });
  assert.equal(resumed.statusCode, 200, JSON.stringify(resumed.json()));
  assert.equal(resumed.json().state, "complete");

  const expectedGrouped = resolution === "keep_account" ? seed.records.map((record) => ({ recordId: record.targetId, recordType: record.recordType, trackId: record.trackId, state: record.state, fingerprint: record.fingerprint, version: record.version })) : guestPair.map((record) => ({ ...record, version: 2 }));
  const expected = [...expectedGrouped, ...ungrouped.map((record) => ({ ...record, version: 1 }))];
  const completed = (await transferRef.get()).data()!;
  const expectedChanges = resolution === "keep_account" ? ungrouped.length : ungrouped.length + guestPair.length;
  assert.equal(completed.applyChangeCount, expectedChanges);
  assert.equal(completed.accountRevision, seed.accountRevision + expectedChanges);
  assert.equal(completed.applyCursor, expected.length);
  const targetRef = firestore().collection("users").doc(auth.userId).collection("progressGenerations").doc(String(completed.targetGeneration));
  const targetRows = (await targetRef.collection("records").get()).docs.map((document) => document.data());
  assert.equal(targetRows.length, expected.length);
  const byKey = new Map(expected.map((record) => [`${record.recordType}:${record.trackId}:${record.recordId}`, record]));
  for (const row of targetRows) {
    const key = `${row.recordType}:${row.trackId}:${row.targetId}`;
    const record = byKey.get(key);
    assert.ok(record, `unexpected materialized record ${key}`);
    assert.equal(row.fingerprint, record.fingerprint, key);
    assert.equal(row.version, record.version, key);
    assert.deepEqual(row.state, record.state, key);
  }
  const active = await context.stores.progress.readSnapshot(auth.userId);
  assert.equal(active.accountRevision, seed.accountRevision + expectedChanges);
  assert.equal(active.generation, completed.targetGeneration);
  const beforeReplay = {
    operation: (await transferRef.get()).data(),
    target: (await targetRef.get()).data(),
    metadata: (await firestore().collection("users").doc(auth.userId).collection("syncMetadata").doc("account").get()).data(),
    rows: (await targetRef.collection("records").get()).docs.map((document) => document.data()).sort((left, right) => String(left.targetId).localeCompare(String(right.targetId))),
  };
  const replay = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers: freshHeaders, payload: applyPayload });
  assert.equal(replay.statusCode, 200, JSON.stringify(replay.json()));
  assert.equal(replay.json().state, "complete");
  const status = await context.app.inject({ method: "GET", url: `/v1/account-data/adoption/transfer/${sessionId}/status?deviceId=${deviceId}`, headers: freshHeaders });
  assert.equal(status.statusCode, 200, JSON.stringify(status.json()));
  assert.equal(status.json().state, "complete");
  const afterReplay = {
    operation: (await transferRef.get()).data(),
    target: (await targetRef.get()).data(),
    metadata: (await firestore().collection("users").doc(auth.userId).collection("syncMetadata").doc("account").get()).data(),
    rows: (await targetRef.collection("records").get()).docs.map((document) => document.data()).sort((left, right) => String(left.targetId).localeCompare(String(right.targetId))),
  };
  assert.deepEqual(afterReplay, beforeReplay);
}
test("staged keep_account choice survives a committed chunk, resume, and replay exactly", async () => {
  await assertStagedGoalPlanGroupChoice("keep_account");
});

test("staged keep_guest choice survives a committed chunk, resume, and replay exactly", async () => {
  await assertStagedGoalPlanGroupChoice("keep_guest");
});

test("staged preview rejects a goal-only guest bundle before promotion", async () => {
  const auth = await createRegisteredAuthUser(context);
  const track = "aws-certified-solutions-architect-associate";
  const accountPair = goalPlanRecords(track, "2027-09-09");
  const seed = await seedAccountGoalPlan(auth, accountPair);
  const guestGoal = goalPlanRecords(track, "2027-10-10")[0]!;
  const sessionId = "staged-goal-only-keep-guest";
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const chunkBase = { chunkId: "chunk-0", index: 0, recordKeys: [adoptionTransferRecordKey(guestGoal)], bytes: 512 };
  const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
  const start = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { canonicalVersion, sessionId, idempotencyKey: sessionId, guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } });
  assert.equal(start.statusCode, 200, JSON.stringify(start.json()));
  const upload = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/upload`, headers, payload: { canonicalVersion, deviceId, chunk, records: [guestGoal] } });
  assert.equal(upload.statusCode, 200, JSON.stringify(upload.json()));
  const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records: [guestGoal], chunks: [chunk] });
  const seal = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/seal`, headers, payload: { canonicalVersion, deviceId, snapshotFingerprint, recordCount: 1, chunkCount: 1 } });
  assert.equal(seal.statusCode, 200, JSON.stringify(seal.json()));
  const preview = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/preview`, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(preview.statusCode, 409, JSON.stringify(preview.json()));
  assert.deepEqual(preview.json(), { error: { code: "adoption_transfer_track_group_incomplete" } });
  assert.equal((await transferRefFor(auth.userId, sessionId).get()).data()?.previewFingerprint, undefined);
  const source = await context.stores.progress.readSnapshot(auth.userId);
  assert.equal(source.accountRevision, seed.accountRevision);
  assert.deepEqual(source.records.map((record) => record.fingerprint).sort(), accountPair.map((record) => record.fingerprint).sort());
  assert.equal((await firestore().collection("users").doc(auth.userId).collection("syncMetadata").doc("account").get()).data()?.generation ?? 0, 0);
});

test("staged group choice preserves account or guest tombstones as one atomic bundle", async () => {
  const track = "aws-certified-solutions-architect-associate";
  for (const resolution of ["keep_account", "keep_guest"] as const) {
    const auth = await createRegisteredAuthUser(context);
    const accountPair = goalPlanRecords(track, "2027-09-09");
    const seed = await seedAccountGoalPlan(auth, accountPair);
    const tombstoneState = { deleted: true };
    const guestTombstones: GuestMergeRecord[] = (["goal", "learning_plan"] as const).map((recordType) => ({
      recordId: track,
      recordType,
      trackId: track,
      state: tombstoneState,
      version: 0,
      fingerprint: createMergeRecordFingerprint({ recordId: track, recordType, trackId: track, state: tombstoneState }),
    }));
    const sessionId = `staged-group-tombstone-${resolution}`;
    const { headers, confirm } = await prepareConfirmedTransfer(auth, sessionId, guestTombstones, [{ groupId: `track:${track}`, resolution }]);
    const apply = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: confirm.json().decisionFingerprint } });
    assert.equal(apply.statusCode, 200, JSON.stringify(apply.json()));
    const operation = (await transferRefFor(auth.userId, sessionId).get()).data()!;
    const target = await firestore().collection("users").doc(auth.userId).collection("progressGenerations").doc(String(operation.targetGeneration)).collection("records").get();
    assert.equal(target.size, 2);
    const rows = target.docs.map((document) => document.data());
    if (resolution === "keep_account") {
      assert.equal(operation.applyChangeCount, 0);
      assert.equal(operation.accountRevision, seed.accountRevision);
      assert.deepEqual(rows.map((row) => row.fingerprint).sort(), seed.records.map((record) => record.fingerprint).sort());
    } else {
      assert.equal(operation.applyChangeCount, 2);
      assert.equal(operation.accountRevision, seed.accountRevision + 2);
      assert.ok(rows.every((row) => row.state.deleted === true && row.version === 2));
    }
  }
});

test("staged keep_account makes no changes when a conflicting group shares one exact member", async () => {
  const auth = await createRegisteredAuthUser(context);
  const track = "aws-certified-solutions-architect-associate";
  const accountPair = goalPlanRecords(track, "2027-09-09");
  const seed = await seedAccountGoalPlan(auth, accountPair);
  const guestPair = goalPlanRecords(track, "2027-09-09", 1, 2);
  const sessionId = "staged-group-unchanged-member";
  const { headers, confirm, preview } = await prepareConfirmedTransfer(auth, sessionId, guestPair, [{ groupId: `track:${track}`, resolution: "keep_account" }]);
  assert.equal(preview.json().preview.goalPlanConflictGroups.length, 1);
  const apply = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: confirm.json().decisionFingerprint } });
  assert.equal(apply.statusCode, 200, JSON.stringify(apply.json()));
  const operation = (await transferRefFor(auth.userId, sessionId).get()).data()!;
  assert.equal(operation.applyChangeCount, 0);
  assert.equal(operation.accountRevision, seed.accountRevision);
  const target = await firestore().collection("users").doc(auth.userId).collection("progressGenerations").doc(String(operation.targetGeneration)).collection("records").get();
  assert.equal(target.size, 2);
  assert.deepEqual(target.docs.map((document) => document.data().fingerprint).sort(), seed.records.map((record) => record.fingerprint).sort());
});

test("staged preview rejects a plan-only guest bundle before promotion", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const track = "aws-certified-solutions-architect-associate";
  const planOnly = goalPlanRecords(track, "2027-10-10")[1]!;
  const sessionId = "staged-plan-only-invalid";
  const chunkBase = { chunkId: "chunk-0", index: 0, recordKeys: [adoptionTransferRecordKey(planOnly)], bytes: 512 };
  const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
  const start = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { canonicalVersion, sessionId, idempotencyKey: sessionId, guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } });
  assert.equal(start.statusCode, 200, JSON.stringify(start.json()));
  const upload = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/upload`, headers, payload: { canonicalVersion, deviceId, chunk, records: [planOnly] } });
  assert.equal(upload.statusCode, 200, JSON.stringify(upload.json()));
  const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records: [planOnly], chunks: [chunk] });
  const seal = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/seal`, headers, payload: { canonicalVersion, deviceId, snapshotFingerprint, recordCount: 1, chunkCount: 1 } });
  assert.equal(seal.statusCode, 200, JSON.stringify(seal.json()));
  const preview = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/preview`, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(preview.statusCode, 400, JSON.stringify(preview.json()));
  assert.deepEqual(preview.json(), { error: { code: "goal_plan_bundle_invalid" } });
  const operation = (await transferRefFor(auth.userId, sessionId).get()).data();
  assert.equal(operation?.state, "result_building");
  assert.equal(operation?.previewFingerprint, undefined);
  assert.equal((await firestore().collection("users").doc(auth.userId).collection("syncMetadata").doc("account").get()).data()?.generation ?? 0, 0);
});

test("apply fences reservation, every chunk, and empty-transfer promotion against authorization rotation", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };

  const reserveSession = "apply-rotation-reservation";
  const reserve = await prepareConfirmedTransfer(auth, reserveSession, [learningRecord("reserve-record", "reserve-track")]);
  const reserveApp = buildTransferTransactionRotationApp(auth.userId, 1);
  const reserveResult = await reserveApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${reserveSession}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: reserve.confirm.json().decisionFingerprint } });
  assert.equal(reserveResult.statusCode, 409, JSON.stringify(reserveResult.json()));
  assert.deepEqual(reserveResult.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await transferRefFor(auth.userId, reserveSession).get()).data()?.state, "preview_ready");
  assert.equal((await firestore().collection("users").doc(auth.userId).collection("progressGenerations").doc("1").get()).exists, false);
  await reserveApp.close();

  await firestore().collection("users").doc(auth.userId).update({ authorizationGeneration: 1, authorizationState: "active" });
  const chunkSession = "apply-rotation-between-chunks";
  const chunkRecords = Array.from({ length: 201 }, (_, index) => learningRecord(`chunk-record-${index}`, `chunk-track-${index}`));
  const chunk = await prepareConfirmedTransfer(auth, chunkSession, chunkRecords);
  const chunkApp = buildTransferTransactionRotationApp(auth.userId, 3);
  const chunkResult = await chunkApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${chunkSession}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: chunk.confirm.json().decisionFingerprint } });
  assert.equal(chunkResult.statusCode, 409, JSON.stringify(chunkResult.json()));
  assert.deepEqual(chunkResult.json(), { error: { code: "authorization_generation_conflict" } });
  const chunkOperation = (await transferRefFor(auth.userId, chunkSession).get()).data();
  assert.equal(chunkOperation?.state, "applying");
  assert.equal(chunkOperation?.applyCursor, 200);
  assert.equal((await firestore().collection("users").doc(auth.userId).collection("progressGenerations").doc(String(chunkOperation?.targetGeneration)).collection("records").get()).size, 200);
  await chunkApp.close();

  await firestore().collection("users").doc(auth.userId).collection("syncMetadata").doc("account").set({ adoptionPromotionLeaseExpiresAt: Timestamp.fromMillis(Date.now() - 1) }, { merge: true });
  await firestore().collection("users").doc(auth.userId).update({ authorizationGeneration: 1, authorizationState: "active" });
  const emptySession = "apply-rotation-final-promotion";
  const empty = await prepareConfirmedTransfer(auth, emptySession, []);
  const finalApp = buildTransferTransactionRotationApp(auth.userId, 2);
  const finalResult = await finalApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${emptySession}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: empty.confirm.json().decisionFingerprint } });
  assert.equal(finalResult.statusCode, 409, JSON.stringify(finalResult.json()));
  assert.deepEqual(finalResult.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await transferRefFor(auth.userId, emptySession).get()).data()?.state, "applying");
  assert.equal((await firestore().collection("users").doc(auth.userId).collection("syncMetadata").doc("account").get()).data()?.generation ?? 0, 0);
  await finalApp.close();
});

test("apply resumes an expired same-session lease only while the pinned progress revision still matches", async () => {
  const auth = await createRegisteredAuthUser(context);
  const sessionId = "apply-expired-lease-resume";
  const { headers, confirm } = await prepareConfirmedTransfer(auth, sessionId, [learningRecord("expired-lease-record", "expired-lease-track")]);
  const metadataRef = firestore().collection("users").doc(auth.userId).collection("syncMetadata").doc("account");
  const operationRef = transferRefFor(auth.userId, sessionId);
  const targetRef = firestore().collection("users").doc(auth.userId).collection("progressGenerations").doc("1");
  await firestore().runTransaction(async (transaction) => {
    const operation = await transaction.get(operationRef);
    const metadata = await transaction.get(metadataRef);
    const operationData = operation.data()!;
    transaction.update(operationRef, { state: "applying", targetGeneration: 1, applyCursor: 0, applyTotal: 1, applyChangeCount: 1, applyAccountRevision: 1, applySourceGeneration: 0, applySourceRevision: 0 });
    transaction.set(targetRef, { userId: auth.userId, generation: 1, sourceSessionId: sessionId, state: "building", createdAt: operationData.createdAt, expiresAt: operationData.expiresAt });
    transaction.set(metadataRef, { ...metadata.data(), adoptionPromotionSessionId: sessionId, adoptionPromotionTargetGeneration: 1, adoptionPromotionSourceGeneration: 0, adoptionPromotionSourceRevision: 0, adoptionPromotionLeaseExpiresAt: Timestamp.fromMillis(Date.now() - 1) }, { merge: true });
  });
  const apply = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: confirm.json().decisionFingerprint } });
  assert.equal(apply.statusCode, 200, JSON.stringify(apply.json()));
  assert.equal(apply.json().state, "complete");
  assert.equal(apply.json().applyCursor, 1);
});

test("sync loses during an active transfer lease and wins after expiry without allowing stale promotion", async () => {
  const auth = await createRegisteredAuthUser(context);
  const sessionId = "apply-sync-versus-lease";
  const { headers, confirm } = await prepareConfirmedTransfer(auth, sessionId, [learningRecord("lease-guest-record", "lease-guest-track")]);
  const userRef = firestore().collection("users").doc(auth.userId);
  const metadataRef = userRef.collection("syncMetadata").doc("account");
  const operationRef = transferRefFor(auth.userId, sessionId);
  const operation = (await operationRef.get()).data()!;
  const targetGeneration = Number(operation.targetGeneration);
  const targetGenerationRef = userRef.collection("progressGenerations").doc(String(targetGeneration));
  await firestore().runTransaction(async (transaction) => {
    const currentOperation = await transaction.get(operationRef);
    const currentMetadata = await transaction.get(metadataRef);
    const data = currentOperation.data()!;
    transaction.update(operationRef, { state: "applying", targetGeneration, applyCursor: 0, applyTotal: 1, applyChangeCount: 1, applyAccountRevision: 1, applySourceGeneration: 0, applySourceRevision: 0 });
    transaction.set(targetGenerationRef, { userId: auth.userId, generation: targetGeneration, sourceSessionId: sessionId, state: "building", createdAt: data.createdAt, expiresAt: data.expiresAt });
    transaction.set(metadataRef, { ...currentMetadata.data(), adoptionPromotionSessionId: sessionId, adoptionPromotionTargetGeneration: targetGeneration, adoptionPromotionSourceGeneration: 0, adoptionPromotionSourceRevision: 0, adoptionPromotionLeaseExpiresAt: Timestamp.fromMillis(Date.now() + 60_000) }, { merge: true });
  });
  const state = attemptState("lease-sync-record", "lease-sync-track", "from-sync");
  const mutation = { mutationId: "lease-race-mutation-0001", kind: "item" as const, recordType: "training_attempt" as const, trackId: "lease-sync-track", targetId: "lease-sync-record", expectedVersion: null, fingerprint: createMergeRecordFingerprint({ recordType: "training_attempt", recordId: "lease-sync-record", trackId: "lease-sync-track", state }), state };
  await assert.rejects(context.stores.progress.applyBatch(auth.userId, 1, deviceId, 0, [mutation], { sessionId: "lease-sync-session", batchId: "lease-sync-batch", highWatermark: 1 }), /progress_generation_conflict/u);

  await metadataRef.set({ adoptionPromotionLeaseExpiresAt: Timestamp.fromMillis(Date.now() - 1) }, { merge: true });
  const sync = await context.stores.progress.applyBatch(auth.userId, 1, deviceId, 0, [mutation], { sessionId: "lease-sync-session", batchId: "lease-sync-batch", highWatermark: 1 });
  assert.equal(sync.applied.length, 1);
  const apply = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: confirm.json().decisionFingerprint } });
  assert.equal(apply.statusCode, 409, JSON.stringify(apply.json()));
  assert.deepEqual(apply.json(), { error: { code: "adoption_transfer_preview_stale" } });
  assert.equal((await operationRef.get()).data()?.state, "applying");
  assert.equal((await metadataRef.get()).data()?.generation ?? 0, 0);
});

test("transfer status rejects a stale bearer after authorization rotation", async () => {
  const auth = await createRegisteredAuthUser(context);
  const sessionId = "stale-transfer-status";
  await prepareConfirmedTransfer(auth, sessionId, [learningRecord("status-record", "status-track")]);
  await firestore().collection("users").doc(auth.userId).update({ authorizationGeneration: 2 });
  const status = await context.app.inject({ method: "GET", url: `/v1/account-data/adoption/transfer/${sessionId}/status?deviceId=${deviceId}`, headers: { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  assert.equal(status.statusCode, 401, JSON.stringify(status.json()));
  assert.deepEqual(status.json(), { error: { code: "authorization_generation_stale" } });
});

test("apply splits target transactions by both document count and serialized write bytes", async () => {
  const auth = await createRegisteredAuthUser(context);
  const userRef = firestore().collection("users").doc(auth.userId);
  const storedAt = Timestamp.now();
  const seedValue = "x".repeat(40_000);
  for (let offset = 0; offset < 190; offset += 50) {
    const batch = firestore().batch();
    for (let index = offset; index < Math.min(offset + 50, 190); index += 1) {
      const record = learningRecord(`large-remote-${index}`, `large-track-${index}`, seedValue);
      batch.set(userRef.collection("progress").doc(progressDocumentId({ kind: "item", recordType: record.recordType, targetId: record.recordId, trackId: record.trackId })), { kind: "item", recordType: record.recordType, trackId: record.trackId, targetId: record.recordId, version: 0, fingerprint: record.fingerprint, state: record.state, lastMutationId: `seed_large_${String(index).padStart(4, "0")}_mutation`, updatedAt: storedAt });
    }
    await batch.commit();
  }
  const sessionId = "apply-byte-bounded-chunks";
  const { headers, confirm } = await prepareConfirmedTransfer(auth, sessionId, [learningRecord("byte-bound-guest", "byte-bound-guest-track")]);
  const chunkStats: Array<{ count: number; bytes: number }> = [];
  const measuredApp = buildTransferWriteMeasuringApp(auth.userId, chunkStats);
  const apply = await measuredApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload: { canonicalVersion, deviceId, decisionFingerprint: confirm.json().decisionFingerprint } });
  assert.equal(apply.statusCode, 200, JSON.stringify(apply.json()));
  assert.equal(apply.json().applyCursor, 191);
  assert.equal(chunkStats.length, 2);
  assert.ok(chunkStats.every((chunk) => chunk.count > 0 && chunk.count <= 200 && chunk.bytes <= 6 * 1024 * 1024), JSON.stringify(chunkStats));
  assert.equal(chunkStats.reduce((sum, chunk) => sum + chunk.count, 0), 191);
  await measuredApp.close();
});

test("concurrent apply requests leave one complete generation and can be safely replayed", async () => {
  const auth = await createRegisteredAuthUser(context);
  const sessionId = "apply-concurrent-retry";
  const records = Array.from({ length: 201 }, (_, index) => learningRecord(`concurrent-record-${index}`, `concurrent-track-${index}`));
  const { headers, confirm } = await prepareConfirmedTransfer(auth, sessionId, records);
  const payload = { canonicalVersion, deviceId, decisionFingerprint: confirm.json().decisionFingerprint };
  const results = await Promise.all([
    context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload }),
    context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload }),
  ]);
  assert.ok(results.some((result) => result.statusCode === 200), JSON.stringify(results.map((result) => ({ statusCode: result.statusCode, body: result.json() }))));
  assert.ok(results.every((result) => result.statusCode === 200 || (result.statusCode === 409 && result.json().error?.code === "adoption_transfer_apply_cursor_conflict")), JSON.stringify(results.map((result) => ({ statusCode: result.statusCode, body: result.json() }))));
  const replay = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers, payload });
  assert.equal(replay.statusCode, 200, JSON.stringify(replay.json()));
  assert.equal(replay.json().state, "complete");
  const operation = (await transferRefFor(auth.userId, sessionId).get()).data();
  assert.equal((await firestore().collection("users").doc(auth.userId).collection("progressGenerations").doc(String(operation?.targetGeneration)).collection("records").get()).size, records.length);
});

test("transfer decision lock and child rows recheck account authorization generation", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const sessionId = "rotation-transfer-confirm";
  const records = [learningRecord("confirm-rotation-record", "confirm-rotation-track")];
  const chunkBase = { chunkId: "chunk-0", index: 0, recordKeys: records.map(adoptionTransferRecordKey), bytes: 64 };
  const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
  const start = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { canonicalVersion, sessionId, idempotencyKey: sessionId, guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } });
  assert.equal(start.statusCode, 200, JSON.stringify(start.json()));
  const upload = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/upload`, headers, payload: { canonicalVersion, deviceId, chunk, records } });
  assert.equal(upload.statusCode, 200, JSON.stringify(upload.json()));
  const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records, chunks: [chunk] });
  const seal = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/seal`, headers, payload: { canonicalVersion, deviceId, snapshotFingerprint, recordCount: records.length, chunkCount: 1 } });
  assert.equal(seal.statusCode, 200, JSON.stringify(seal.json()));
  const preview = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/preview`, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.json()));
  const confirmation = { canonicalVersion, deviceId, operationId: preview.json().preview.operationId as string, previewFingerprint: preview.json().preview.fingerprint as string, resolutions: [], groupChoices: [] };
  const userRef = firestore().collection("users").doc(auth.userId);
  let transactionCount = 0;
  const racedDb = new Proxy(firestore(), {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "runTransaction" && typeof value === "function") {
        return async (...args: unknown[]) => {
          transactionCount += 1;
          if (transactionCount === 2) await userRef.update({ authorizationGeneration: 2 });
          return (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Firestore;
  const progress = new FirestoreProgressStore(racedDb);
  const app = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, progress },
  });
  const confirm = await app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/confirm`, headers, payload: confirmation });
  assert.equal(transactionCount, 2);
  assert.equal(confirm.statusCode, 409, JSON.stringify(confirm.json()));
  assert.deepEqual(confirm.json(), { error: { code: "authorization_generation_conflict" } });
  const transferRef = transferRefFor(auth.userId, sessionId);
  assert.equal(typeof (await transferRef.get()).data()?.decisionFingerprint, "string");
  assert.equal((await transferRef.collection("decisions").get()).size, 0);

  const refreshed = await setAuthCustomClaimsAndSignIn(auth, { authorizationGeneration: 2 });
  const freshHeaders = { ...headers, authorization: `Bearer ${refreshed.idToken}` };
  const resumed = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/confirm`, headers: freshHeaders, payload: confirmation });
  assert.equal(resumed.statusCode, 200, JSON.stringify(resumed.json()));
  assert.equal(typeof resumed.json().decisionFingerprint, "string");
  assert.equal((await transferRef.collection("decisions").get()).size, 1);

  const alternate = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/confirm`, headers: freshHeaders, payload: { ...confirmation, decisionFingerprint: "a".repeat(64) } });
  assert.equal(alternate.statusCode, 409, JSON.stringify(alternate.json()));

  const rejected = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/confirm`, headers, payload: confirmation });
  assert.equal(rejected.statusCode, 401, JSON.stringify(rejected.json()));
  assert.deepEqual(rejected.json(), { error: { code: "authorization_generation_stale" } });
  await app.close();
});

test("transfer decision chunks stop on rotation and a fresh generation resumes the same decision", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const accountRef = firestore().collection("users").doc(auth.userId);
  const records = Array.from({ length: 201 }, (_, index) => {
    const recordId = `chunk-conflict-${index}`;
    const state = attemptState(recordId, trackId, "guest");
    return { recordType: "training_attempt" as const, recordId, trackId, state, version: 0, fingerprint: createMergeRecordFingerprint({ recordId, recordType: "training_attempt", trackId, state }) };
  });
  const storedAt = Timestamp.now();
  const existing = records.map((record) => {
    const state = attemptState(record.recordId, record.trackId, "account");
    const accountRecord = { ...record, state, fingerprint: createMergeRecordFingerprint({ recordId: record.recordId, recordType: record.recordType, state, trackId: record.trackId }) };
    return { ...accountRecord, targetId: record.recordId, refId: progressDocumentId({ kind: "item", recordType: "training_attempt", targetId: record.recordId, trackId: record.trackId }) };
  });
  const seed = firestore().batch();
  for (const record of existing) {
    const { refId, ...value } = record;
    seed.set(accountRef.collection("progress").doc(refId), { ...value, kind: "item", version: 0, lastMutationId: `seed-${value.recordId}`, updatedAt: storedAt });
  }
  await seed.commit();

  const sessionId = "rotation-between-confirm-chunks";
  const chunkBase = { chunkId: "chunk-0", index: 0, recordKeys: records.map(adoptionTransferRecordKey), bytes: 64 };
  const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
  const start = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { canonicalVersion, sessionId, idempotencyKey: sessionId, guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } });
  assert.equal(start.statusCode, 200, JSON.stringify(start.json()));
  const upload = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/upload`, headers, payload: { canonicalVersion, deviceId, chunk, records } });
  assert.equal(upload.statusCode, 200, JSON.stringify(upload.json()));
  const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records, chunks: [chunk] });
  const seal = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/seal`, headers, payload: { canonicalVersion, deviceId, snapshotFingerprint, recordCount: records.length, chunkCount: 1 } });
  assert.equal(seal.statusCode, 200, JSON.stringify(seal.json()));
  const preview = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/preview`, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.json()));
  assert.equal(preview.json().preview.conflicts.length, records.length);
  const confirmation = { canonicalVersion, deviceId, operationId: preview.json().preview.operationId as string, previewFingerprint: preview.json().preview.fingerprint as string, resolutions: preview.json().preview.conflicts.map((conflict: { conflictId: string }) => ({ conflictId: conflict.conflictId, resolution: "keep_guest" as const })), groupChoices: [] };
  const userRef = firestore().collection("users").doc(auth.userId);
  let transactionCount = 0;
  const racedDb = new Proxy(firestore(), {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "runTransaction" && typeof value === "function") {
        return async (...args: unknown[]) => {
          transactionCount += 1;
          if (transactionCount === 3) await userRef.update({ authorizationGeneration: 2 });
          return (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Firestore;
  const progress = new FirestoreProgressStore(racedDb);
  const app = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, progress },
  });
  const interrupted = await app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/confirm`, headers, payload: confirmation });
  assert.equal(transactionCount, 3);
  assert.equal(interrupted.statusCode, 409, JSON.stringify(interrupted.json()));
  assert.deepEqual(interrupted.json(), { error: { code: "authorization_generation_conflict" } });
  const transferRef = transferRefFor(auth.userId, sessionId);
  assert.equal((await transferRef.collection("decisions").get()).size, 200);
  assert.equal(Object.keys((await transferRef.get()).data()?.decisionChunkFingerprints ?? {}).length, 1);

  const refreshed = await setAuthCustomClaimsAndSignIn(auth, { authorizationGeneration: 2 });
  const freshHeaders = { ...headers, authorization: `Bearer ${refreshed.idToken}` };
  const resumed = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/confirm`, headers: freshHeaders, payload: confirmation });
  assert.equal(resumed.statusCode, 200, JSON.stringify(resumed.json()));
  assert.equal((await transferRef.collection("decisions").get()).size, 202);
  assert.equal(Object.keys((await transferRef.get()).data()?.decisionChunkFingerprints ?? {}).length, 2);
  await app.close();
});

test("the retired transfer route and retired query selector are unavailable", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const oldRoute = await context.app.inject({ method: "POST", url: "/v3/account-data/adoption/start", headers, payload: {} });
  assert.equal(oldRoute.statusCode, 404);
  const oldQuery = await context.app.inject({ method: "GET", url: "/v1/progress?protocolVersion=2", headers });
  assert.equal(oldQuery.statusCode, 400);
  const accountId = (await context.app.inject({ method: "GET", url: "/v1/me", headers })).json().user.id as string;
  const state = attemptState("retired", trackId);
  await firestore().collection("users").doc(accountId).collection("progress").doc("retired").set({
    kind: "item",
    recordType: "training_attempt",
    trackId,
    targetId: "retired",
    version: 0,
    fingerprint: createMergeRecordFingerprint({ recordId: "retired", recordType: "training_attempt", trackId, state }),
    state,
    lastMutationId: "retired-mutation",
    updatedAt: new Date().toISOString(),
    protocolVersion: 3,
    contentIdentitySchema: "patternly:content-identity:v2",
  });
  const legacyRead = await context.app.inject({ method: "GET", url: "/v1/progress", headers });
  assert.equal(legacyRead.statusCode, 409);
  assert.deepEqual(legacyRead.json(), { error: { code: "content_identity_schema_conflict" } });
});

test("transfer start, upload, and seal fence account rotation after request authentication", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const userRef = firestore().collection("users").doc(auth.userId);
  const startPayload = { canonicalVersion, sessionId: "rotation-transfer-start", idempotencyKey: "rotation-transfer-start", guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId };
  const startApp = buildTransferRotationApp(auth.userId, "startAdoptionTransfer", "authorizationGeneration");
  const start = await startApp.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: startPayload });
  assert.equal(start.statusCode, 409, JSON.stringify(start.json()));
  assert.deepEqual(start.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await firestore().collection("accounts").doc(auth.userId).get()).exists, false);
  assert.equal((await firestore().collection("users").doc(auth.userId).collection("syncMetadata").doc("account").get()).exists, false);
  assert.equal((await firestore().collection("accounts").doc(auth.userId).collection("adoptionTransfers").doc(startPayload.sessionId).get()).exists, false);
  assert.equal((await firestore().collection("accounts").doc(auth.userId).collection("adoptionTransferIdempotency").get()).size, 0);
  await startApp.close();

  await userRef.update({ authorizationGeneration: 1, authorizationState: "active" });
  const uploadSessionId = "rotation-transfer-upload";
  const initialStart = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { ...startPayload, sessionId: uploadSessionId, idempotencyKey: uploadSessionId } });
  assert.equal(initialStart.statusCode, 200, JSON.stringify(initialStart.json()));
  const uploadRecords = [learningRecord("rotation-upload-record", "rotation-track")];
  const uploadChunkBase = { chunkId: "chunk-0", index: 0, recordKeys: uploadRecords.map(adoptionTransferRecordKey), bytes: 64 };
  const uploadChunk = { ...uploadChunkBase, fingerprint: createAdoptionTransferChunkFingerprint(uploadChunkBase) };
  const uploadApp = buildTransferRotationApp(auth.userId, "uploadAdoptionTransfer", "authorizationGeneration");
  const upload = await uploadApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${uploadSessionId}/upload`, headers, payload: { canonicalVersion, deviceId, chunk: uploadChunk, records: uploadRecords } });
  assert.equal(upload.statusCode, 409, JSON.stringify(upload.json()));
  assert.deepEqual(upload.json(), { error: { code: "authorization_generation_conflict" } });
  const transferRef = firestore().collection("accounts").doc(auth.userId).collection("adoptionTransfers").doc(uploadSessionId);
  assert.equal((await transferRef.collection("chunks").get()).size, 0);
  assert.equal((await transferRef.collection("records").get()).size, 0);
  assert.equal((await transferRef.get()).data()?.recordCount, 0);
  assert.equal((await transferRef.get()).data()?.chunkCount, 0);
  await uploadApp.close();

  await userRef.update({ authorizationGeneration: 1, authorizationState: "active" });
  const sealSessionId = "rotation-transfer-seal";
  const sealStart = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { ...startPayload, sessionId: sealSessionId, idempotencyKey: sealSessionId } });
  assert.equal(sealStart.statusCode, 200, JSON.stringify(sealStart.json()));
  const sealRecords = [learningRecord("rotation-seal-record", "rotation-seal-track")];
  const sealChunkBase = { chunkId: "chunk-0", index: 0, recordKeys: sealRecords.map(adoptionTransferRecordKey), bytes: 64 };
  const sealChunk = { ...sealChunkBase, fingerprint: createAdoptionTransferChunkFingerprint(sealChunkBase) };
  const seededUpload = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sealSessionId}/upload`, headers, payload: { canonicalVersion, deviceId, chunk: sealChunk, records: sealRecords } });
  assert.equal(seededUpload.statusCode, 200, JSON.stringify(seededUpload.json()));
  const sealPayload = { canonicalVersion, deviceId, snapshotFingerprint: createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records: sealRecords, chunks: [sealChunk] }), recordCount: 1, chunkCount: 1 };
  const sealApp = buildTransferRotationApp(auth.userId, "sealAdoptionTransfer", "authorizationGeneration");
  const seal = await sealApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sealSessionId}/seal`, headers, payload: sealPayload });
  assert.equal(seal.statusCode, 409, JSON.stringify(seal.json()));
  assert.deepEqual(seal.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await transferRefFor(auth.userId, sealSessionId).get()).data()?.state, "collecting");
  await sealApp.close();

  await userRef.update({ authorizationGeneration: 1, authorizationState: "active" });
  const stale = await setAuthCustomClaimsAndSignIn(auth, { authorizationGeneration: 2 });
  const staleStart = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers: { ...headers, authorization: `Bearer ${stale.idToken}` }, payload: { ...startPayload, sessionId: "rotation-transfer-stale-token", idempotencyKey: "rotation-transfer-stale-token" } });
  assert.equal(staleStart.statusCode, 401, JSON.stringify(staleStart.json()));
  assert.deepEqual(staleStart.json(), { error: { code: "authorization_generation_stale" } });

  const inactiveApp = buildTransferRotationApp(auth.userId, "startAdoptionTransfer", "authorizationState");
  const inactiveStart = await inactiveApp.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { ...startPayload, sessionId: "rotation-transfer-inactive", idempotencyKey: "rotation-transfer-inactive" } });
  assert.equal(inactiveStart.statusCode, 401, JSON.stringify(inactiveStart.json()));
  assert.deepEqual(inactiveStart.json(), { error: { code: "account_deleted" } });
  assert.equal((await transferRefFor(auth.userId, "rotation-transfer-inactive").get()).exists, false);
  await inactiveApp.close();
});

test("transfer seal rechecks authorization generation in its final transaction", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const sessionId = "rotation-between-seal-transactions";
  const records = [learningRecord("between-seal-record", "between-seal-track")];
  const chunkBase = { chunkId: "chunk-0", index: 0, recordKeys: records.map(adoptionTransferRecordKey), bytes: 64 };
  const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
  const start = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { canonicalVersion, sessionId, idempotencyKey: sessionId, guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } });
  assert.equal(start.statusCode, 200, JSON.stringify(start.json()));
  const upload = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/upload`, headers, payload: { canonicalVersion, deviceId, chunk, records } });
  assert.equal(upload.statusCode, 200, JSON.stringify(upload.json()));

  const userRef = firestore().collection("users").doc(auth.userId);
  let transactionCount = 0;
  const racedDb = new Proxy(firestore(), {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "runTransaction" && typeof value === "function") {
        return async (...args: unknown[]) => {
          transactionCount += 1;
          if (transactionCount === 2) await userRef.update({ authorizationGeneration: 2 });
          return (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Firestore;
  const progress = new FirestoreProgressStore(racedDb);
  const app = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, progress },
  });
  const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records, chunks: [chunk] });
  const seal = await app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/seal`, headers, payload: { canonicalVersion, deviceId, snapshotFingerprint, recordCount: records.length, chunkCount: 1 } });
  assert.equal(transactionCount, 2);
  assert.equal(seal.statusCode, 409, JSON.stringify(seal.json()));
  assert.deepEqual(seal.json(), { error: { code: "authorization_generation_conflict" } });
  const stored = (await transferRefFor(auth.userId, sessionId).get()).data();
  assert.equal(stored?.state, "sealing");
  assert.equal(stored?.snapshotFingerprint, null);
  await app.close();
});

test("transfer preview fences reservation, finalization, and ready replay", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const userRef = firestore().collection("users").doc(auth.userId);

  async function seedSealedTransfer(sessionId: string) {
    const records = [learningRecord(`preview-${sessionId}`, `preview-track-${sessionId}`, "preview-value")];
    const start = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { canonicalVersion, sessionId, idempotencyKey: sessionId, guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } });
    assert.equal(start.statusCode, 200, JSON.stringify(start.json()));
    const chunkBase = { chunkId: "chunk-0", index: 0, recordKeys: records.map(adoptionTransferRecordKey), bytes: 64 };
    const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
    const upload = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/upload`, headers, payload: { canonicalVersion, deviceId, chunk, records } });
    assert.equal(upload.statusCode, 200, JSON.stringify(upload.json()));
    const chunks = [chunk];
    const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records, chunks });
    const seal = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/seal`, headers, payload: { canonicalVersion, deviceId, snapshotFingerprint, recordCount: records.length, chunkCount: chunks.length } });
    assert.equal(seal.statusCode, 200, JSON.stringify(seal.json()));
    return records;
  }

  // Rotation after request authentication but before the reservation transaction must not create result data.
  const beforeStage = "preview-rotate-before-stage";
  await seedSealedTransfer(beforeStage);
  const beforeStageApp = buildTransferRotationApp(auth.userId, "previewAdoptionTransfer", "authorizationGeneration");
  const beforeStageResponse = await beforeStageApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${beforeStage}/preview`, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(beforeStageResponse.statusCode, 409, JSON.stringify(beforeStageResponse.json()));
  assert.deepEqual(beforeStageResponse.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await transferRefFor(auth.userId, beforeStage).get()).data()?.state, "sealed");
  assert.equal((await transferRefFor(auth.userId, beforeStage).collection("results").get()).size, 0);
  await beforeStageApp.close();

  await userRef.update({ authorizationGeneration: 1, authorizationState: "active" });
  // Rotation after the one bounded result transaction but before finalization leaves no ready preview.
  const beforeFinalization = "preview-rotate-before-finalization";
  await seedSealedTransfer(beforeFinalization);
  let transactionCount = 0;
  const racedDb = new Proxy(firestore(), {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "runTransaction" && typeof value === "function") {
        return async (...args: unknown[]) => {
          transactionCount += 1;
          if (transactionCount === 3) await userRef.update({ authorizationGeneration: 2 });
          return (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Firestore;
  const racedProgress = new FirestoreProgressStore(racedDb);
  const chunkApp = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, progress: racedProgress },
  });
  const beforeFinalizationResponse = await chunkApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${beforeFinalization}/preview`, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(transactionCount, 3);
  assert.equal(beforeFinalizationResponse.statusCode, 409, JSON.stringify(beforeFinalizationResponse.json()));
  assert.deepEqual(beforeFinalizationResponse.json(), { error: { code: "authorization_generation_conflict" } });
  const partial = (await transferRefFor(auth.userId, beforeFinalization).get()).data();
  assert.equal(partial?.state, "result_building");
  assert.equal(partial?.previewFingerprint, undefined);
  assert.equal((await transferRefFor(auth.userId, beforeFinalization).collection("results").get()).size, 1);
  await chunkApp.close();

  await userRef.update({ authorizationGeneration: 1, authorizationState: "active" });
  // The retry fills any missing chunk, then finalization stores preview_ready.
  const retry = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${beforeFinalization}/preview`, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.json()));
  assert.equal((await transferRefFor(auth.userId, beforeFinalization).collection("results").get()).size, 1);
  assert.equal((await transferRefFor(auth.userId, beforeFinalization).get()).data()?.state, "preview_ready");

  // A ready preview replay also validates authorization before returning its stored result.
  const replayApp = buildTransferRotationApp(auth.userId, "previewAdoptionTransfer", "authorizationGeneration");
  const replay = await replayApp.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${beforeFinalization}/preview`, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(replay.statusCode, 409, JSON.stringify(replay.json()));
  assert.deepEqual(replay.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await transferRefFor(auth.userId, beforeFinalization).get()).data()?.state, "preview_ready");
  await replayApp.close();
});

test("empty transfer preview fences finalization and replays without result chunks", async () => {
  const auth = await createRegisteredAuthUser(context);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const sessionId = "preview-empty-transfer";
  const start = await context.app.inject({ method: "POST", url: "/v1/account-data/adoption/transfer/start", headers, payload: { canonicalVersion, sessionId, idempotencyKey: sessionId, guestUserId, snapshotVersion: 1, expectedGeneration: 0, deviceId } });
  assert.equal(start.statusCode, 200, JSON.stringify(start.json()));
  const snapshotFingerprint = createAdoptionSnapshotSeal({ guestUserId, snapshotVersion: 1, records: [], chunks: [] });
  const seal = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/seal`, headers, payload: { canonicalVersion, deviceId, snapshotFingerprint, recordCount: 0, chunkCount: 0 } });
  assert.equal(seal.statusCode, 200, JSON.stringify(seal.json()));

  const userRef = firestore().collection("users").doc(auth.userId);
  let transactionCount = 0;
  const racedDb = new Proxy(firestore(), {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "runTransaction" && typeof value === "function") {
        return async (...args: unknown[]) => {
          transactionCount += 1;
          if (transactionCount === 2) await userRef.update({ authorizationGeneration: 2 });
          return (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Firestore;
  const racedProgress = new FirestoreProgressStore(racedDb);
  const racedApp = buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, progress: racedProgress },
  });
  const previewPath = `/v1/account-data/adoption/transfer/${sessionId}/preview`;
  const rotated = await racedApp.inject({ method: "POST", url: previewPath, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(transactionCount, 2);
  assert.equal(rotated.statusCode, 409, JSON.stringify(rotated.json()));
  assert.deepEqual(rotated.json(), { error: { code: "authorization_generation_conflict" } });
  assert.equal((await transferRefFor(auth.userId, sessionId).get()).data()?.state, "result_building");
  assert.equal((await transferRefFor(auth.userId, sessionId).collection("results").get()).size, 0);
  await racedApp.close();

  await userRef.update({ authorizationGeneration: 1, authorizationState: "active" });
  const preview = await context.app.inject({ method: "POST", url: previewPath, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.json()));
  assert.equal((await transferRefFor(auth.userId, sessionId).get()).data()?.state, "preview_ready");
  assert.equal((await transferRefFor(auth.userId, sessionId).collection("results").get()).size, 0);
  const replay = await context.app.inject({ method: "POST", url: previewPath, headers, payload: { canonicalVersion, deviceId } });
  assert.equal(replay.statusCode, 200, JSON.stringify(replay.json()));
  assert.equal(replay.json().preview.fingerprint, preview.json().preview.fingerprint);
  assert.equal((await transferRefFor(auth.userId, sessionId).get()).data()?.state, "preview_ready");
});

function transferRefFor(userId: string, sessionId: string) {
  return firestore().collection("accounts").doc(userId).collection("adoptionTransfers").doc(sessionId);
}

function buildTransferRotationApp(userId: string, method: "startAdoptionTransfer" | "uploadAdoptionTransfer" | "sealAdoptionTransfer" | "previewAdoptionTransfer", field: "authorizationGeneration" | "authorizationState") {
  const original = context.stores.progress;
  const userRef = firestore().collection("users").doc(userId);
  const progress = new Proxy(original, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property !== method || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await userRef.update(field === "authorizationGeneration" ? { authorizationGeneration: 2 } : { authorizationState: "rotating" });
        return (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, args);
      };
    },
  });
  return buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, progress },
  });
}

function buildTransferTransactionRotationApp(userId: string, rotateBeforeTransaction: number) {
  const userRef = firestore().collection("users").doc(userId);
  let transactionCount = 0;
  const racedDb = new Proxy(firestore(), {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "runTransaction" && typeof value === "function") {
        return async (...args: unknown[]) => {
          transactionCount += 1;
          if (transactionCount === rotateBeforeTransaction) await userRef.update({ authorizationGeneration: 2 });
          return (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Firestore;
  const progress = new FirestoreProgressStore(racedDb);
  return buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, progress },
  });
}

function buildTransferWriteMeasuringApp(userId: string, chunks: Array<{ count: number; bytes: number }>) {
  const baseDb = firestore();
  const targetPrefix = `users/${userId}/progressGenerations/`;
  const measuredDb = new Proxy(baseDb, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property !== "runTransaction" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        const callback = args[0] as (transaction: Transaction) => Promise<unknown>;
        let attempted: { count: number; bytes: number } | undefined;
        const result = await (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, [async (transaction: Transaction) => {
          let count = 0;
          let bytes = 0;
          const observed = new Proxy(transaction, {
            get(tx, txProperty) {
              const txValue = Reflect.get(tx, txProperty, tx) as unknown;
              if (txProperty === "set" && typeof txValue === "function") {
                return (...writeArgs: unknown[]) => {
                  const ref = writeArgs[0] as { path?: string } | undefined;
                  if (ref?.path?.startsWith(targetPrefix) && ref.path.includes("/records/")) {
                    count += 1;
                    bytes += Buffer.byteLength(JSON.stringify(writeArgs[1]), "utf8") + 512;
                  }
                  return (txValue as (...callArgs: unknown[]) => unknown).apply(tx, writeArgs);
                };
              }
              return typeof txValue === "function" ? txValue.bind(tx) : txValue;
            },
          });
          const transactionResult = await callback(observed);
          attempted = { count, bytes };
          return transactionResult;
        }, ...args.slice(1)]);
        if (attempted && attempted.count > 0) chunks.push(attempted);
        return result;
      };
    },
  }) as Firestore;
  const progress = new FirestoreProgressStore(measuredDb);
  return buildApplication({
    environment: testEnvironment,
    firestore: null,
    verifier: createFirebaseTokenVerifier(testEnvironment),
    appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
    stores: { ...context.stores, progress },
  });
}


// Exact pre-groupedKeys producer from 02cc4f9124514e2f0278555aa3c2c489642716e2.
// Only the function name differs; the source checksum below binds this fixture to that producer.
type AdoptionMaterialization = Readonly<{ records: readonly GuestMergeRecord[]; changes: readonly Readonly<{ record: GuestMergeRecord; remote: GuestMergeRecord | undefined; mutationId: string }>[] }>;
function ensureFullIdentityUniqueness(records: readonly GuestMergeRecord[]): void {
  const keys = new Set<string>();
  for (const record of records) { const key = adoptionTransferRecordKey(record); if (keys.has(key)) throw new Error("adoption_transfer_duplicate_record_key"); keys.add(key); }
}
function adoptionMutationId(operationId: string, key: string, fingerprint: string): string {
  return `adoption_${operationId.replaceAll("-", "")}_${createMergeRecordFingerprint({ recordId: key, recordType: "active_track", state: { fingerprint }, trackId: key }).slice(0, 24)}`;
}
function legacyAdoptionMaterialization(operationId: string, guestRecords: readonly GuestMergeRecord[], remoteRecords: readonly GuestMergeRecord[], confirmation: GuestMergeConfirmation): AdoptionMaterialization {
  ensureFullIdentityUniqueness(guestRecords);
  ensureFullIdentityUniqueness(remoteRecords);
  const remoteByKey = new Map(remoteRecords.map((record) => [mergeRecordKey(record), record]));
  const localByKey = new Map(guestRecords.map((record) => [mergeRecordKey(record), record]));
  const resolved = new Map(remoteByKey);
  const changes: Array<{ record: GuestMergeRecord; remote: GuestMergeRecord | undefined; mutationId: string }> = [];
  const preview = buildGuestMergePreview({ accountUserId: "00000000-0000-4000-8000-000000000000", accountSnapshotVersion: 0, guestSnapshot: { guestSnapshotVersion: 0, guestUserId: "11111111-1111-4111-8111-111111111111", records: [...guestRecords], activeSession: false, pendingJournal: false }, remoteRecords });
  for (const group of preview.preview.goalPlanConflictGroups) {
    const choice = confirmation.groupChoices.find((candidate) => candidate.groupId === group.groupId);
    if (!choice || choice.resolution === "keep_account") continue;
    for (const recordType of ["goal", "learning_plan"] as const) {
      const key = mergeRecordKey({ recordType, recordId: group.trackId, trackId: group.trackId });
      const local = localByKey.get(key);
      const remote = remoteByKey.get(key);
      if (local && local.state.deleted !== true) queue(local, remote, key);
      else if (remote && remote.state.deleted !== true) {
        const tombstoneState = Object.freeze({ deleted: true });
        const tombstone: GuestMergeRecord = Object.freeze({ fingerprint: createMergeRecordFingerprint({ recordId: group.trackId, recordType, state: tombstoneState, trackId: group.trackId }), recordId: group.trackId, recordType, state: tombstoneState, trackId: group.trackId, version: remote.version });
        queue(tombstone, remote, key);
      }
    }
  }
  for (const record of guestRecords) {
    const key = mergeRecordKey(record);
    const remote = remoteByKey.get(key);
    if (remote?.fingerprint === record.fingerprint) continue;
    const resolution = confirmation.resolutions.find((candidate) => candidate.conflictId === key);
    if (remote && resolution?.resolution === "keep_account") continue;
    queue(record, remote, key);
  }
  assertGoalPlanBundles([...resolved.values()]);
  return Object.freeze({ records: Object.freeze([...resolved.values()].sort((left, right) => mergeRecordKey(left).localeCompare(mergeRecordKey(right)))), changes: Object.freeze(changes) });

  function queue(record: GuestMergeRecord, remote: GuestMergeRecord | undefined, key: string): void {
    if (remote?.fingerprint === record.fingerprint) return;
    const nextVersion = (remote?.version ?? 0) + 1;
    const updated = Object.freeze({ ...record, version: nextVersion });
    resolved.set(key, updated);
    changes.push({ record: updated, remote, mutationId: adoptionMutationId(operationId, key, updated.fingerprint) });
  }
}


test("legacy adoption fixture retains the exact pinned historical producer", () => {
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const start = source.indexOf("function legacyAdoptionMaterialization(");
  const end = source.indexOf("\ntest(\"legacy adoption fixture", start);
  const historical = source.slice(start, end).trimEnd().replace("function legacyAdoptionMaterialization(", "function buildAdoptionMaterialization(");
  assert.equal(createHash("sha256").update(historical).digest("hex"), "c7879fbafc3123cc2a25716eb38a329e513ae273364357ac1814c2ffcc3dafd8");
});

async function checkpointSnapshot(userId: string, sessionId: string) {
  const operation = transferRefFor(userId, sessionId);
  const user = firestore().collection("users").doc(userId);
  const data = (await operation.get()).data()!;
  const target = user.collection("progressGenerations").doc(String(data.targetGeneration));
  return {
    operation: data,
    metadata: (await user.collection("syncMetadata").doc("account").get()).data(),
    target: (await target.get()).data(),
    rows: (await target.collection("records").get()).docs.map((row) => [row.id, row.data()]),
    markers: (await operation.collection("markers").get()).docs.map((row) => [row.id, row.data()]),
    source: await context.stores.progress.readSnapshot(userId),
  };
}

async function seedLegacyCheckpoint(auth: Awaited<ReturnType<typeof createRegisteredAuthUser>>, sessionId: string, records: GuestMergeRecord[], cursor: number, groupChoices: Array<{groupId: string; resolution: "keep_guest" | "keep_account"}> = []) {
  const prepared = await prepareConfirmedTransfer(auth, sessionId, records, groupChoices);
  const active = await context.stores.progress.readSnapshot(auth.userId);
  const materialization = legacyAdoptionMaterialization(sessionId, records, active.records.map(progressRecordToMergeRecord), prepared.confirmation);
  const operation = transferRefFor(auth.userId, sessionId);
  const user = firestore().collection("users").doc(auth.userId);
  const metadata = user.collection("syncMetadata").doc("account");
  const data = (await operation.get()).data()!;
  const target = user.collection("progressGenerations").doc(String(data.targetGeneration));
  const changed = new Map(materialization.changes.map((change) => [adoptionTransferRecordKey(change.record), change.mutationId]));
  // The real Admin SDK transaction commits the historical prefix and cursor atomically.
  await firestore().runTransaction(async (transaction) => {
    await transaction.getAll(operation, metadata);
    const updatedAt = Timestamp.now();
    transaction.set(target, { userId: auth.userId, generation: data.targetGeneration, sourceSessionId: sessionId, state: "building", createdAt: data.createdAt, updatedAt, expiresAt: data.expiresAt });
    for (const record of materialization.records.slice(0, cursor)) {
      const key = adoptionTransferRecordKey(record);
      const kind = record.recordType === "training_attempt" || record.recordType === "review_queue_entry" ? "item" : "node";
      transaction.set(target.collection("records").doc(progressDocumentId({ kind, recordType: record.recordType, trackId: record.trackId, targetId: record.recordId })), {
        kind, recordType: record.recordType, trackId: record.trackId, targetId: record.recordId, version: record.version, fingerprint: record.fingerprint, state: record.state,
        lastMutationId: changed.get(key) ?? `adoption_carry_${sessionId.replaceAll("-", "")}_${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 24)}`,
        generation: data.targetGeneration, sourceSessionId: sessionId, updatedAt, expiresAt: data.expiresAt,
      });
    }
    transaction.update(operation, { state: "applying", applyCursor: cursor, applyTotal: materialization.records.length, applyChangeCount: materialization.changes.length, applyAccountRevision: active.accountRevision + materialization.changes.length, applySourceGeneration: active.generation ?? 0, applySourceRevision: active.accountRevision, applyStartedAt: updatedAt, updatedAt });
    transaction.set(metadata, { adoptionPromotionSessionId: sessionId, adoptionPromotionTargetGeneration: data.targetGeneration, adoptionPromotionSourceGeneration: active.generation ?? 0, adoptionPromotionSourceRevision: active.accountRevision, adoptionPromotionLeaseExpiresAt: Timestamp.fromMillis(Date.now() - 1), updatedAt }, { merge: true });
  });
  return { ...prepared, materialization, active, operation };
}

async function assertCheckpointDenied(auth: Awaited<ReturnType<typeof createRegisteredAuthUser>>, sessionId: string, prepared: Awaited<ReturnType<typeof prepareConfirmedTransfer>>, app = context.app) {
  const before = await checkpointSnapshot(auth.userId, sessionId);
  for (let repeat = 0; repeat < 2; repeat += 1) {
    const response = await app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers: prepared.headers, payload: { canonicalVersion, deviceId, decisionFingerprint: prepared.confirm.json().decisionFingerprint } });
    assert.equal(response.statusCode, 409, JSON.stringify(response.json()));
    assert.deepEqual(response.json(), { error: { code: "adoption_transfer_apply_cursor_conflict" } });
    assert.deepEqual(await checkpointSnapshot(auth.userId, sessionId), before);
    const status = await context.app.inject({ method: "GET", url: `/v1/account-data/adoption/transfer/${sessionId}/status?deviceId=${deviceId}`, headers: prepared.headers });
    assert.equal(status.json().state, before.operation.state);
  }
}

for (const resolution of ["keep_account", "keep_guest"] as const) {
  for (const cursor of [0, 200, 201]) {
    test(`legacy incompatible ${resolution} checkpoint cursor ${cursor} is refused before writes`, async () => {
      const auth = await createRegisteredAuthUser(context);
      const track = "aws-certified-solutions-architect-associate";
      await seedAccountGoalPlan(auth, goalPlanRecords(track, "2027-09-09"));
      const records = [...goalPlanRecords(track, "2027-10-10"), ...Array.from({ length: 199 }, (_, i) => learningRecord(`old-${i}`, `old-track-${i}`))];
      const sessionId = `legacy-${resolution}-${cursor}`;
      const prepared = await seedLegacyCheckpoint(auth, sessionId, records, cursor, [{ groupId: `track:${track}`, resolution }]);
      assert.equal(prepared.materialization.records.length, 201);
      assert.equal(prepared.materialization.changes.length, resolution === "keep_account" ? 201 : 203);
      assert.equal(prepared.materialization.records[0]!.fingerprint, records[0]!.fingerprint);
      assert.equal(prepared.materialization.records[0]!.version, 2);
      await assertCheckpointDenied(auth, sessionId, prepared);
    });
  }
}

async function assertCompletedCheckpoint(auth: Awaited<ReturnType<typeof createRegisteredAuthUser>>, sessionId: string, prepared: Awaited<ReturnType<typeof prepareConfirmedTransfer>>, expected: AdoptionMaterialization, sourceRevision: number) {
  const payload = { canonicalVersion, deviceId, decisionFingerprint: prepared.confirm.json().decisionFingerprint };
  const url = `/v1/account-data/adoption/transfer/${sessionId}/apply`;
  const response = await context.app.inject({ method: "POST", url, headers: prepared.headers, payload });
  assert.equal(response.statusCode, 200, JSON.stringify(response.json()));
  const completed = await checkpointSnapshot(auth.userId, sessionId);
  assert.equal(completed.operation.state, "complete");
  assert.equal(completed.operation.applyCursor, expected.records.length);
  assert.equal(completed.operation.applyChangeCount, expected.changes.length);
  assert.equal(completed.source.accountRevision, sourceRevision + expected.changes.length);
  assert.equal(completed.source.generation, completed.operation.targetGeneration);
  assert.equal(completed.markers.length, 1);
  const changed = new Map(expected.changes.map((change) => [adoptionTransferRecordKey(change.record), change.mutationId]));
  const rows = completed.rows.map(([, row]) => row as Record<string, unknown>);
  assert.equal(rows.length, expected.records.length);
  for (const record of expected.records) {
    const row = rows.find((candidate) => candidate.recordType === record.recordType && candidate.trackId === record.trackId && candidate.targetId === record.recordId)!;
    assert.ok(row);
    assert.deepEqual([row.fingerprint, row.version, row.state], [record.fingerprint, record.version, record.state]);
    const key = adoptionTransferRecordKey(record);
    assert.equal(row.lastMutationId, changed.get(key) ?? `adoption_carry_${sessionId.replaceAll("-", "")}_${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 24)}`);
  }
  const replay = await context.app.inject({ method: "POST", url, headers: prepared.headers, payload });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), response.json());
  assert.deepEqual(await checkpointSnapshot(auth.userId, sessionId), completed);
}

for (const cursor of [0, 200, 201]) {
  test(`legacy compatible G0 checkpoint cursor ${cursor} resumes exactly`, async () => {
    const auth = await createRegisteredAuthUser(context);
    const sessionId = `compatible-${cursor}`;
    const records = Array.from({ length: 201 }, (_, i) => learningRecord(`compatible-${i}`, `compatible-track-${i}`));
    const prepared = await seedLegacyCheckpoint(auth, sessionId, records, cursor);
    await assertCompletedCheckpoint(auth, sessionId, prepared, prepared.materialization, 0);
  });
}

for (const resolution of ["keep_account", "keep_guest"] as const) {
  for (const cursor of [0, 200, 201]) {
    test(`current ${resolution} checkpoint cursor ${cursor} resumes exactly`, async () => {
      const auth = await createRegisteredAuthUser(context);
      const track = "aws-certified-solutions-architect-associate";
      const active = await seedAccountGoalPlan(auth, goalPlanRecords(track, "2027-09-09"));
      const guestPair = goalPlanRecords(track, "2027-10-10");
      const ungrouped = Array.from({ length: 199 }, (_, i) => learningRecord(`current-${i}`, `current-track-${i}`));
      const sessionId = `current-${resolution}-${cursor}`;
      const prepared = await prepareConfirmedTransfer(auth, sessionId, [...guestPair, ...ungrouped], [{ groupId: `track:${track}`, resolution }]);
      // Interrupt the real current producer at the requested transaction boundary.
      const interrupted = buildTransferTransactionRotationApp(auth.userId, cursor === 0 ? 2 : cursor === 200 ? 3 : 4);
      const response = await interrupted.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers: prepared.headers, payload: { canonicalVersion, deviceId } });
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), { error: { code: "authorization_generation_conflict" } });
      assert.equal((await preparedOperation(auth.userId, sessionId)).applyCursor, cursor);
      await interrupted.close();
      await firestore().collection("users").doc(auth.userId).update({ authorizationGeneration: 1 });
      const grouped = resolution === "keep_account" ? active.records.map(progressRecordToMergeRecord) : guestPair.map((record) => ({ ...record, version: 2 }));
      const records = [...grouped, ...ungrouped.map((record) => ({ ...record, version: 1 }))];
      const changed = resolution === "keep_account" ? records.slice(grouped.length) : records;
      const expected = { records, changes: changed.map((record) => ({ record, remote: undefined, mutationId: adoptionMutationId(sessionId, mergeRecordKey(record), record.fingerprint) })) };
      await assertCompletedCheckpoint(auth, sessionId, prepared, expected, active.accountRevision);
    });
  }
}
async function preparedOperation(userId: string, sessionId: string) { return (await transferRefFor(userId, sessionId).get()).data()!; }

// Persisted counters are a strict contract, including zero and missing values.
test("applying checkpoints reject malformed and inconsistent counters without writes", async () => {
  const auth = await createRegisteredAuthUser(context);
  const sessionId = "malformed-checkpoint";
  const prepared = await seedLegacyCheckpoint(auth, sessionId, [learningRecord("malformed-record", "malformed-track")], 0);
  const original = await preparedOperation(auth.userId, sessionId);
  const fields = ["applyTotal", "applyChangeCount", "applySourceGeneration", "applySourceRevision", "applyAccountRevision", "applyCursor"];
  for (const field of fields) {
    for (const value of [null, "0", -1, 0.5, Number.MAX_SAFE_INTEGER + 1, FieldValue.delete()]) {
      await prepared.operation.update({ [field]: value });
      await assertCheckpointDenied(auth, sessionId, prepared);
      await prepared.operation.set(original);
    }
  }
  for (const change of [
    { applyTotal: 2 }, { applyChangeCount: 0 }, { applyAccountRevision: 0 }, { applyCursor: 2 },
    // Self-consistent checkpoint values cannot replace the captured source identity.
    { applySourceGeneration: 1 }, { applySourceRevision: 1, applyAccountRevision: 2 },
  ]) {
    await prepared.operation.update(change);
    await assertCheckpointDenied(auth, sessionId, prepared);
    await prepared.operation.set(original);
  }
});

test("new adoption rejects source revision addition overflow before reservation", async () => {
  const auth = await createRegisteredAuthUser(context);
  await firestore().collection("users").doc(auth.userId).collection("syncMetadata").doc("account").set({ accountRevision: Number.MAX_SAFE_INTEGER });
  const sessionId = "new-revision-overflow";
  const prepared = await prepareConfirmedTransfer(auth, sessionId, [learningRecord("overflow-record", "overflow-track")]);
  await assertCheckpointDenied(auth, sessionId, prepared);
  assert.equal((await preparedOperation(auth.userId, sessionId)).state, "preview_ready");
});

for (const boundary of ["lease", "chunk", "promotion"] as const) {
  test(`checkpoint counter tamper at transactional ${boundary} reread refuses writes`, async () => {
    const auth = await createRegisteredAuthUser(context);
    const sessionId = `reread-${boundary}`;
    const prepared = await seedLegacyCheckpoint(auth, sessionId, [learningRecord("reread-record", "reread-track")], 0);
    let count = 0;
    let snapshot: Awaited<ReturnType<typeof checkpointSnapshot>> | undefined;
    const at = boundary === "lease" ? 1 : boundary === "chunk" ? 2 : 3;
    const racedDb = new Proxy(firestore(), {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property !== "runTransaction" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
        return async (...args: unknown[]) => {
          count += 1;
          if (count === at) {
            await prepared.operation.update({ applyChangeCount: 2, applyAccountRevision: 2 });
            snapshot = await checkpointSnapshot(auth.userId, sessionId);
          }
          // The hook changes stored data; all reads, retries and writes remain real SDK transactions.
          return (value as (...callArgs: unknown[]) => Promise<unknown>).apply(target, args);
        };
      },
    }) as Firestore;
    const app = buildApplication({ environment: testEnvironment, firestore: null, verifier: createFirebaseTokenVerifier(testEnvironment), appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } }, stores: { ...context.stores, progress: new FirestoreProgressStore(racedDb) } });
    try {
      const response = await app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers: prepared.headers, payload: { canonicalVersion, deviceId } });
      assert.equal(count, at);
      assert.equal(response.statusCode, 409, JSON.stringify(response.json()));
      assert.deepEqual(response.json(), { error: { code: "adoption_transfer_apply_cursor_conflict" } });
      assert.ok(snapshot);
      assert.deepEqual(await checkpointSnapshot(auth.userId, sessionId), snapshot);
      await assertCheckpointDenied(auth, sessionId, prepared);
    } finally { await app.close(); }
  });
}

for (const fence of ["target_owner", "foreign_lease"] as const) {
  test(`compatible checkpoint preserves ${fence} fence`, async () => {
    const auth = await createRegisteredAuthUser(context);
    const sessionId = `checkpoint-${fence}`;
    const prepared = await seedLegacyCheckpoint(auth, sessionId, [learningRecord("fence-record", "fence-track")], 0);
    const user = firestore().collection("users").doc(auth.userId);
    if (fence === "target_owner") await user.collection("progressGenerations").doc("1").update({ sourceSessionId: "foreign-session" });
    else await user.collection("syncMetadata").doc("account").update({ adoptionPromotionSessionId: "foreign-session", adoptionPromotionLeaseExpiresAt: Timestamp.fromMillis(Date.now() + 60_000) });
    const before = await checkpointSnapshot(auth.userId, sessionId);
    const response = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers: prepared.headers, payload: { canonicalVersion, deviceId } });
    assert.equal(response.statusCode, 409, JSON.stringify(response.json()));
    assert.deepEqual(response.json(), { error: { code: "adoption_transfer_generation_conflict" } });
    assert.deepEqual(await checkpointSnapshot(auth.userId, sessionId), before);
  });
}

test("empty new adoption completes once and replays exact stored bytes", async () => {
  const auth = await createRegisteredAuthUser(context);
  const sessionId = "empty-new-complete";
  const prepared = await prepareConfirmedTransfer(auth, sessionId, []);
  await assertCompletedCheckpoint(auth, sessionId, prepared, { records: [], changes: [] }, 0);
});

test("completed historical adoption replays committed history without reinterpretation", async () => {
  const auth = await createRegisteredAuthUser(context);
  const sessionId = "completed-historical-replay";
  const track = "aws-certified-solutions-architect-associate";
  await seedAccountGoalPlan(auth, goalPlanRecords(track, "2027-09-09"));
  const prepared = await seedLegacyCheckpoint(auth, sessionId, goalPlanRecords(track, "2027-10-10"), 2, [{ groupId: `track:${track}`, resolution: "keep_account" }]);
  const user = firestore().collection("users").doc(auth.userId);
  const metadata = user.collection("syncMetadata").doc("account");
  const old = await preparedOperation(auth.userId, sessionId);
  const target = user.collection("progressGenerations").doc(String(old.targetGeneration));
  // Model the old producer's already committed promotion, not a resumable operation.
  await firestore().runTransaction(async (transaction) => {
    await transaction.getAll(prepared.operation, metadata, target);
    const committedAt = Timestamp.now();
    transaction.set(metadata, { generation: old.targetGeneration, activeGeneration: old.targetGeneration, accountRevision: old.applyAccountRevision, adoptionPromotionSessionId: FieldValue.delete(), adoptionPromotionTargetGeneration: FieldValue.delete(), adoptionPromotionSourceGeneration: FieldValue.delete(), adoptionPromotionSourceRevision: FieldValue.delete(), adoptionPromotionLeaseExpiresAt: FieldValue.delete(), updatedAt: committedAt }, { merge: true });
    transaction.set(target, { state: "active", updatedAt: committedAt, expiresAt: FieldValue.delete() }, { merge: true });
    transaction.set(prepared.operation.collection("markers").doc(String(old.targetGeneration)), { sessionId, targetGeneration: old.targetGeneration, accountRevision: old.applyAccountRevision, committedAt, expiresAt: old.expiresAt });
    transaction.update(prepared.operation, { state: "complete", generation: old.targetGeneration, activeGeneration: old.targetGeneration, accountRevision: old.applyAccountRevision, committedAt, updatedAt: committedAt });
  });
  const before = await checkpointSnapshot(auth.userId, sessionId);
  assert.equal(before.source.accountRevision, 4); // The pre-fix result is history, not recalculated as keep_account.
  assert.deepEqual(before.source.records.map((record) => record.fingerprint).sort(), prepared.materialization.records.map((record) => record.fingerprint).sort());
  for (let repeat = 0; repeat < 2; repeat += 1) {
    const replay = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers: prepared.headers, payload: { canonicalVersion, deviceId } });
    assert.equal(replay.statusCode, 200, JSON.stringify(replay.json()));
    assert.equal(replay.json().state, "complete");
    assert.equal(replay.json().accountRevision, 4);
    assert.deepEqual(await checkpointSnapshot(auth.userId, sessionId), before);
  }
});

for (const fence of ["source_generation", "source_revision", "device", "decision", "expected_generation"] as const) {
  test(`compatible checkpoint preserves ${fence} request or source fence`, async () => {
    const auth = await createRegisteredAuthUser(context);
    const sessionId = `fence-${fence}`;
    const prepared = await seedLegacyCheckpoint(auth, sessionId, [learningRecord("source-fence-record", "source-fence-track")], 0);
    const metadata = firestore().collection("users").doc(auth.userId).collection("syncMetadata").doc("account");
    if (fence === "source_generation") await metadata.update({ generation: 2 });
    if (fence === "source_revision") await metadata.update({ accountRevision: 1 });
    const before = await checkpointSnapshot(auth.userId, sessionId);
    const response = await context.app.inject({ method: "POST", url: `/v1/account-data/adoption/transfer/${sessionId}/apply`, headers: prepared.headers, payload: {
      canonicalVersion, deviceId: fence === "device" ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc" : deviceId,
      decisionFingerprint: fence === "decision" ? "f".repeat(64) : prepared.confirm.json().decisionFingerprint,
      ...(fence === "expected_generation" ? { expectedGeneration: 1 } : {}),
    } });
    const code = fence.startsWith("source_") ? "adoption_transfer_preview_stale" : fence === "device" ? "adoption_transfer_device_mismatch" : fence === "decision" ? "adoption_transfer_decision_mismatch" : "adoption_transfer_generation_conflict";
    assert.equal(response.statusCode, 409, JSON.stringify(response.json()));
    assert.deepEqual(response.json(), { error: { code } });
    assert.deepEqual(await checkpointSnapshot(auth.userId, sessionId), before);
  });
}
