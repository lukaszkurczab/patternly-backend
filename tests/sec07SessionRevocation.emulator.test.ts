import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { FixtureAccountLifecycleStore as FirestoreAccountLifecycleStore } from "./revenueCatDeletionFixture.js";
import { parsePseudonymKeyRing } from "../src/infrastructure/security/pseudonymKeyRing.js";
import { COLLECTIONS } from "../src/infrastructure/firestore/paths.js";
import { accountSessionRevokeSchema } from "../src/modules/account-lifecycle/contracts.js";
import { TEST_APP_CHECK_TOKEN, clearFirestore, createEmulatorContext, createRegisteredAuthUser, firestore, sessionRevocationId, testEnvironment, type EmulatorContext } from "./support.js";

const DAY = 24 * 60 * 60 * 1000;
let context: EmulatorContext;
test.before(async () => { context = createEmulatorContext(); await clearFirestore(); });
test.afterEach(async () => { await clearFirestore(); });
test.after(async () => { await context.close(); });

function fixtureStore(hooks: { revoke?: () => Promise<void>; mint?: () => Promise<string> } = {}) {
  const effects = { revoke: 0, mint: 0 };
  const store = new FirestoreAccountLifecycleStore(firestore(), {
    revokeRefreshTokens: async () => { effects.revoke += 1; await hooks.revoke?.(); },
    createCustomToken: async () => { effects.mint += 1; return hooks.mint ? hooks.mint() : "replacement-token"; },
    deleteUser: async () => undefined,
  }, parsePseudonymKeyRing(testEnvironment.deletionPseudonymKeysJson));
  return { store, effects };
}

function operationRef(id: string) { return firestore().collection(COLLECTIONS.sessionRevocationOperations).doc(id); }
function legacyRecord(id: string, userId: string, at: number, status = "revoked") {
  return { operationId: id, userId, expectedAuthorizationGeneration: 1, status, updatedAt: Timestamp.fromMillis(at), ...(status === "failed" ? { failureCode: "session_revocation_failed" } : {}) };
}

test("SEC-07 immutable 30-day expiry, failed mint retry, physical absence and conscious new revoke", async (t) => {
  const auth = await createRegisteredAuthUser(context);
  let clock = Date.now();
  t.mock.method(Timestamp, "now", () => Timestamp.fromMillis(clock));
  const id = sessionRevocationId(clock);
  let failMint = true;
  const { store, effects } = fixtureStore({ mint: async () => { if (failMint) throw new Error("fixture_mint_failure"); return "replacement-token"; } });
  await assert.rejects(store.revokeSessions(auth.userId, 1, id), { message: "session_reissue_failed" });
  const ref = operationRef(id);
  const completed = (await ref.get()).data()!;
  assert.equal(completed.status, "revoked");
  assert.equal(completed.terminalAt.toMillis(), clock);
  assert.equal(completed.expiresAt.toMillis(), clock + 30 * DAY);
  failMint = false;
  clock = completed.expiresAt.toMillis() - 1;
  await store.revokeSessions(auth.userId, 1, id);
  assert.deepEqual((await ref.get()).data(), completed);
  assert.deepEqual(effects, { revoke: 1, mint: 2 });
  clock += 1;
  await assert.rejects(store.revokeSessions(auth.userId, 1, id), { message: "session_revocation_operation_expired" });
  clock += 1;
  await assert.rejects(store.revokeSessions(auth.userId, 1, id), { message: "session_revocation_operation_expired" });
  await ref.delete(); // emulate eventual TTL, never a claim of managed TTL proof
  await assert.rejects(store.revokeSessions(auth.userId, 1, id), { message: "session_revocation_operation_expired" });
  assert.deepEqual(effects, { revoke: 1, mint: 2 });
  assert.equal((await ref.get()).exists, false);
  assert.equal((await firestore().collection(COLLECTIONS.users).doc(auth.userId).get()).get("securityOperation"), undefined);
  await store.revokeSessions(auth.userId, 1, sessionRevocationId(clock));
  assert.deepEqual(effects, { revoke: 2, mint: 3 });
});

