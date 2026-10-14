import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
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
const { retryPendingAccountDataSync } = load("application/account/accountDataService.ts");
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
context.app.addHook("onSend", async (request, reply, payload) => {
  if (request.url === "/v1/progress/sync") wire.push({ status: reply.statusCode, body: JSON.parse(String(payload)) });
  return payload;
});
const origin = await context.app.listen({ host: "127.0.0.1", port: 0 });
function client(auth, calls) {
  return createPatternlyApiClient({ apiOrigin: origin, allowLocalHttpForSimulator: true,
    getIdToken: async () => auth.idToken, getAppCheckToken: async () => TEST_APP_CHECK_TOKEN,
    fetchImplementation: async (url, init) => { calls.push({ path: new URL(url).pathname, method: init.method }); return fetch(url, init); },
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
