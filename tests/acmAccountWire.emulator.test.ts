import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ProgressMutation } from "../src/modules/progress/contracts.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { progressDocumentId } from "../src/infrastructure/firestore/paths.js";
import { createEmulatorContext, createVerifiedRegisteredAuthUser, TEST_APP_CHECK_TOKEN } from "./support.js";

type AccountWireRecord = Readonly<{
  recordId: string;
  recordType: ProgressMutation["recordType"];
  trackId: string;
  version: number;
  fingerprint: string;
  state: Readonly<Record<string, unknown>>;
}>;
type AccountWireFixture = Readonly<{
  schemaVersion: number;
  source: string;
  producer: string;
  currentBank: Readonly<{ trackId: string; contentVersion: string; artifactSha256: string }>;
  runtimeTrainingPin: Readonly<{ trackId: string; contentVersion: string; artifactSha256: string }>;
  ordinaryTrainingIdentity: Readonly<{ trackId: string; contentVersion: string; artifactSha256: string }>;
  records: readonly AccountWireRecord[];
}>;
type LegacyGuard = (recordType: string, recordId: string, trackId: string, state: unknown) => boolean;

const context = createEmulatorContext();
const fixture = JSON.parse(readFileSync(new URL("./fixtures/account-wire/acm-actual-export.json", import.meta.url), "utf8")) as AccountWireFixture;
const preAcmReader = (await import("./fixtures/account-wire/pre-acm-accountWireState.js")).isAccountWireState as LegacyGuard;
const deviceId = "00000000-0000-4000-8000-000000000000";
const accounts: string[] = [];
const userRef = (id: string) => context.db.collection("users").doc(id);

function mutationFrom(record: AccountWireRecord, index: number): ProgressMutation {
  return {
    mutationId: `acm-wire-${index}-${randomUUID()}`,
    kind: record.recordType === "training_attempt" || record.recordType === "review_queue_entry" ? "item" : "node",
    recordType: record.recordType,
    trackId: record.trackId,
    targetId: record.recordId,
    expectedVersion: null,
    fingerprint: record.fingerprint,
    state: structuredClone(record.state),
  };
}

function fingerprint(mutation: ProgressMutation): string {
  return createMergeRecordFingerprint({ recordId: mutation.targetId, recordType: mutation.recordType, trackId: mutation.trackId, state: mutation.state });
}

async function persisted(userId: string) {
  return Promise.all(["progress", "syncMutations", "syncBatches", "syncMetadata"].map(async (collection) =>
    (await userRef(userId).collection(collection).orderBy("__name__").get()).docs.map((document) => [document.id, document.data()])));
}

async function assertNoWrite(userId: string, operation: () => Promise<unknown>): Promise<void> {
  const before = await persisted(userId);
  await operation();
  assert.deepEqual(await persisted(userId), before, "progress, revision, mutation receipts and batch receipts must remain unchanged");
}

test.after(async () => {
  for (const id of accounts) await context.db.recursiveDelete(userRef(id));
  await context.close();
});