test("SEC-07 absent-record first use accepts exact 29-day/+5min boundaries and rejects outside without effects", async (t) => {
  const auth = await createRegisteredAuthUser(context);
  const clock = Date.now();
  t.mock.method(Timestamp, "now", () => Timestamp.fromMillis(clock));
  const { store, effects } = fixtureStore();
  for (const time of [clock - 29 * DAY, clock + 5 * 60 * 1000]) await store.revokeSessions(auth.userId, 1, sessionRevocationId(time));
  assert.deepEqual(effects, { revoke: 2, mint: 2 });
  for (const id of [sessionRevocationId(clock - 29 * DAY - 1), sessionRevocationId(clock + 5 * 60 * 1000 + 1), randomUUID()]) {
    await assert.rejects(store.revokeSessions(auth.userId, 1, id), { message: "session_revocation_operation_expired" });
    assert.equal((await operationRef(id).get()).exists, false);
  }
  for (const id of ["invalid-id", (() => { const id = sessionRevocationId(clock); return `${id.slice(0, 14)}6${id.slice(15)}`; })(), (() => { const id = sessionRevocationId(clock); return `${id.slice(0, 19)}c${id.slice(20)}`; })()]) {
    await assert.rejects(store.revokeSessions(auth.userId, 1, id), { message: "session_revocation_operation_invalid" });
  }
  assert.deepEqual(effects, { revoke: 2, mint: 2 });
});

test("SEC-07 valid old v4/v7 pending and failed stay retryable without expiry", async (t) => {
  const auth = await createRegisteredAuthUser(context);
  const clock = Date.now();
  t.mock.method(Timestamp, "now", () => Timestamp.fromMillis(clock));
  for (const status of ["pending", "failed"]) for (const id of [randomUUID(), sessionRevocationId(clock - 90 * DAY)]) {
    const ref = operationRef(id);
    const original = legacyRecord(id, auth.userId, clock - 90 * DAY, status);
    await ref.set(original);
    const { store, effects } = fixtureStore({ revoke: async () => {
      const active = (await ref.get()).data()!;
      assert.equal(active.status, "pending");
      assert.equal("terminalAt" in active, false);
      assert.equal("expiresAt" in active, false);
      throw new Error("fixture_provider_failure");
    } });
    await assert.rejects(store.revokeSessions(auth.userId, 1, id), { message: "session_revocation_failed" });
    const failed = (await ref.get()).data()!;
    assert.equal(failed.status, "failed");
    assert.equal("terminalAt" in failed, false);
    assert.equal("expiresAt" in failed, false);
    assert.deepEqual(effects, { revoke: 1, mint: 0 });
  }
});

test("SEC-07 verified legacy terminal migration retains original deadline, expired v4 never reopens after delete", async (t) => {
  const auth = await createRegisteredAuthUser(context);
  const clock = Date.now();
  t.mock.method(Timestamp, "now", () => Timestamp.fromMillis(clock));
  const { store, effects } = fixtureStore();
  for (const elapsed of [DAY, 30 * DAY]) {
    const id = randomUUID();
    const ref = operationRef(id);
    await ref.set(legacyRecord(id, auth.userId, clock - elapsed));
    if (elapsed < 30 * DAY) await store.revokeSessions(auth.userId, 1, id);
    else await assert.rejects(store.revokeSessions(auth.userId, 1, id), { message: "session_revocation_operation_expired" });
    const migrated = (await ref.get()).data()!;
    assert.equal(migrated.terminalAt.toMillis(), clock - elapsed);
    assert.equal(migrated.expiresAt.toMillis(), clock - elapsed + 30 * DAY);
    if (elapsed < 30 * DAY) {
      await store.revokeSessions(auth.userId, 1, id);
      assert.deepEqual((await ref.get()).data(), migrated);
    }
    await ref.delete();
    await assert.rejects(store.revokeSessions(auth.userId, 1, id), { message: "session_revocation_operation_expired" });
  }
  assert.deepEqual(effects, { revoke: 0, mint: 2 });
});

