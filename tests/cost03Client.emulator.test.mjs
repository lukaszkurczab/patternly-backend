import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { progressDocumentId } from "../src/infrastructure/firestore/paths.ts";
import { createEmulatorContext, createRegisteredAuthUser, TEST_APP_CHECK_TOKEN } from "./support.ts";
import { attemptState } from "./progressFixtures.ts";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.ts";
import { validateIsolatedEmulatorRuntime } from "../scripts/isolated-emulator-test-runner.mjs";
validateIsolatedEmulatorRuntime(process.env, "demo-patternly-cost03");
const frontendRoot = process.env.PATTERNLY_FRONTEND_ROOT;
const expectedSha = process.env.PATTERNLY_FRONTEND_EXPECTED_SHA;
if (!frontendRoot || !/^[a-f0-9]{40}$/u.test(expectedSha ?? "")) throw new Error("cost03_frontend_pin_required");
if (execFileSync("git", ["-C", frontendRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== expectedSha) throw new Error("cost03_frontend_pin_mismatch");
const load = createRequire(resolve(frontendRoot, "package.json"));
const { createPatternlyApiClient } = load(resolve(frontendRoot, "src/infrastructure/clients/PatternlyApiClientAdapter.ts"));
const context = createEmulatorContext();
test.after(async () => context.close());
const deviceId = "00000000-0000-4000-8000-000000000000";
function mutation(id) {
  const trackId = "coding-interview-dsa-problem-solving";
  const state = attemptState(id, trackId);
  return { mutationId: `cost03-mutation-${id}`, kind: "item", recordType: "training_attempt", trackId, targetId: id, expectedVersion: null, state,
    fingerprint: createMergeRecordFingerprint({ recordId: id, recordType: "training_attempt", trackId, state }) };
}
async function fixture(existingAuth) {
  const auth = existingAuth ?? await createRegisteredAuthUser(context);
  let actor = auth; let fail = false; let lostAck = false; let beforeToken = null; const calls = [];
  const api = createPatternlyApiClient({ apiOrigin: "https://cost03.test.invalid", getIdToken: async () => { const hook = beforeToken; beforeToken = null; if (hook) await hook(); return actor.idToken; }, getAppCheckToken: async () => TEST_APP_CHECK_TOKEN,
    fetchImplementation: async (url, init) => {
      const parsed = new URL(String(url));
      if (fail) { fail = false; throw new Error("cost03_offline_fixture"); }
      const response = await context.app.inject({ method: init.method, url: parsed.pathname + parsed.search, headers: Object.fromEntries(new Headers(init.headers).entries()), ...(init.body ? { payload: JSON.parse(String(init.body)) } : {}) });
      const body = response.json(); calls.push({ url: parsed, body, status: response.statusCode });
      if (lostAck && parsed.pathname.endsWith("/sync") && response.statusCode === 200) { lostAck = false; throw new Error("cost03_ack_lost_after_commit"); }
      return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
    } });
  return { auth, api, calls, switchTo: (next) => { actor = next; }, failNext: () => { fail = true; }, loseNextAck: () => { lostAck = true; }, beforeNextToken: (hook) => { beforeToken = hook; } };
}
async function write(auth, id, revision = 0) {
  const result = await context.stores.progress.applyBatch(auth.userId, 1, deviceId, revision, [mutation(id)], { sessionId: "cost03-second-client", batchId: id, highWatermark: revision + 1 });
  assert.equal(result.applied.length, 1);
}

test("actual APP/backend conditional contract keeps history, catches another client, handles offline/retry and scopes account switches", async () => {
  const f = await fixture(); await write(f.auth, "account-a-first");
  const first = await f.api.getProgress(); assert.equal(first.records.length, 1);
  const again = await f.api.getProgress(); assert.deepEqual(again, first);
  assert.equal(f.calls.at(-1).body.unchanged, true);
  const restarted = await fixture(f.auth);
  assert.deepEqual(await restarted.api.getProgress(), first);
  assert.equal(restarted.calls.at(-1).body.unchanged, undefined, "a fresh adapter always reads a full snapshot");
  // A separate writer commits while the first adapter retains its snapshot.
  await write(f.auth, "account-a-second", 1);
  const changed = await f.api.getProgress(); assert.equal(changed.records.length, 2);
  assert.equal(changed.accountRevision, 2); assert.equal(f.calls.at(-1).body.unchanged, undefined);
  f.failNext(); await assert.rejects(f.api.getProgress(), (error) => error.code === "transport_failed");
  assert.deepEqual(await f.api.getProgress(), changed);
  assert.equal(f.calls.at(-1).url.searchParams.has("knownSnapshot"), false);
  const other = await createRegisteredAuthUser(context); await write(other, "account-b-first"); await write(other, "account-b-second", 1);
  f.switchTo(other);
  const switched = await f.api.getProgress();
  assert.equal(switched.accountRevision, changed.accountRevision);
  assert.deepEqual(switched.records.map((r) => r.targetId).sort(), ["account-b-first", "account-b-second"]);
  assert.equal(f.calls.at(-1).body.unchanged, undefined);
  assert.deepEqual(await f.api.getProgress(), switched); assert.equal(f.calls.at(-1).body.unchanged, true);
});

test("actual conditional API denies revoked/deleted identities and invalid request combinations", async () => {
  for (const kind of ["revoke", "delete"]) {
    const f = await fixture(); await f.api.getProgress(); await f.api.getProgress();
    assert.equal(f.calls.at(-1).body.unchanged, true);
    const user = context.db.collection("users").doc(f.auth.userId);
    if (kind === "revoke") await user.update({ authorizationGeneration: 2 }); else await user.update({ authorizationState: "revoked" });
    await assert.rejects(f.api.getProgress(), (error) => error.code === "server_error" && [401, 409].includes(error.status));
  }
  const f = await fixture();
  for (const query of ["conditional=0", "knownSnapshot=" + "a".repeat(64), "conditional=1&knownSnapshot=bad", "conditional=1&knownSnapshot=" + "a".repeat(64) + "&pageToken=bad"]) {
    const response = await context.app.inject({ method: "GET", url: `/v1/progress?${query}`, headers: { authorization: `Bearer ${f.auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
    assert.equal(response.statusCode, 400);
  }
  const legacy = await context.app.inject({ method: "GET", url: "/v1/progress", headers: { authorization: `Bearer ${f.auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  assert.equal(legacy.statusCode, 200);
  assert.deepEqual(Object.keys(legacy.json()).sort(), ["accountRevision", "generation", "nextPageToken", "records"]);
  assert.equal(legacy.headers["cache-control"], "private, no-store");
});

const request = (mutations, revision = 0, batchId = "cache-proof") => ({ canonicalVersion: "canonical-json-v1", deviceId, sessionId: "cost03-cache-session", batchId, highWatermark: revision + 1, expectedAccountRevision: revision, mutations });
const ids = (result) => result.records.map((record) => record.targetId).sort();

test("fresh exact multi-batch ACKs and updates compose the complete canonical ordered history", async () => {
  const f = await fixture(); await f.api.getProgress();
  const first = Array.from({ length: 100 }, (_, i) => mutation(`multi-${String(i).padStart(3, "0")}`));
  const second = Array.from({ length: 21 }, (_, i) => mutation(`multi-${String(i + 100).padStart(3, "0")}`));
  assert.equal((await f.api.syncProgress(request(first))).applied.length, 100);
  assert.equal((await f.api.syncProgress(request(second, 100, "cache-second"))).applied.length, 21);
  const complete = await f.api.getProgress();
  assert.equal(f.calls.at(-1).body.unchanged, true);
  assert.equal(f.calls.at(-1).url.searchParams.get("knownRevision"), "121");
  assert.equal(complete.records.length, 121);
  const fresh = await fixture(f.auth);
  assert.deepEqual(complete, await fresh.api.getProgress(), "composed result must match the real complete paginated backend including document-ID order");
  const changed = mutation("multi-012"); changed.expectedVersion = 1; changed.mutationId = "cost03-multi-update-0001";
  changed.state = attemptState(changed.targetId, changed.trackId, "updated-answer");
  changed.fingerprint = createMergeRecordFingerprint({ recordId: changed.targetId, recordType: changed.recordType, trackId: changed.trackId, state: changed.state });
  await f.api.syncProgress(request([changed], 121, "cache-update"));
  const updated = await f.api.getProgress(); assert.equal(updated.records.length, 121);
  assert.equal(f.calls.at(-1).body.unchanged, true);
  assert.equal(updated.records.find((record) => record.targetId === changed.targetId).version, 2);
  assert.deepEqual(updated, await fresh.api.getProgress());
  const receipts = await context.db.collection("users").doc(f.auth.userId).collection("syncBatches").get();
  assert.ok(receipts.docs.every((doc) => !Object.hasOwn(doc.data().result, "snapshotScope")), "ephemeral provenance must not change stored receipts");
});

test("another client after own ACK forces a full read that retains both clients' histories", async () => {
  const f = await fixture(); await f.api.getProgress();
  await f.api.syncProgress(request([mutation("own-new")]));
  await write(f.auth, "second-client-after-ack", 1);
  const remote = await f.api.getProgress();
  assert.equal(f.calls.at(-1).url.searchParams.get("knownRevision"), "1");
  assert.equal(f.calls.at(-1).body.unchanged, undefined);
  assert.deepEqual(ids(remote), ["own-new", "second-client-after-ack"]);
});

test("delayed sync token acquisition across A to B to A cannot promote B ACKs into A cache", async () => {
  const f = await fixture(); await write(f.auth, "account-a-original"); await f.api.getProgress();
  const other = await createRegisteredAuthUser(context); await write(other, "account-b-original");
  let tokenRequested; const started = new Promise((resolve) => { tokenRequested = resolve; });
  let release; const wait = new Promise((resolve) => { release = resolve; });
  f.beforeNextToken(async () => { tokenRequested(); await wait; });
  const pending = f.api.syncProgress(request([mutation("belongs-to-b")], 1, "delayed-actor"));
  await started; f.switchTo(other); release();
  assert.equal((await pending).accountRevision, 2);
  await write(f.auth, "account-a-concurrent", 1);
  f.switchTo(f.auth);
  const result = await f.api.getProgress();
  assert.equal(f.calls.at(-1).url.searchParams.has("knownScope"), false, "different scope ACK cannot advance the earlier cache");
  assert.equal(result.accountRevision, 2);
  assert.deepEqual(ids(result), ["account-a-concurrent", "account-a-original"]);
  assert.equal(result.records.some((record) => record.targetId === "belongs-to-b"), false);
});

test("lost ACK after commit and a historical receipt retry preserve exact once-only history without promotion proof", async () => {
  const f = await fixture(); await f.api.getProgress();
  const body = request([mutation("lost-ack-history")]);
  f.loseNextAck();
  await assert.rejects(f.api.syncProgress(body), (error) => error.code === "transport_failed");
  const initialAck = f.calls.at(-1).body;
  assert.ok(initialAck.snapshotScope);
  const retried = await f.api.syncProgress(body);
  assert.equal(f.calls.at(-1).body.snapshotScope, undefined, "stored replay cannot claim fresh transaction provenance");
  assert.deepEqual(retried.applied, initialAck.applied);
  const result = await f.api.getProgress();
  assert.equal(f.calls.at(-1).body.unchanged, undefined);
  assert.deepEqual(ids(result), ["lost-ack-history"]);
  assert.equal(result.accountRevision, 1);
  assert.equal((await context.db.collection("users").doc(f.auth.userId).collection("progress").get()).size, 1);
});

test("same revision generation promotion invalidates a composed snapshot", async () => {
  const f = await fixture(); await f.api.getProgress();
  await f.api.syncProgress(request([mutation("old-generation-history")]));
  const replacement = mutation("new-generation-history");
  const user = context.db.collection("users").doc(f.auth.userId);
  const batch = context.db.batch();
  batch.set(user.collection("progressGenerations").doc("1").collection("records").doc(progressDocumentId(replacement)), {
    kind: replacement.kind, recordType: replacement.recordType, trackId: replacement.trackId, targetId: replacement.targetId,
    state: replacement.state, fingerprint: replacement.fingerprint, version: 1, lastMutationId: replacement.mutationId,
    updatedAt: Timestamp.now(), generation: 1,
  });
  batch.set(user.collection("syncMetadata").doc("account"), { generation: 1, accountRevision: 1 });
  await batch.commit();
  const result = await f.api.getProgress();
  assert.equal(f.calls.at(-1).body.unchanged, undefined);
  assert.equal(result.generation, 1); assert.equal(result.accountRevision, 1);
  assert.deepEqual(ids(result), ["new-generation-history"]);
});

test("composed history cannot bypass revoke, delete or an adoption lease", async () => {
  for (const kind of ["revoke", "delete", "lease"]) {
    const f = await fixture(); await f.api.getProgress(); await f.api.syncProgress(request([mutation(`denial-${kind}`)]));
    const user = context.db.collection("users").doc(f.auth.userId);
    if (kind === "revoke") await user.update({ authorizationGeneration: 2 });
    else if (kind === "delete") await user.update({ authorizationState: "revoked" });
    else await user.collection("syncMetadata").doc("account").update({ adoptionPromotionSessionId: "race", adoptionPromotionLeaseExpiresAt: Timestamp.fromMillis(Date.now() + 60_000) });
    await assert.rejects(f.api.getProgress(), (error) => error.code === "server_error" && [401, 409].includes(error.status));
  }
});

test("retrying the write transaction derives ACK scope from the successful attempt only", async () => {
  const f = await fixture(); await f.api.getProgress();
  const original = context.db.runTransaction.bind(context.db);
  let attempts = 0; let abortedScope; let promoteBeforeRetry = false;
  context.db.runTransaction = (callback, ...options) => original(async (transaction) => {
    // Change generation after the failed attempt released its read locks and
    // before the next attempt reads metadata; never write through its lock.
    if (promoteBeforeRetry) {
      promoteBeforeRetry = false;
      await context.db.collection("users").doc(f.auth.userId).collection("syncMetadata").doc("account").set({ generation: 1, accountRevision: 0 });
    }
    const value = await callback(transaction);
    if (Array.isArray(value?.applied)) {
      attempts++;
      if (attempts === 1) {
        abortedScope = value.snapshotScope;
        promoteBeforeRetry = true;
        throw Object.assign(new Error("cost03_controlled_aborted_transaction"), { code: 10 });
      }
    }
    return value;
  }, ...options);
  try { await f.api.syncProgress(request([mutation("retry-generation-history")])); }
  finally { context.db.runTransaction = original; }
  assert.equal(attempts, 2);
  const successfulScope = f.calls.at(-1).body.snapshotScope;
  assert.notEqual(successfulScope, abortedScope);
  const result = await f.api.getProgress();
  assert.equal(f.calls.at(-1).url.searchParams.has("knownScope"), false, "scope from the failed attempt cannot authorize promotion");
  assert.equal(f.calls.at(-1).body.snapshotScope, successfulScope);
  assert.equal(result.generation, 1); assert.equal(result.accountRevision, 1);
  assert.deepEqual(ids(result), ["retry-generation-history"]);
});