test("ACM fixture crosses the current sync/store/download boundary and fails closed for the frozen reader", async () => {
  assert.equal(createHash("sha256").update(readFileSync(new URL("./fixtures/account-wire/acm-actual-export.json", import.meta.url))).digest("hex"), "35588c58c39b32315da0fd8b7724421d00467235d424f49c35bcfcc448f9b82d");
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.source, "buildAccountDataSnapshot");
  assert.equal(fixture.producer, "current-canonical-bank-session");
  assert.equal(fixture.currentBank.artifactSha256, "f1f3277cc0a5a50289bc8edc921270aebed8d8bf4080ad328e9000d90c7159e1");
  assert.equal(fixture.runtimeTrainingPin.artifactSha256, fixture.currentBank.artifactSha256);
  assert.equal(fixture.ordinaryTrainingIdentity.artifactSha256, "a85fb2ca9f57315d76f34627c109aa8ebc25536c4b4684356d97236a09145a2d");
  assert.equal(fixture.runtimeTrainingPin.contentVersion, fixture.currentBank.contentVersion);
  assert.equal(fixture.records.length, 4);
  assert.deepEqual(fixture.records.map(({ recordType, state }) => [recordType, (state.response as Record<string, unknown> | undefined)?.type ?? null]).sort(), [
    ["training_attempt", "approach_choice"],
    ["training_attempt", "choice_single"],
    ["training_session_result", null],
    ["training_session_summary", null],
  ].sort());
  const actualQ1 = fixture.records.find(({ recordType, state }) => recordType === "training_attempt" && (state.response as Record<string, unknown>).type === "approach_choice")!;
  assert.equal((actualQ1.state.item as Record<string, unknown>).questionId, "acm-b01-01-q1");
  assert.deepEqual([actualQ1.trackId, (actualQ1.state.item as Record<string, unknown>).contentVersion, (actualQ1.state.item as Record<string, unknown>).artifactSha256], [fixture.runtimeTrainingPin.trackId, fixture.runtimeTrainingPin.contentVersion, fixture.runtimeTrainingPin.artifactSha256]);
  assert.equal((actualQ1.state.result as Record<string, unknown>).kind, "partial");
  assert.equal((actualQ1.state.result as Record<string, unknown>).earnedPoints, 0);
  const actualQ2 = fixture.records.find(({ recordType, state }) => recordType === "training_attempt" && (state.response as Record<string, unknown>).type === "choice_single")!;
  assert.equal((actualQ2.state.item as Record<string, unknown>).questionId, "acm-b01-01-q2");
  assert.deepEqual([actualQ2.trackId, (actualQ2.state.item as Record<string, unknown>).contentVersion, (actualQ2.state.item as Record<string, unknown>).artifactSha256], [fixture.runtimeTrainingPin.trackId, fixture.runtimeTrainingPin.contentVersion, fixture.runtimeTrainingPin.artifactSha256]);

  const auth = await createVerifiedRegisteredAuthUser(context);
  accounts.push(auth.userId);
  const headers = { authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
  const mutations = fixture.records.map(mutationFrom);
  const sessionId = `acm-wire-${randomUUID()}`;
  const batchId = `acm-wire-${randomUUID()}`;
  const request = {
    canonicalVersion: "canonical-json-v1" as const,
    expectedAccountRevision: 0,
    deviceId,
    sessionId,
    batchId,
    highWatermark: mutations.length,
    mutations,
  };
  const send = (payload: typeof request) => context.app.inject({ method: "POST", url: "/v1/progress/sync", headers, payload });

  const validQ2 = mutations.find(({ targetId }) => targetId !== actualQ1.recordId)!;
  const invalidQ1 = structuredClone(mutations.find(({ targetId }) => targetId === actualQ1.recordId)!);
  (invalidQ1.state as Record<string, unknown>).futureAcmField = "unknown";
  (invalidQ1 as { fingerprint: string }).fingerprint = fingerprint(invalidQ1);
  const invalidRequest = { ...request, sessionId: `${sessionId}-invalid`, batchId: `${batchId}-invalid`, mutations: [validQ2, invalidQ1] };
  await assertNoWrite(auth.userId, async () => {
    const rejected = await send(invalidRequest);
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.deepEqual(rejected.json(), { error: { code: "invalid_request", issues: ["mutations.1.state"] } });
  });

  const accepted = await send(request);
  assert.equal(accepted.statusCode, 200, accepted.body);
  const acceptedBody = accepted.json() as { accountRevision: number; applied: readonly Record<string, unknown>[]; duplicates: readonly string[] };
  assert.equal(acceptedBody.applied.length, 4);
  assert.equal(acceptedBody.accountRevision, 4);
  assert.deepEqual(acceptedBody.duplicates, []);
  const stored = await context.stores.progress.readSnapshot(auth.userId);
  assert.equal(stored.accountRevision, 4);
  assert.equal(stored.records.length, 4);

  const downloaded = await context.app.inject({ method: "GET", url: "/v1/progress?pageSize=100", headers });
  assert.equal(downloaded.statusCode, 200, downloaded.body);
  const downloadedBody = downloaded.json() as { accountRevision: number; records: readonly { recordType: string; targetId: string; trackId: string; version: number; fingerprint: string; lastMutationId: string; state: Record<string, unknown> }[] };
  assert.equal(downloadedBody.accountRevision, 4);
  assert.equal(downloadedBody.records.every(({ version }) => version === 1), true, "the backend assigns version 1 to each newly stored record");
  assert.equal(new Set(downloadedBody.records.map(({ lastMutationId }) => lastMutationId)).size, 4);
  const normalized = downloadedBody.records.map(({ targetId, recordType, trackId, version, fingerprint, state }) => ({ recordId: targetId, recordType, trackId, version, fingerprint, state }))
    .sort((left, right) => `${left.recordType}\0${left.recordId}`.localeCompare(`${right.recordType}\0${right.recordId}`));
  const expected = fixture.records.map((record) => ({ ...structuredClone(record), version: 1 }))
    .sort((left, right) => `${left.recordType}\0${left.recordId}`.localeCompare(`${right.recordType}\0${right.recordId}`));
  assert.deepEqual(normalized, expected, "download preserves exact producer IDs, pair pins, fingerprints, and result evidence");

  const legacyRejected = downloadedBody.records.filter((record) => !preAcmReader(record.recordType, record.targetId, record.trackId, record.state));
  assert.deepEqual(legacyRejected.map(({ recordType, state }) => [recordType, recordType === "training_attempt" ? (state.response as Record<string, unknown>).type : null]).sort(), [
    ["training_attempt", "approach_choice"],
    ["training_session_result", null],
    ["training_session_summary", null],
  ].sort(), "the frozen pre-ACM reader rejects the downloaded records before any record can be handed to its importer");
  const beforeReplay = await persisted(auth.userId);
  const replay = await send(request);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), acceptedBody, "exact batch replay returns its original durable result");
  assert.deepEqual(await persisted(auth.userId), beforeReplay, "exact replay creates no extra writes");

  const changedQ1 = structuredClone(mutations.find(({ targetId }) => targetId === actualQ1.recordId)!);
  (changedQ1.state.response as Record<string, unknown>).optionId = "different-option";
  (changedQ1 as { fingerprint: string }).fingerprint = fingerprint(changedQ1);
  const changedPayloadNewBatch = {
    ...request,
    sessionId: `${sessionId}-changed-payload`,
    batchId: `${batchId}-changed-payload`,
    expectedAccountRevision: acceptedBody.accountRevision,
    highWatermark: 1,
    mutations: [changedQ1],
  };
  await assertNoWrite(auth.userId, async () => {
    const rejected = await send(changedPayloadNewBatch);
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.deepEqual(rejected.json(), { error: { code: "mutation_id_reuse" } });
  });

  const afterAll = await context.stores.progress.readSnapshot(auth.userId);
  assert.equal(afterAll.accountRevision, 4);
  assert.equal(afterAll.records.length, 4);
  assert.equal(afterAll.records.filter(({ recordType, state }) => recordType === "training_attempt" && (state.response as Record<string, unknown>).type === "approach_choice").length, 1);
  assert.ok(afterAll.records.some(({ recordType, state }) => recordType === "training_attempt" && (state.response as Record<string, unknown>).type === "approach_choice"
    && (state.result as Record<string, unknown>).kind === "partial" && (state.result as Record<string, unknown>).earnedPoints === 0));
  assert.equal(afterAll.records.every((record) => record.targetId === mutations.find((mutation) => mutation.mutationId === record.lastMutationId)?.targetId), true);
  assert.equal(afterAll.records.every((record) => record.fingerprint === createMergeRecordFingerprint({ recordId: record.targetId, recordType: record.recordType, trackId: record.trackId, state: record.state })), true);
  assert.equal((await userRef(auth.userId).collection("progress").get()).size, 4);
  assert.equal((await userRef(auth.userId).collection("syncMutations").get()).size, 4);
  assert.equal((await userRef(auth.userId).collection("syncBatches").get()).size, 1);
  assert.equal((await userRef(auth.userId).collection("syncMetadata").doc("account").get()).data()?.accountRevision, 4);
  assert.equal((await userRef(auth.userId).collection("progress").doc(progressDocumentId(mutations[0]!)).get()).exists, true);
});
