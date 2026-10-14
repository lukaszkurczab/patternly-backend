import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { createEmulatorContext, createVerifiedRegisteredAuthUser, TEST_APP_CHECK_TOKEN } from "../../tests/support.ts";
import { canonicalJsonBytes } from "../../src/infrastructure/identity/canonicalJson.ts";
import { createMergeRecordFingerprint, guestMergeRecordSchema } from "../../src/modules/users/merge.ts";
import { createAdoptionTransferChunkFingerprint, createAdoptionSnapshotSeal, adoptionTransferRecordKey, adoptionTransferRecordSchema } from "../../src/modules/users/adoptionTransfer.ts";
import { progressMutationSchema } from "../../src/modules/progress/contracts.ts";

if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:18119" || process.env.FIREBASE_PROJECT_ID !== "demo-patternly-terminal-wire") throw new Error("terminal_wire_isolated_emulator_required");
const root = resolve("../patternly");
const requireApp = createRequire(resolve(root, "package.json"));
const load = path => requireApp(resolve(root, "src", path));
const data = load("storage/repositories/accountDataRepository.ts");
const { terminalWireFixture } = load("testing/terminalWireFixture.ts");
const { productionLearningDataAdmissionContext: admission } = load("application/tracks/trackAdmissionContext.ts");
const { bindGuestInstallationToAccount } = load("storage/repositories/guestInstallationRepository.ts");
const { createPatternlyApiClient } = load("infrastructure/clients/PatternlyApiClientAdapter.ts");
const { createCanonicalTrainingFamilyRuntime } = load("application/canonicalTrainingFamilyComposition.ts");
const { loadCanonicalRuntimeCatalog } = load("content/canonical/runtimeCatalog.ts");
const { projectTerminalSession } = load("storage/contracts/terminalSessionWire.ts");
const { createTrainingSessionDraft, abandonTrainingSession } = load("domain/index.ts");
const context = createEmulatorContext();
const db = context.db;
const accounts = [];
const deviceId = "00000000-0000-4000-8000-000000000000";
const canonicalVersion = "canonical-json-v1";
const headers = user => ({ authorization: `Bearer ${user.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN });
async function user() { const value = await createVerifiedRegisteredAuthUser(context); accounts.push(value.userId); return value; }
async function post(auth, url, payload, status = 200) {
  const response = await context.app.inject({ method: "POST", url, headers: headers(auth), payload });
  assert.equal(response.statusCode, status, `${url}: ${response.body}`);
  return response.json();
}
function client(auth, sent) {
  return createPatternlyApiClient({ apiOrigin: "https://patternly.invalid", getIdToken: async () => auth.idToken, getAppCheckToken: async () => TEST_APP_CHECK_TOKEN,
    fetchImplementation: async (url, init) => {
      if (init.body) sent.push(JSON.parse(init.body));
      const r = await context.app.inject({ method: init.method, url: new URL(url).pathname + new URL(url).search, headers: init.headers, ...(init.body ? { payload: init.body } : {}) });
      return new Response(r.body, { status: r.statusCode, headers: r.headers });
    },
  });
}
const progressRecords = records => records.map(({ targetId, recordId, recordType, trackId, fingerprint, state, version }) => ({ recordId: targetId ?? recordId, recordType, trackId, fingerprint, state, version }));
const facts = records => progressRecords(records).map(({ version: _version, ...record }) => record).sort((a,b) => data.accountDataRecordKey(a).localeCompare(data.accountDataRecordKey(b)));
function mutation(record, index = 0) { return { mutationId: `terminal-mutation-${index}`, kind: ["training_attempt", "review_queue_entry"].includes(record.recordType) ? "item" : "node", recordType: record.recordType, trackId: record.trackId, targetId: record.recordId, expectedVersion: null, fingerprint: record.fingerprint, state: record.state }; }
async function stored(auth) {
  const rows = [];
  async function walk(ref) {
    const snap = await ref.get(); rows.push([ref.path, snap.data()]);
    for (const collection of await ref.listCollections()) for (const doc of (await collection.orderBy("__name__").get()).docs) await walk(doc.ref);
  }
  await walk(db.collection("users").doc(auth.userId));
  await walk(db.collection("accounts").doc(auth.userId));
  return rows;
}
async function noWrite(auth, fn) { const before = await stored(auth); await fn(); assert.deepEqual(await stored(auth), before); }

test.after(async () => {
  for (const id of accounts) { await db.recursiveDelete(db.collection("users").doc(id)); await db.recursiveDelete(db.collection("accounts").doc(id)); }
  await context.close();
});

test("one vendored closed contract, actual outbound sync, all-record bootstrap, retry, adoption and export", async () => {
  assert.equal(readFileSync(resolve(root, "src/domain/account/accountWireState.ts"), "utf8"), readFileSync("src/modules/progress/accountWireState.ts", "utf8"));
  const f = await terminalWireFixture();
  const auth = await user(), sent = [], api = client(auth, sent);
  await bindGuestInstallationToAccount(auth.userId);
  data.saveAccountSyncState({ ...await data.getAccountSyncState(admission), accountId: auth.userId, status: "synced" }, admission);
  const outbox = await data.ensureAccountOutboxFromLocalDataset(admission);
  const items = outbox.outbox.map(mutation);
  const request = { canonicalVersion, deviceId, expectedAccountRevision: 0, sessionId: "wire-sync", batchId: "wire-sync:0", highWatermark: outbox.highWatermark, mutations: items };
  const first = await api.syncProgress(request);
  assert.deepEqual(await api.syncProgress(request), first);
  assert.deepEqual(sent[0], request, "the production HTTP adapter serializes this exact payload");
  const summary = sent[0].mutations.find(m => m.recordType === "training_session_summary");
  for (const key of ["currentItemIndex", "activeForegroundMs", "actualLength", "draft", "journal"]) assert.equal(Object.hasOwn(summary.state, key), false, key);
  const page = await api.getProgress();
  assert.deepEqual(facts(page.records), facts(f.snapshot.records));
  await data.applyRemoteAccountData(progressRecords(page.records), admission);
  assert.deepEqual(facts((await data.buildAccountDataSnapshot(admission)).records), facts(f.snapshot.records));
  // Old whole-session retry is neither translated nor assigned a fresh mutation ID.
  const old = { ...items.find(m => m.targetId === f.finalized.session.id), state: f.finalized.session };
  old.fingerprint = createMergeRecordFingerprint({ recordId: old.targetId, recordType: old.recordType, trackId: old.trackId, state: old.state });
  await noWrite(auth, () => post(auth, "/v1/progress/sync", { ...request, batchId: "old-whole-session", mutations: [old] }, 400));
  const guest = { ...f.snapshot, activeSession: false, pendingJournal: false };
  const adopted = await user(), adoptedApi = client(adopted, []);
  const preview = await adoptedApi.previewAccountAdoption(guest);
  const confirmation = { operationId: preview.preview.operationId, previewFingerprint: preview.preview.fingerprint, resolutions: [], groupChoices: [] };
  const confirmed = await adoptedApi.confirmAccountAdoption({ deviceId, snapshot: guest, confirmation });
  assert.deepEqual(facts(confirmed.records), facts(guest.records));
  assert.deepEqual(await adoptedApi.confirmAccountAdoption({ deviceId, snapshot: guest, confirmation }), confirmed);
  const transferAuth = await user(), sessionId = "wire-transfer", base = `/v1/account-data/adoption/transfer/${sessionId}`;
  await post(transferAuth, "/v1/account-data/adoption/transfer/start", { canonicalVersion, deviceId, sessionId, idempotencyKey: sessionId, guestUserId: guest.guestUserId, snapshotVersion: guest.guestSnapshotVersion, expectedGeneration: 0 });
  const chunkBase = { chunkId: "wire-chunk", index: 0, recordKeys: guest.records.map(adoptionTransferRecordKey).sort(), bytes: canonicalJsonBytes(guest.records) };
  const chunk = { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) };
  const upload = { canonicalVersion, deviceId, records: guest.records, chunk };
  await post(transferAuth, `${base}/upload`, upload);
  await post(transferAuth, `${base}/upload`, upload);
  const seal = createAdoptionSnapshotSeal({ guestUserId: guest.guestUserId, snapshotVersion: guest.guestSnapshotVersion, records: guest.records, chunks: [chunk] });
  await post(transferAuth, `${base}/seal`, { canonicalVersion, deviceId, snapshotFingerprint: seal, recordCount: guest.records.length, chunkCount: 1 });
  const stagedPreview = await post(transferAuth, `${base}/preview`, { canonicalVersion, deviceId });
  const stagedConfirm = await post(transferAuth, `${base}/confirm`, { canonicalVersion, deviceId, previewFingerprint: stagedPreview.preview.fingerprint, resolutions: [], groupChoices: [] });
  await post(transferAuth, `${base}/apply`, { canonicalVersion, deviceId, decisionFingerprint: stagedConfirm.decisionFingerprint });
  const active = await context.stores.progress.readSnapshot(transferAuth.userId);
  assert.equal(active.generation, 1);
  assert.deepEqual(facts(active.records), facts(guest.records));
  // Stale generation-zero rows must never leak back into export after promotion.
  await db.collection("users").doc(transferAuth.userId).collection("progress").doc("stale").set({ forbidden: "stale-generation-zero" });
  const exported = await context.app.inject({ method: "GET", url: "/v1/account-data/export", headers: headers(transferAuth) });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.deepEqual(facts(exported.json().portable.progress), facts(guest.records));
  assert.equal(exported.body.includes("stale-generation-zero"), false);
});

test("unknown fields at nested object boundaries reject at sync, one-shot and staged intake with zero writes", async () => {
  const f = await terminalWireFixture(), auth = await user();
  const records = f.snapshot.records;
  const sessionId = "unknown-transfer", uploadPath = `/v1/account-data/adoption/transfer/${sessionId}/upload`;
  await post(auth, "/v1/account-data/adoption/transfer/start", { canonicalVersion, deviceId, sessionId, idempotencyKey: sessionId, guestUserId: f.snapshot.guestUserId, snapshotVersion: f.snapshot.guestSnapshotVersion, expectedGeneration: 0 });
  const preview = await context.stores.progress.previewAdoption(auth.userId, f.snapshot);
  const confirmation = { operationId: preview.preview.operationId, previewFingerprint: preview.preview.fingerprint, resolutions: [], groupChoices: [] };
  let index = 0;
  for (const record of records) {
    const paths = [];
    function visit(value, path) {
      if (!value || typeof value !== "object") return;
      if (!Array.isArray(value)) paths.push(path);
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    }
    visit(record.state, []);
    for (const path of paths) {
      const changed = structuredClone(record); let target = changed.state;
      for (const key of path) target = target[key];
      target.unrecognizedNestedField = { draft: "must-not-store" };
      changed.fingerprint = createMergeRecordFingerprint(changed);
      assert.equal(guestMergeRecordSchema.safeParse(changed).success, false);
      assert.equal(adoptionTransferRecordSchema.safeParse(changed).success, false);
      const item = mutation(changed, index++);
      const parsed = progressMutationSchema.safeParse(item);
      assert.equal(parsed.success, false);
      const rejectedStatus = parsed.error.issues.some(issue => issue.message === "content_identity_schema_conflict") ? 409 : 400;
      await noWrite(auth, async () => {
        await post(auth, "/v1/progress/sync", { canonicalVersion, deviceId, expectedAccountRevision: 0, sessionId: "unknown-sync", batchId: `unknown-${index}`, highWatermark: 1, mutations: [item] }, rejectedStatus);
        await post(auth, "/v1/account-data/adoption/preview", { ...f.snapshot, records: [changed] }, 400);
        await post(auth, "/v1/account-data/adoption/confirm", { deviceId, snapshot: { ...f.snapshot, records: records.map(r => r === record ? changed : r) }, confirmation }, 400);
        const chunkBase = { chunkId: "unknown", index: 0, recordKeys: [adoptionTransferRecordKey(changed)], bytes: canonicalJsonBytes([changed]) };
        await post(auth, uploadPath, { canonicalVersion, deviceId, records: [changed], chunk: { ...chunkBase, fingerprint: createAdoptionTransferChunkFingerprint(chunkBase) } }, 400);
      });
    }
  }
  assert.ok(index > 50, `nested boundary coverage: ${index}`);
  const plan = records.find(record => record.recordType === "learning_plan");
  const unsupported = { ...plan, state: { ...plan.state, plan: { ...plan.state.plan, schemaVersion: 99 } } };
  unsupported.fingerprint = createMergeRecordFingerprint(unsupported);
  await noWrite(auth, () => post(auth, "/v1/progress/sync", { canonicalVersion, deviceId, expectedAccountRevision: 0, sessionId: "unsupported-plan", batchId: "unsupported-plan", highWatermark: 1, mutations: [mutation(unsupported)] }, 400));
  const historical = await user();
  const oldSession = { recordId: f.finalized.session.id, recordType: "training_session_summary", trackId: f.finalized.session.trackId, state: f.finalized.session };
  const ref = db.collection("users").doc(historical.userId).collection("progress").doc("old-summary");
  await ref.create({ kind: "node", recordType: oldSession.recordType, trackId: oldSession.trackId, targetId: oldSession.recordId,
    state: oldSession.state, fingerprint: createMergeRecordFingerprint(oldSession), version: 1, lastMutationId: "historical-terminal-mutation", updatedAt: new Date("2026-10-14T10:00:00.000Z") });
  await noWrite(historical, async () => {
    await assert.rejects(context.stores.progress.readSnapshot(historical.userId), /progress_record_invalid/u);
    await assert.rejects(client(historical, []).getProgress());
  });
});

test("real three-family producer configurations and all five response variants remain admitted", async () => {
  const catalog = await loadCanonicalRuntimeCatalog();
  for (const [trackId, modeId] of [["coding-interview-dsa-problem-solving", "coding-interview-guided-practice"], ["backend-system-design-interview", "design-interview-tradeoff-practice"], ["google-cloud-associate-cloud-engineer", "certification-focus-practice"]]) {
    const track = catalog.getTrack(trackId), runtime = createCanonicalTrainingFamilyRuntime(track);
    const prepared = await runtime.prepare({ trackId, modeId, request: { sessionId: `wire-${modeId}`, requestedLength: 10 }, attempts: [], reviews: [], now: "2026-10-14T10:00:00.000Z" });
    const record = { recordId: prepared.session.id, recordType: "training_session_summary", trackId, state: projectTerminalSession(abandonTrainingSession(prepared.session, "2026-10-14T10:01:00.000Z")), version: 0 };
    assert.equal(guestMergeRecordSchema.safeParse({ ...record, fingerprint: createMergeRecordFingerprint(record) }).success, true, modeId);
  }
  for (const trackId of ["coding-interview-dsa-problem-solving", "backend-system-design-interview", "google-cloud-associate-cloud-engineer"]) {
    const track = catalog.getTrack(trackId), profile = track.simulationProfiles[0], runtime = createCanonicalTrainingFamilyRuntime(track);
    const prepared = await runtime.prepare({ trackId, modeId: profile.modeId, request: { sessionId: `wire-${profile.modeId}`, scope: { simulationProfileId: profile.profileId } }, attempts: [], reviews: [], now: "2026-10-14T10:00:00.000Z" });
    const responses = { requirements: "Users", architecture: "Queue", tradeoffs: "Duplicates", final_answer: "Café Cafe\u0301" };
    const draft = createTrainingSessionDraft({ sessionId: prepared.session.id, trackId, familyId: profile.familyId, revision: 1, responsesByOccurrenceId: profile.familyId === "design_interview" ? { [prepared.session.itemOrder[0].occurrenceId]: responses } : {}, flaggedOccurrenceIds: [], updatedAt: "2026-10-14T10:00:00.000Z" });
    const finalized = await runtime.finalizeSimulation({ session: prepared.session, draft, attempts: [], reviews: [], now: "2026-10-14T10:01:00.000Z" });
    for (const [recordType, state] of [["training_session_summary", projectTerminalSession(finalized.session)], ["training_session_result", finalized.result]]) {
      const record = { recordId: state.id, recordType, trackId, state: JSON.parse(JSON.stringify(state)), version: 0 };
      assert.equal(guestMergeRecordSchema.safeParse({ ...record, fingerprint: createMergeRecordFingerprint(record) }).success, true, `${profile.modeId}/${recordType}`);
    }
  }
  const f = await terminalWireFixture(), attempt = f.snapshot.records.find(r => r.recordType === "training_attempt");
  for (const response of [{ type: "choice_single", optionId: "a" }, { type: "choice_multiple", optionIds: ["a", "b"] }, { type: "ordering", orderedElementIds: ["a", "b"] }, { type: "complexity", selectedValueIdsByDimension: { runtime: ["n"] } }, { type: "decision_matrix", selectedValueIdsByDimension: { consistency: ["strong"] } }]) {
    const record = { ...attempt, state: { ...attempt.state, response } }; record.fingerprint = createMergeRecordFingerprint(record);
    assert.equal(guestMergeRecordSchema.safeParse(record).success, true);
    assert.equal(adoptionTransferRecordSchema.safeParse(record).success, true);
    assert.equal(progressMutationSchema.safeParse(mutation(record)).success, true);
  }
});