test("SEC-07 malformed shapes, bindings and terminal deadlines refuse before provider or migration", async (t) => {
  const auth = await createRegisteredAuthUser(context);
  const clock = Date.now();
  t.mock.method(Timestamp, "now", () => Timestamp.fromMillis(clock));
  const { store, effects } = fixtureStore();
  for (const changes of [
    { status: "unknown" }, { operationId: randomUUID() }, { updatedAt: FieldValue.delete() }, { updatedAt: "yesterday" },
    { updatedAt: Timestamp.fromMillis(clock + 1) }, { unknown: true }, { failureCode: "surprise" },
    { terminalAt: Timestamp.fromMillis(clock - DAY) },
    { terminalAt: Timestamp.fromMillis(clock - DAY), expiresAt: Timestamp.fromMillis(clock + 1) },
    { status: "pending", expiresAt: Timestamp.fromMillis(clock + DAY) },
    { status: "failed", failureCode: "session_revocation_failed", terminalAt: Timestamp.fromMillis(clock) },
  ]) {
    const id = randomUUID();
    const ref = operationRef(id);
    await ref.set(legacyRecord(id, auth.userId, clock - DAY));
    await ref.update(changes);
    const before = (await ref.get()).data();
    await assert.rejects(store.revokeSessions(auth.userId, 1, id), { message: "session_revocation_operation_invalid" });
    assert.deepEqual((await ref.get()).data(), before);
  }
  for (const changes of [{ userId: "other-user" }, { expectedAuthorizationGeneration: 2 }]) {
    const id = randomUUID();
    await operationRef(id).set({ ...legacyRecord(id, auth.userId, clock - DAY), ...changes });
    await assert.rejects(store.revokeSessions(auth.userId, 1, id), { message: "session_revocation_operation_conflict" });
  }
  assert.deepEqual(effects, { revoke: 0, mint: 0 });
});

test("SEC-07 expiry, deletion and generation changes during mint never return a token", async (t) => {
  for (const change of ["expiry", "delete", "generation"]) {
    const auth = await createRegisteredAuthUser(context);
    let clock = Date.now();
    const clockMock = t.mock.method(Timestamp, "now", () => Timestamp.fromMillis(clock));
    const id = sessionRevocationId(clock);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { store, effects } = fixtureStore({ mint: async () => { entered(); await blocked; return "must-not-return"; } });
    const result = store.revokeSessions(auth.userId, 1, id);
    await started;
    if (change === "expiry") clock += 30 * DAY;
    else if (change === "delete") await firestore().collection(COLLECTIONS.users).doc(auth.userId).delete();
    else await firestore().collection(COLLECTIONS.users).doc(auth.userId).update({ authorizationGeneration: 2 });
    release();
    await assert.rejects(result, { message: change === "expiry" ? "session_revocation_operation_expired" : change === "delete" ? "account_deleted" : "authorization_generation_conflict" });
    assert.deepEqual(effects, { revoke: 1, mint: 1 });
    clockMock.mock.restore();
  }
});

test("SEC-07 route accepts actual client v7, reports old v4 expiry and local queue stays unresolved", async () => {
  const auth = await createRegisteredAuthUser(context);
  const frontend = resolve(process.env.PATTERNLY_FRONTEND_ROOT ?? "../patternly");
  const load = (path: string) => import(pathToFileURL(resolve(frontend, path)).href);
  const { createSessionRevocationOperationId } = await load("src/infrastructure/identity/sessionRevocationOperationId.ts");
  const { createLocalLogoutControl } = await load("src/infrastructure/storage/localLogoutControl.ts");
  const { createPatternlyApiClient } = await load("src/infrastructure/clients/PatternlyApiClientAdapter.ts");
  {
    const api = createPatternlyApiClient({ apiOrigin: "http://127.0.0.1:8080", allowLocalHttpForSimulator: true, getIdToken: async () => auth.idToken, getAppCheckToken: async () => TEST_APP_CHECK_TOKEN,
      fetchImplementation: async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await context.app.inject({ method: "POST", url: new URL(String(input)).pathname, headers: Object.fromEntries(new Headers(init?.headers)), payload: String(init?.body) });
        return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
      },
    });
    const values = new Map<string, string>();
    values.set("learning-progress-sentinel", "untouched");
    const control = createLocalLogoutControl({ get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { values.set(key, value); } });
    const oldId = randomUUID();
    await control.blockAndQueueRevoke(auth.localId, oldId);
    const before = await control.read();
    assert.equal(accountSessionRevokeSchema.safeParse({ operationId: oldId }).success, true);
    await assert.rejects(api.revokeSessions(oldId), { status: 409, serverCode: "session_revocation_operation_expired" });
    assert.deepEqual(await control.read(), before);
    const fresh = createSessionRevocationOperationId();
    assert.equal(accountSessionRevokeSchema.safeParse({ operationId: fresh }).success, true);
    await control.replaceExpiredPendingRevoke(auth.localId, oldId, fresh);
    const response = await api.revokeSessions(fresh);
    assert.equal(response.operationId, fresh);
    assert.equal(response.status, "revoked");
    await control.completePendingRevoke(auth.localId, fresh);
    assert.equal((await control.read()).pending.length, 0);
    assert.equal(values.get("learning-progress-sentinel"), "untouched");
  }
});
