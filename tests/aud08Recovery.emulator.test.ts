import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test, { after, before, describe } from "node:test";
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../src/infrastructure/firestore/paths.js";
import { createFirebaseAdminAuth } from "../src/infrastructure/firebase/adminAuth.js";
import { RecoveryOperationCipher } from "../src/modules/account-lifecycle/recoveryOperationCipher.js";
import { FirestoreAccountLifecycleStore } from "../src/modules/account-lifecycle/store.js";
import { PseudonymKeyRing } from "../src/infrastructure/security/pseudonymKeyRing.js";

type ClientUser = Readonly<{ uid: string; getIdToken(forceRefresh?: boolean): Promise<string> }>;
type ClientAuth = {
  currentUser: ClientUser | null;
  _delete(): Promise<void>;
};
type FirebaseClientModules = {
  app: {
    initializeApp(options: Record<string, unknown>, name: string): unknown;
    deleteApp(app: unknown): Promise<void>;
  };
  auth: {
    connectAuthEmulator(auth: ClientAuth, url: string, options: { disableWarnings: boolean }): void;
    getIdTokenResult(user: ClientUser, forceRefresh?: boolean): Promise<{ claims: Record<string, unknown> }>;
    inMemoryPersistence: unknown;
    initializeAuth(app: unknown, options: { persistence: unknown }): ClientAuth;
    signInWithCustomToken(auth: ClientAuth, token: string): Promise<{ user: ClientUser }>;
    signOut(auth: ClientAuth): Promise<void>;
  };
};

const ENABLED = process.env.AUD08_RECOVERY_EMULATOR_TESTS === "1";
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? "";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? "";
const FRONTEND_ROOT = process.env.PATTERNLY_FRONTEND_ROOT ?? "";
const EXPECTED_FRONTEND_SHA = process.env.PATTERNLY_FRONTEND_EXPECTED_SHA ?? "";
const TEST_GROUP = ENABLED ? describe : describe.skip;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const testKey = () => randomBytes(32).toString("base64");
const randomRecoveryCode = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(16);
  const raw = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
};
const RECOVERY_OPERATION_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

function assertTerminalRetention(snapshot: FirebaseFirestore.DocumentSnapshot, status: "acknowledged" | "superseded"): number {
  assert.equal(snapshot.get("status"), status);
  const terminalAt = snapshot.get("terminalAt") as { toMillis(): number } | undefined;
  const expiresAt = snapshot.get("expiresAt") as { toMillis(): number } | undefined;
  assert.ok(terminalAt && expiresAt, "terminal operations carry their transition time and TTL deadline");
  assert.equal(expiresAt.toMillis() - terminalAt.toMillis(), RECOVERY_OPERATION_TERMINAL_RETENTION_MS);
  return terminalAt.toMillis();
}

let adminApp: ReturnType<typeof initializeAdminApp>;
let db: ReturnType<typeof getFirestore>;
let adminAuth: ReturnType<typeof getAdminAuth>;
let accountAuth: ReturnType<typeof createFirebaseAdminAuth>;
let client: FirebaseClientModules;
let createdUserIds: string[] = [];
let createdFirebaseUids: string[] = [];
let createdOperationIds: string[] = [];
let createdCodeHashes: string[] = [];
let createdTombstoneIds: string[] = [];
let createdRateLimitIds: string[] = [];
let createdProofIds: string[] = [];

function requireSafeIsolatedConfiguration(): void {
  const hostPort = (value: string): Readonly<{ host: string; port: number }> => {
    const match = /^(127\.0\.0\.1|localhost):(\d{1,5})$/u.exec(value);
    if (!match) throw new Error("aud08_emulator_loopback_required");
    const port = Number(match[2]);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("aud08_emulator_port_invalid");
    return Object.freeze({ host: match[1]!, port });
  };
  if (!/^demo-[a-z0-9-]+$/u.test(PROJECT_ID)) throw new Error("aud08_demo_project_required");
  const authEndpoint = hostPort(AUTH_HOST);
  const firestoreEndpoint = hostPort(FIRESTORE_HOST);
  if (authEndpoint.port === 19_099 || firestoreEndpoint.port === 18_081) throw new Error("aud08_shared_emulator_forbidden");
  if (authEndpoint.port !== 19_119 || firestoreEndpoint.port !== 18_119) throw new Error("aud08_pinned_emulator_ports_required");
  if (!FRONTEND_ROOT || !EXPECTED_FRONTEND_SHA) throw new Error("aud08_frontend_pin_required");
  const actualSha = execFileSync("git", ["-C", FRONTEND_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (actualSha !== EXPECTED_FRONTEND_SHA) throw new Error("aud08_frontend_pin_mismatch");
}

async function deleteQuery(query: FirebaseFirestore.Query): Promise<void> {
  for (;;) {
    const page = await query.limit(300).get();
    if (page.empty) return;
    const batch = db.batch();
    for (const document of page.docs) batch.delete(document.ref);
    await batch.commit();
  }
}

async function cleanupOwnedDocuments(): Promise<void> {
  for (const userId of createdUserIds) {
    await deleteQuery(db.collection(COLLECTIONS.accountRecoveryOperations).where("userId", "==", userId));
    await deleteQuery(db.collection(COLLECTIONS.accountRecoveryOperationResults).where("userId", "==", userId));
    await deleteQuery(db.collection(COLLECTIONS.recoveryCodeIndex).where("userId", "==", userId));
    await deleteQuery(db.collection(COLLECTIONS.sessionRevocationOperations).where("userId", "==", userId));
    await db.collection(COLLECTIONS.users).doc(userId).collection("security").doc("recoveryCodes").delete().catch(() => undefined);
    await db.collection(COLLECTIONS.users).doc(userId).delete().catch(() => undefined);
  }
  for (const operationId of createdOperationIds) {
    await db.collection(COLLECTIONS.accountDeletionOperations).doc(operationId).delete().catch(() => undefined);
    await db.collection(COLLECTIONS.sessionRevocationOperations).doc(operationId).delete().catch(() => undefined);
  }
  for (const proofId of createdProofIds) await db.collection(COLLECTIONS.deletionProofs).doc(proofId).delete().catch(() => undefined);
  for (const id of createdCodeHashes) await db.collection(COLLECTIONS.recoveryCodeIndex).doc(id).delete().catch(() => undefined);
  for (const id of createdRateLimitIds) await db.collection(COLLECTIONS.rateLimitBuckets).doc(id).delete().catch(() => undefined);
  for (const id of createdTombstoneIds) {
    await db.collection(COLLECTIONS.identityMappings).doc(id).delete().catch(() => undefined);
    await db.collection(COLLECTIONS.deletedIdentities).doc(id).delete().catch(() => undefined);
  }
  for (const uid of createdFirebaseUids) await adminAuth.deleteUser(uid).catch(() => undefined);
  createdUserIds = [];
  createdFirebaseUids = [];
  createdOperationIds = [];
  createdCodeHashes = [];
  createdRateLimitIds = [];
  createdProofIds = [];
  createdTombstoneIds = [];
}

async function makeAccount(): Promise<Readonly<{ userId: string; firebaseUid: string; code: string; operationId: string; cipher: RecoveryOperationCipher; ring: PseudonymKeyRing }>> {
  const userId = randomUUID();
  const firebaseUid = `aud08-${randomUUID()}`;
  const code = randomRecoveryCode();
  const operationId = randomUUID();
  const generationId = randomUUID();
  const ring = new PseudonymKeyRing([{ version: "test_v1", status: "active", keyBase64: testKey() }]);
  const cipher = new RecoveryOperationCipher([{ version: "test_v1", status: "active", keyBase64: testKey() }]);
  await adminAuth.createUser({ uid: firebaseUid, disabled: false });
  createdUserIds.push(userId);
  createdFirebaseUids.push(firebaseUid);
  createdOperationIds.push(operationId);
  const userRef = db.collection(COLLECTIONS.users).doc(userId);
  const pseudonym = ring.active("firebase", firebaseUid);
  createdTombstoneIds.push(pseudonym.documentId);
  await userRef.set({ authorizationGeneration: 1, authorizationState: "active" });
  await db.collection(COLLECTIONS.identityMappings).doc(pseudonym.documentId).set({
    keyVersion: pseudonym.keyVersion,
    provider: "firebase",
    subject: firebaseUid,
    subjectHmac: pseudonym.subjectHmac,
    userId,
  });
  const codeHash = sha256(code);
  createdCodeHashes.push(codeHash);
  await db.collection(COLLECTIONS.recoveryCodeIndex).doc(codeHash).set({ userId, generationId, usedAt: null });
  return Object.freeze({ userId, firebaseUid, code, operationId, cipher, ring });
}

before(() => {
  if (!ENABLED) return;
  requireSafeIsolatedConfiguration();
  process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST;
  process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST;
  adminApp = initializeAdminApp({ projectId: PROJECT_ID }, `aud08-store-${process.pid}`);
  db = getFirestore(adminApp);
  adminAuth = getAdminAuth(adminApp);
  accountAuth = createFirebaseAdminAuth(adminApp);
  const frontendRequire = createRequire(resolve(FRONTEND_ROOT, "package.json"));
  client = Object.freeze({ app: frontendRequire("firebase/app") as FirebaseClientModules["app"], auth: frontendRequire("firebase/auth") as FirebaseClientModules["auth"] });
});

after(async () => {
  if (!ENABLED || !db || !adminApp) return;
  await cleanupOwnedDocuments();
  await deleteAdminApp(adminApp);
});

TEST_GROUP(ENABLED
  ? "AUD-08 B2 recovery store isolated emulator tests"
  : "AUD-08 B2 recovery emulator matrix (skipped: set AUD08_RECOVERY_EMULATOR_TESTS=1 and provide the dedicated demo emulator pins)", () => {
  test("durable request rate bucket fails closed on a corrupt counter", async () => {
    const requesterHash = sha256(`aud08-test:${randomUUID()}`);
    const nowMs = Date.now();
    const windowMs = 60_000;
    const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
    const bucketId = sha256(`recovery-request:${requesterHash}:${windowStartMs}`);
    createdRateLimitIds.push(bucketId);
    const store = new FirestoreAccountLifecycleStore(db, accountAuth, new PseudonymKeyRing([{ version: "test_v1", status: "active", keyBase64: testKey() }]));
    await store.claimRecoveryRequestRateLimit(requesterHash, 2, 60);
    await store.claimRecoveryRequestRateLimit(requesterHash, 2, 60);
    await assert.rejects(store.claimRecoveryRequestRateLimit(requesterHash, 2, 60), { message: "recovery_rate_limited" });
    await db.collection(COLLECTIONS.rateLimitBuckets).doc(bucketId).update({ count: Number.NaN });
    await assert.rejects(store.claimRecoveryRequestRateLimit(requesterHash, 2, 60), { message: "recovery_rate_limit_invalid" });
    const stored = await db.collection(COLLECTIONS.rateLimitBuckets).doc(bucketId).get();
    assert.equal(stored.get("requesterHash"), requesterHash);
    assert.equal(Number.isNaN(stored.get("count")), true);
  });

  test("missing recovery runtime fails before reservation writes", async () => {
    const fixture = await makeAccount();
    const store = new FirestoreAccountLifecycleStore(db, accountAuth, fixture.ring, null);
    await assert.rejects(store.consumeRecoveryCode(fixture.operationId, fixture.code), { message: "recovery_operations_unavailable" });
    assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId).get()).exists, false);
    assert.equal((await db.collection(COLLECTIONS.recoveryCodeIndex).doc(sha256(fixture.code)).get()).get("usedAt"), null);
    assert.equal((await db.collection(COLLECTIONS.users).doc(fixture.userId).get()).get("authorizationGeneration"), 1);
  });

  test("recovery result is persisted, replayed identically, and accepted by the pinned Firebase SDK", async () => {
    const fixture = await makeAccount();
    const store = new FirestoreAccountLifecycleStore(db, accountAuth, fixture.ring, { cipher: fixture.cipher });
    const first = await store.consumeRecoveryCode(fixture.operationId, fixture.code);
    assert.equal(first.status, "result_available");
    if (first.status !== "result_available") throw new Error("recovery_result_missing");
    assert.equal(first.firebaseUid, fixture.firebaseUid);
    assert.equal(first.authorizationGeneration, 2);
    assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId).get()).get("expiresAt"), undefined);
    const replay = await store.consumeRecoveryCode(fixture.operationId, fixture.code);
    assert.equal(replay.status, "result_available");
    if (replay.status !== "result_available") throw new Error("recovery_replay_missing");
    assert.equal(replay.customToken, first.customToken, "same operation retry must return persisted winner token");
    assert.equal(replay.authorizationGeneration, 2);

    const webApp = client.app.initializeApp({
      apiKey: "fake-api-key",
      appId: `1:1234567890:web:${randomUUID().replaceAll("-", "")}`,
      authDomain: `${PROJECT_ID}.firebaseapp.com`,
      projectId: PROJECT_ID,
    }, `aud08-client-${randomUUID()}`);
    const auth = client.auth.initializeAuth(webApp, { persistence: client.auth.inMemoryPersistence });
    client.auth.connectAuthEmulator(auth, `http://${AUTH_HOST}`, { disableWarnings: true });
    try {
      const signedIn = await client.auth.signInWithCustomToken(auth, first.customToken);
      assert.equal(signedIn.user.uid, fixture.firebaseUid, "custom-token sign-in must target the mapped Firebase UID");
      const initial = await client.auth.getIdTokenResult(signedIn.user);
      assert.equal(initial.claims.sub, fixture.firebaseUid);
      assert.equal(initial.claims.authorizationGeneration, 2);
      const refreshed = await client.auth.getIdTokenResult(signedIn.user, true);
      assert.equal(refreshed.claims.sub, fixture.firebaseUid);
      assert.equal(refreshed.claims.authorizationGeneration, 2);
      const acknowledgement = await store.acknowledgeRecovery(fixture.operationId, fixture.userId, 2);
      assert.deepEqual(acknowledgement, { operationId: fixture.operationId, status: "acknowledged", authorizationGeneration: 2 });
      const saved = await db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId).get();
      const result = await db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(fixture.operationId).get();
      assertTerminalRetention(saved, "acknowledged");
      assert.equal(result.exists, false);
    } finally {
      await client.auth.signOut(auth);
      await auth._delete();
      await client.app.deleteApp(webApp);
    }
  });

  test("provider failure resumes the same reserved generation and wrong proof cannot take over an operation", async () => {
    const fixture = await makeAccount();
    let tokenCalls = 0;
    const failingAuth = {
      createCustomToken: async (uid: string, claims?: Readonly<Record<string, unknown>>) => {
        tokenCalls += 1;
        if (tokenCalls === 1) throw new Error("temporary_auth_provider_failure");
        return accountAuth.createCustomToken(uid, claims);
      },
      revokeRefreshTokens: (uid: string) => accountAuth.revokeRefreshTokens(uid),
      deleteUser: (uid: string) => accountAuth.deleteUser(uid),
    };
    const runtime = { cipher: fixture.cipher } as const;
    const firstStore = new FirestoreAccountLifecycleStore(db, failingAuth, fixture.ring, runtime);
    const failed = await firstStore.consumeRecoveryCode(fixture.operationId, fixture.code);
    assert.equal(failed.status, "provider_retryable");
    const afterFailure = await db.collection(COLLECTIONS.users).doc(fixture.userId).get();
    assert.equal(afterFailure.get("authorizationGeneration"), 2);
    assert.equal(afterFailure.get("authorizationRotatedAtSeconds") <= Math.ceil(Date.now() / 1_000), true);
    await assert.rejects(firstStore.consumeRecoveryCode(fixture.operationId, "ZZZZ-ZZZZ-ZZZZ-ZZZZ"), { message: "recovery_operation_conflict" });
    const resumed = await new FirestoreAccountLifecycleStore(db, failingAuth, fixture.ring, runtime).consumeRecoveryCode(fixture.operationId, fixture.code);
    assert.equal(resumed.status, "result_available");
    if (resumed.status !== "result_available") throw new Error("recovery_resume_missing");
    assert.equal(resumed.authorizationGeneration, 2);
    assert.equal(tokenCalls, 2, "retry should mint once after the injected provider failure");
    assert.equal((await db.collection(COLLECTIONS.users).doc(fixture.userId).get()).get("authorizationGeneration"), 2);
  });

  test("same-operation concurrent minters return only the persisted fenced winner", async () => {
    const fixture = await makeAccount();
    let enteredFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolvePromise) => { enteredFirst = resolvePromise; });
    const firstBlocked = new Promise<void>((resolvePromise) => { releaseFirst = resolvePromise; });
    let mintCalls = 0;
    const racingAuth = {
      createCustomToken: async () => {
        mintCalls += 1;
        if (mintCalls === 1) {
          enteredFirst();
          await firstBlocked;
          return "stale-loser-token";
        }
        return "persisted-winner-token";
      },
      revokeRefreshTokens: (uid: string) => accountAuth.revokeRefreshTokens(uid),
      deleteUser: (uid: string) => accountAuth.deleteUser(uid),
    };
    const store = new FirestoreAccountLifecycleStore(db, racingAuth, fixture.ring, { cipher: fixture.cipher });
    const firstPromise = store.consumeRecoveryCode(fixture.operationId, fixture.code);
    await firstEntered;
    const second = await store.consumeRecoveryCode(fixture.operationId, fixture.code);
    assert.equal(second.status, "result_available");
    if (second.status !== "result_available") throw new Error("recovery_race_winner_missing");
    assert.equal(second.customToken, "persisted-winner-token");
    releaseFirst();
    const first = await firstPromise;
    assert.equal(first.status, "result_available");
    if (first.status !== "result_available") throw new Error("recovery_race_loser_missing_winner");
    assert.equal(first.customToken, "persisted-winner-token");
    assert.equal(mintCalls, 2);
    const result = await db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(fixture.operationId).get();
    assert.equal(result.get("authorizationGeneration"), 2);
  });

  test("expired result resumes the same generation and a different valid last code supersedes only after expiry", async () => {
    const fixture = await makeAccount();
    const store = new FirestoreAccountLifecycleStore(db, accountAuth, fixture.ring, { cipher: fixture.cipher });
    const original = await store.consumeRecoveryCode(fixture.operationId, fixture.code);
    assert.equal(original.status, "result_available");
    const expiredAt = new Date(Date.now() - 1_000);
    await db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId).update({ resultExpiresAt: expiredAt });
    await db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(fixture.operationId).update({ expiresAt: expiredAt });
    await db.collection(COLLECTIONS.users).doc(fixture.userId).update({ "securityOperation.leaseUntil": expiredAt });
    const resumed = await store.consumeRecoveryCode(fixture.operationId, fixture.code);
    assert.equal(resumed.status, "result_available");
    if (resumed.status !== "result_available") throw new Error("recovery_same_generation_resume_missing");
    assert.equal(resumed.authorizationGeneration, 2);
    assert.notEqual(resumed.customToken, "");
    assert.equal((await db.collection(COLLECTIONS.users).doc(fixture.userId).get()).get("authorizationGeneration"), 2);

    const lastCode = randomRecoveryCode();
    const lastCodeHash = sha256(lastCode);
    createdCodeHashes.push(lastCodeHash);
    await db.collection(COLLECTIONS.recoveryCodeIndex).doc(lastCodeHash).set({ userId: fixture.userId, generationId: randomUUID(), usedAt: null });
    await db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId).update({ resultExpiresAt: expiredAt });
    await db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(fixture.operationId).update({ expiresAt: expiredAt });
    await db.collection(COLLECTIONS.users).doc(fixture.userId).update({ "securityOperation.leaseUntil": expiredAt });
    const nextOperationId = randomUUID();
    createdOperationIds.push(nextOperationId);
    const takenOver = await store.consumeRecoveryCode(nextOperationId, lastCode);
    assert.equal(takenOver.status, "result_available");
    if (takenOver.status !== "result_available") throw new Error("recovery_takeover_missing");
    assert.equal(takenOver.authorizationGeneration, 3);
    const previous = await db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId).get();
    assertTerminalRetention(previous, "superseded");
    assert.notEqual((await db.collection(COLLECTIONS.recoveryCodeIndex).doc(lastCodeHash).get()).get("usedAt"), null);
  });

  test("expired rotating provider failure permits only a fenced new-code takeover", async () => {
    const fixture = await makeAccount();
    const runtime = { cipher: fixture.cipher } as const;
    const unavailableAuth = {
      createCustomToken: async () => { throw new Error("auth_provider_unavailable"); },
      revokeRefreshTokens: (uid: string) => accountAuth.revokeRefreshTokens(uid),
      deleteUser: (uid: string) => accountAuth.deleteUser(uid),
    };
    const initial = await new FirestoreAccountLifecycleStore(db, unavailableAuth, fixture.ring, runtime).consumeRecoveryCode(fixture.operationId, fixture.code);
    assert.equal(initial.status, "provider_retryable");
    assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId).get()).get("expiresAt"), undefined);
    const userRef = db.collection(COLLECTIONS.users).doc(fixture.userId);
    const beforeExpiry = await userRef.get();
    assert.equal(beforeExpiry.get("authorizationState"), "rotating");
    assert.equal(beforeExpiry.get("authorizationGeneration"), 2);
    const priorBarrier = Math.floor(Date.now() / 1_000) - 30;
    const expiredAt = new Date(Date.now() - 1_000);
    await userRef.update({ authorizationRotatedAtSeconds: priorBarrier, "securityOperation.leaseUntil": expiredAt });
    await db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId).update({ resultExpiresAt: expiredAt });

    const nextCode = randomRecoveryCode();
    const nextCodeHash = sha256(nextCode);
    createdCodeHashes.push(nextCodeHash);
    await db.collection(COLLECTIONS.recoveryCodeIndex).doc(nextCodeHash).set({ userId: fixture.userId, generationId: randomUUID(), usedAt: null });
    const nextOperationId = randomUUID();
    createdOperationIds.push(nextOperationId);
    const beforeTakeoverBarrier = Math.ceil(Date.now() / 1_000);
    const next = await new FirestoreAccountLifecycleStore(db, accountAuth, fixture.ring, runtime).consumeRecoveryCode(nextOperationId, nextCode);
    assert.equal(next.status, "result_available");
    if (next.status !== "result_available") throw new Error("rotating_takeover_missing");
    assert.equal(next.authorizationGeneration, 3);
    const after = await userRef.get();
    assert.equal(after.get("authorizationGeneration"), 3);
    assert.equal(after.get("authorizationState"), "active");
    assert.equal(Number(after.get("authorizationRotatedAtSeconds")) >= beforeTakeoverBarrier, true);
    assert.equal(Number(after.get("authorizationRotatedAtSeconds")) > priorBarrier, true);
    assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId).get()).get("status"), "superseded");
    assert.equal((await new FirestoreAccountLifecycleStore(db, accountAuth, fixture.ring, runtime).readRecoveryOperationStatus(fixture.operationId, fixture.code))?.status, "superseded");
    assert.notEqual((await db.collection(COLLECTIONS.recoveryCodeIndex).doc(nextCodeHash).get()).get("usedAt"), null);
  });

  test("ACK binds exact user and generation, is idempotent after a lost response, and corrupt AEAD never changes stored state", async () => {
    const fixture = await makeAccount();
    const store = new FirestoreAccountLifecycleStore(db, accountAuth, fixture.ring, { cipher: fixture.cipher });
    const result = await store.consumeRecoveryCode(fixture.operationId, fixture.code);
    assert.equal(result.status, "result_available");
    await assert.rejects(store.acknowledgeRecovery(fixture.operationId, randomUUID(), 2), { message: "recovery_operation_not_found" });
    const otherAccount = await makeAccount();
    await assert.rejects(store.acknowledgeRecovery(fixture.operationId, otherAccount.userId, 2), { message: "recovery_operation_conflict" });
    await assert.rejects(store.acknowledgeRecovery(fixture.operationId, fixture.userId, 3), { message: "recovery_operation_conflict" });
    await assert.rejects(store.acknowledgeRecovery(randomUUID(), fixture.userId, 2), { message: "recovery_operation_not_found" });
    const resultRef = db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(fixture.operationId);
    const persistedResult = await resultRef.get();
    const envelope = persistedResult.get("envelope") as Record<string, unknown>;
    await resultRef.update({ "envelope.tag": "corrupt" });
    await assert.rejects(store.readRecoveryOperationStatus(fixture.operationId, fixture.code), { message: "invalid_recovery_operation_envelope" });
    assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId).get()).get("status"), "result_available");
    assert.equal((await resultRef.get()).exists, true);
    await resultRef.update({ envelope });
    const expiredAt = new Date(Date.now() - 1_000);
    await db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId).update({ resultExpiresAt: expiredAt });
    await resultRef.update({ expiresAt: expiredAt });
    assert.equal((await store.readRecoveryOperationStatus(fixture.operationId, fixture.code))?.status, "provider_retryable");
    assert.equal((await resultRef.get()).exists, false);
    const noCipherStore = new FirestoreAccountLifecycleStore(db, accountAuth, fixture.ring, null);
    const firstAck = await noCipherStore.acknowledgeRecovery(fixture.operationId, fixture.userId, 2);
    const firstAckOperation = await db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId).get();
    const firstTerminalAt = assertTerminalRetention(firstAckOperation, "acknowledged");
    const replayAck = await noCipherStore.acknowledgeRecovery(fixture.operationId, fixture.userId, 2);
    assert.deepEqual(replayAck, firstAck);
    assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId).get()).get("terminalAt").toMillis(), firstTerminalAt);
    assert.equal("customToken" in firstAck, false);
    const nextCode = randomRecoveryCode();
    const nextCodeHash = sha256(nextCode);
    createdCodeHashes.push(nextCodeHash);
    await db.collection(COLLECTIONS.recoveryCodeIndex).doc(nextCodeHash).set({ userId: fixture.userId, generationId: randomUUID(), usedAt: null });
    const nextOperation = randomUUID();
    createdOperationIds.push(nextOperation);
    const next = await store.consumeRecoveryCode(nextOperation, nextCode);
    assert.equal(next.status, "result_available");
    await assert.rejects(noCipherStore.acknowledgeRecovery(fixture.operationId, fixture.userId, 2), { message: "authorization_generation_conflict" });
  });

  test("reissue retry returns the same encrypted code set and ACK never returns plaintext", async () => {
    const fixture = await makeAccount();
    const store = new FirestoreAccountLifecycleStore(db, accountAuth, fixture.ring, { cipher: fixture.cipher });
    const reissueId = randomUUID();
    createdOperationIds.push(reissueId);
    const reauthenticatedAtSeconds = Math.floor(Date.now() / 1_000);
    const first = await store.issueRecoveryCodes(fixture.userId, 1, reissueId, reauthenticatedAtSeconds);
    assert.equal(first.status, "result_available");
    if (first.status !== "result_available") throw new Error("reissue_result_missing");
    assert.equal(first.codes.length, 10);
    const replay = await store.issueRecoveryCodes(fixture.userId, 1, reissueId, reauthenticatedAtSeconds);
    assert.deepEqual(replay, first);
    const resultDoc = await db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(reissueId).get();
    const envelope = resultDoc.get("envelope") as Record<string, unknown>;
    assert.equal(typeof envelope.ciphertext, "string");
    assert.equal(JSON.stringify(resultDoc.data()).includes(first.codes[0]!), false);
    assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperations).doc(reissueId).get()).get("expiresAt"), undefined);
    const acknowledgement = await store.acknowledgeRecoveryCodeIssue(reissueId, fixture.userId, 1);
    assert.deepEqual(acknowledgement, { operationId: reissueId, status: "acknowledged", authorizationGeneration: 1 });
    assert.equal("codes" in acknowledgement, false);
    const acknowledgedOperation = await db.collection(COLLECTIONS.accountRecoveryOperations).doc(reissueId).get();
    assertTerminalRetention(acknowledgedOperation, "acknowledged");
    assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(reissueId).get()).exists, false);
    const hashes = await db.collection(COLLECTIONS.recoveryCodeIndex).where("userId", "==", fixture.userId).get();
    assert.equal(hashes.size, 10);
  });

  test("live recovery ownership blocks reissue until the current generation is ACKed", async () => {
    const fixture = await makeAccount();
    const runtime = { cipher: fixture.cipher } as const;
    const store = new FirestoreAccountLifecycleStore(db, accountAuth, fixture.ring, runtime);
    const recovery = await store.consumeRecoveryCode(fixture.operationId, fixture.code);
    assert.equal(recovery.status, "result_available");
    const reissueId = randomUUID();
    createdOperationIds.push(reissueId);
    const reauthTime = Math.floor(Date.now() / 1_000);
    await assert.rejects(store.issueRecoveryCodes(fixture.userId, 2, reissueId, reauthTime), { message: "operation_in_progress" });
    assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperations).doc(reissueId).get()).exists, false);
    await store.acknowledgeRecovery(fixture.operationId, fixture.userId, 2);
    const issued = await store.issueRecoveryCodes(fixture.userId, 2, reissueId, reauthTime);
    assert.equal(issued.status, "result_available");
    if (issued.status !== "result_available") throw new Error("post_ack_reissue_missing");
    assert.equal(issued.authorizationGeneration, 2);
  });

  test("issue status expires at the original reauthentication deadline without replacing valid recovery codes", async () => {
    const fixture = await makeAccount();
    const store = new FirestoreAccountLifecycleStore(db, accountAuth, fixture.ring, { cipher: fixture.cipher });
    const operationId = randomUUID();
    createdOperationIds.push(operationId);
    const result = await store.issueRecoveryCodes(fixture.userId, 1, operationId, Math.floor(Date.now() / 1_000));
    assert.equal(result.status, "result_available");
    const expiredAt = new Date(Date.now() - 1_000);
    await db.collection(COLLECTIONS.accountRecoveryOperations).doc(operationId).update({
      retryDeadline: expiredAt,
      resultExpiresAt: expiredAt,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
    });
    await db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(operationId).update({ expiresAt: expiredAt });
    const status = await store.readRecoveryCodeIssueStatus(operationId, fixture.userId, 1);
    assert.equal(status?.status, "delivery_unconfirmed");
    assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperations).doc(operationId).get()).get("expiresAt"), undefined);
    await db.collection(COLLECTIONS.accountRecoveryOperations).doc(operationId).update({ expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000) });
    assert.equal((await store.readRecoveryCodeIssueStatus(operationId, fixture.userId, 1))?.status, "delivery_unconfirmed");
    assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperations).doc(operationId).get()).get("expiresAt"), undefined);
    assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(operationId).get()).exists, false);
    const codes = await db.collection(COLLECTIONS.recoveryCodeIndex).where("userId", "==", fixture.userId).get();
    assert.equal(codes.size, 10, "delivery uncertainty must preserve the valid set installed by the operation");
  });

  test("replacing an orphaned unconfirmed reissue supersedes only the matched generation and starts 30-day history", async () => {
    const fixture = await makeAccount();
    const store = new FirestoreAccountLifecycleStore(db, accountAuth, fixture.ring, { cipher: fixture.cipher });
    const oldOperationId = randomUUID();
    createdOperationIds.push(oldOperationId);
    const first = await store.issueRecoveryCodes(fixture.userId, 1, oldOperationId, Math.floor(Date.now() / 1_000));
    assert.equal(first.status, "result_available");
    if (first.status !== "result_available") throw new Error("reissue_result_missing");
    const expiredAt = new Date(Date.now() - 1_000);
    await db.collection(COLLECTIONS.accountRecoveryOperations).doc(oldOperationId).update({ retryDeadline: expiredAt, resultExpiresAt: expiredAt });
    await db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(oldOperationId).update({ expiresAt: expiredAt });
    assert.equal((await store.readRecoveryCodeIssueStatus(oldOperationId, fixture.userId, 1))?.status, "delivery_unconfirmed");
    assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperations).doc(oldOperationId).get()).get("expiresAt"), undefined);

    const replacementId = randomUUID();
    createdOperationIds.push(replacementId);
    const replacement = await store.issueRecoveryCodes(fixture.userId, 1, replacementId, Math.floor(Date.now() / 1_000));
    assert.equal(replacement.status, "result_available");
    const replacedOperation = await db.collection(COLLECTIONS.accountRecoveryOperations).doc(oldOperationId).get();
    assertTerminalRetention(replacedOperation, "superseded");
    assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(oldOperationId).get()).exists, false);
    assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(replacementId).get()).exists, true);
  });

  test("ambiguous recovery-code generations block replacement without guessing a terminal timestamp", async () => {
    const fixture = await makeAccount();
    const store = new FirestoreAccountLifecycleStore(db, accountAuth, fixture.ring, { cipher: fixture.cipher });
    const oldOperationId = randomUUID();
    createdOperationIds.push(oldOperationId);
    const first = await store.issueRecoveryCodes(fixture.userId, 1, oldOperationId, Math.floor(Date.now() / 1_000));
    assert.equal(first.status, "result_available");
    if (first.status !== "result_available") throw new Error("reissue_result_missing");
    const expiredAt = new Date(Date.now() - 1_000);
    await db.collection(COLLECTIONS.accountRecoveryOperations).doc(oldOperationId).update({ retryDeadline: expiredAt, resultExpiresAt: expiredAt });
    await db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(oldOperationId).update({ expiresAt: expiredAt });
    assert.equal((await store.readRecoveryCodeIssueStatus(oldOperationId, fixture.userId, 1))?.status, "delivery_unconfirmed");

    const secondGenerationHash = sha256(randomRecoveryCode());
    createdCodeHashes.push(secondGenerationHash);
    await db.collection(COLLECTIONS.recoveryCodeIndex).doc(secondGenerationHash).set({
      userId: fixture.userId,
      generationId: randomUUID(),
      usedAt: null,
    });
    const replacementId = randomUUID();
    createdOperationIds.push(replacementId);
    await assert.rejects(
      store.issueRecoveryCodes(fixture.userId, 1, replacementId, Math.floor(Date.now() / 1_000)),
      { message: "recovery_operation_conflict" },
    );
    const oldOperation = await db.collection(COLLECTIONS.accountRecoveryOperations).doc(oldOperationId).get();
    assert.equal(oldOperation.get("status"), "delivery_unconfirmed");
    assert.equal(oldOperation.get("expiresAt"), undefined);
    assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperations).doc(replacementId).get()).exists, false);
  });

  test("deletion scrubs an encrypted recovery result without a configured recovery key", async () => {
    const fixture = await makeAccount();
    const opRef = db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId);
    const resultRef = db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(fixture.operationId);
    const fakeEnvelope = { ciphertext: "not-decryptable", keyVersion: "removed-key", tag: "bad", version: 1, iv: "bad" };
    await opRef.set({
      operationId: fixture.operationId,
      userId: fixture.userId,
      kind: "recovery",
      status: "result_available",
      expectedAuthorizationGeneration: 1,
      resultingAuthorizationGeneration: 2,
      fence: "recovery-owner-fence",
      resultExpiresAt: new Date(Date.now() + 60_000),
    });
    await resultRef.set({ operationId: fixture.operationId, userId: fixture.userId, kind: "recovery", envelope: fakeEnvelope, expiresAt: new Date(Date.now() + 60_000) });
    await db.collection(COLLECTIONS.users).doc(fixture.userId).set({
      authorizationGeneration: 1,
      authorizationState: "active",
      securityOperation: {
        kind: "account_recovery",
        operationId: fixture.operationId,
        expectedAuthorizationGeneration: 1,
        fence: "recovery-owner-fence",
        leaseUntil: new Date(Date.now() + 60_000),
      },
    });
    const store = new FirestoreAccountLifecycleStore(db, accountAuth, fixture.ring, null);
    const deletionId = randomUUID();
    createdOperationIds.push(deletionId);
    const deletionSecret = randomBytes(32).toString("hex");
    const deleted = await store.deleteAccount(fixture.userId, 1, deletionId, deletionSecret);
    createdProofIds.push(deleted.proofId);
    assert.equal((await opRef.get()).exists, false);
    assert.equal((await resultRef.get()).exists, false);
    assert.equal((await db.collection(COLLECTIONS.users).doc(fixture.userId).get()).exists, false);
  });

  test("session revoke supersedes expired recovery result without cipher configuration", async () => {
    const fixture = await makeAccount();
    const operationRef = db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId);
    const resultRef = db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(fixture.operationId);
    const expiredAt = new Date(Date.now() - 1_000);
    await operationRef.set({ operationId: fixture.operationId, userId: fixture.userId, kind: "reissue", status: "result_available", expectedAuthorizationGeneration: 1, retryDeadline: expiredAt, resultExpiresAt: expiredAt, fence: "expired-reissue-fence" });
    await resultRef.set({ operationId: fixture.operationId, userId: fixture.userId, kind: "reissue", envelope: { corrupt: true }, expiresAt: expiredAt });
    await db.collection(COLLECTIONS.users).doc(fixture.userId).update({
      securityOperation: { kind: "recovery_reissue", operationId: fixture.operationId, expectedAuthorizationGeneration: 1, fence: "expired-reissue-fence", leaseUntil: expiredAt },
    });
    const noKeyAuth = {
      createCustomToken: async () => "replacement-token",
      revokeRefreshTokens: async () => undefined,
      deleteUser: (uid: string) => accountAuth.deleteUser(uid),
    };
    const store = new FirestoreAccountLifecycleStore(db, noKeyAuth, fixture.ring, null);
    const revokeId = randomUUID();
    createdOperationIds.push(revokeId);
    const revoked = await store.revokeSessions(fixture.userId, 1, revokeId);
    assert.equal(revoked.status, "revoked");
    assertTerminalRetention(await operationRef.get(), "superseded");
    assert.equal((await resultRef.get()).exists, false);
  });

  test("current-session deletion fences a late remint before it can publish a recovery result", async () => {
    const fixture = await makeAccount();
    const runtime = { cipher: fixture.cipher } as const;
    const store = new FirestoreAccountLifecycleStore(db, accountAuth, fixture.ring, runtime);
    const original = await store.consumeRecoveryCode(fixture.operationId, fixture.code);
    assert.equal(original.status, "result_available");
    if (original.status !== "result_available") throw new Error("initial_recovery_result_missing");

    const webApp = client.app.initializeApp({
      apiKey: "fake-api-key",
      appId: `1:1234567890:web:${randomUUID().replaceAll("-", "")}`,
      authDomain: `${PROJECT_ID}.firebaseapp.com`,
      projectId: PROJECT_ID,
    }, `aud08-delete-client-${randomUUID()}`);
    const auth = client.auth.initializeAuth(webApp, { persistence: client.auth.inMemoryPersistence });
    client.auth.connectAuthEmulator(auth, `http://${AUTH_HOST}`, { disableWarnings: true });
    try {
      const signedIn = await client.auth.signInWithCustomToken(auth, original.customToken);
      assert.equal(signedIn.user.uid, fixture.firebaseUid);
      assert.equal((await client.auth.getIdTokenResult(signedIn.user)).claims.authorizationGeneration, 2);

      const expiredAt = new Date(Date.now() - 1_000);
      await db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId).update({ resultExpiresAt: expiredAt });
      await db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(fixture.operationId).update({ expiresAt: expiredAt });
      await db.collection(COLLECTIONS.users).doc(fixture.userId).update({ "securityOperation.leaseUntil": expiredAt });
      let remintEntered!: () => void;
      let releaseRemint!: () => void;
      const entered = new Promise<void>((resolvePromise) => { remintEntered = resolvePromise; });
      const blocked = new Promise<void>((resolvePromise) => { releaseRemint = resolvePromise; });
      const lateMintAuth = {
        createCustomToken: async () => { remintEntered(); await blocked; return "late-recovery-token"; },
        revokeRefreshTokens: (uid: string) => accountAuth.revokeRefreshTokens(uid),
        deleteUser: (uid: string) => accountAuth.deleteUser(uid),
      };
      const pendingRemint = new FirestoreAccountLifecycleStore(db, lateMintAuth, fixture.ring, runtime)
        .consumeRecoveryCode(fixture.operationId, fixture.code);
      await entered;
      const deletionId = randomUUID();
      createdOperationIds.push(deletionId);
      let deletionUserEntered!: () => void;
      let releaseDeletionUser!: () => void;
      const deletingUser = new Promise<void>((resolvePromise) => { deletionUserEntered = resolvePromise; });
      const deletionBlocked = new Promise<void>((resolvePromise) => { releaseDeletionUser = resolvePromise; });
      const pausedDeleteAuth = {
        createCustomToken: (uid: string, claims?: Readonly<Record<string, unknown>>) => accountAuth.createCustomToken(uid, claims),
        revokeRefreshTokens: (uid: string) => accountAuth.revokeRefreshTokens(uid),
        deleteUser: async (uid: string) => { deletionUserEntered(); await deletionBlocked; await accountAuth.deleteUser(uid); },
      };
      const deletionPromise = new FirestoreAccountLifecycleStore(db, pausedDeleteAuth, fixture.ring, null)
        .deleteAccount(fixture.userId, 2, deletionId, randomBytes(32).toString("hex"));
      await deletingUser;
      let retentionFailure: unknown;
      try {
        assertTerminalRetention(await db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId).get(), "superseded");
        assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(fixture.operationId).get()).exists, false);
      } catch (error) {
        retentionFailure = error;
      } finally {
        releaseDeletionUser();
      }
      const deletion = await deletionPromise;
      createdProofIds.push(deletion.proofId);
      if (retentionFailure !== undefined) throw retentionFailure;
      assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId).get()).exists, false);
      assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(fixture.operationId).get()).exists, false);
      assert.equal((await db.collection(COLLECTIONS.users).doc(fixture.userId).get()).exists, false);
      releaseRemint();
      const late = await pendingRemint;
      assert.equal(late.status, "superseded");
    } finally {
      await client.auth.signOut(auth);
      await auth._delete();
      await client.app.deleteApp(webApp);
    }
  });

  test("current-session ACK fences an in-flight remint and leaves no late ciphertext", async () => {
    const fixture = await makeAccount();
    const runtime = { cipher: fixture.cipher } as const;
    const store = new FirestoreAccountLifecycleStore(db, accountAuth, fixture.ring, runtime);
    const original = await store.consumeRecoveryCode(fixture.operationId, fixture.code);
    assert.equal(original.status, "result_available");
    if (original.status !== "result_available") throw new Error("initial_recovery_result_missing");
    const webApp = client.app.initializeApp({
      apiKey: "fake-api-key",
      appId: `1:1234567890:web:${randomUUID().replaceAll("-", "")}`,
      authDomain: `${PROJECT_ID}.firebaseapp.com`,
      projectId: PROJECT_ID,
    }, `aud08-ack-client-${randomUUID()}`);
    const auth = client.auth.initializeAuth(webApp, { persistence: client.auth.inMemoryPersistence });
    client.auth.connectAuthEmulator(auth, `http://${AUTH_HOST}`, { disableWarnings: true });
    try {
      const signedIn = await client.auth.signInWithCustomToken(auth, original.customToken);
      assert.equal(signedIn.user.uid, fixture.firebaseUid);
      assert.equal((await client.auth.getIdTokenResult(signedIn.user)).claims.authorizationGeneration, 2);

      const expiredAt = new Date(Date.now() - 1_000);
      await db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId).update({ resultExpiresAt: expiredAt });
      await db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(fixture.operationId).update({ expiresAt: expiredAt });
      await db.collection(COLLECTIONS.users).doc(fixture.userId).update({ "securityOperation.leaseUntil": expiredAt });
      let remintEntered!: () => void;
      let releaseRemint!: () => void;
      const entered = new Promise<void>((resolvePromise) => { remintEntered = resolvePromise; });
      const blocked = new Promise<void>((resolvePromise) => { releaseRemint = resolvePromise; });
      const lateMintAuth = {
        createCustomToken: async () => { remintEntered(); await blocked; return "late-recovery-token"; },
        revokeRefreshTokens: (uid: string) => accountAuth.revokeRefreshTokens(uid),
        deleteUser: (uid: string) => accountAuth.deleteUser(uid),
      };
      const pendingRemint = new FirestoreAccountLifecycleStore(db, lateMintAuth, fixture.ring, runtime)
        .consumeRecoveryCode(fixture.operationId, fixture.code);
      await entered;
      const acknowledgement = await new FirestoreAccountLifecycleStore(db, accountAuth, fixture.ring, null)
        .acknowledgeRecovery(fixture.operationId, fixture.userId, 2);
      assert.equal(acknowledgement.status, "acknowledged");
      releaseRemint();
      const late = await pendingRemint;
      assert.equal(late.status, "acknowledged");
      assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(fixture.operationId).get()).exists, false);
      assert.equal((await db.collection(COLLECTIONS.accountRecoveryOperations).doc(fixture.operationId).get()).get("status"), "acknowledged");
      assert.equal((await db.collection(COLLECTIONS.users).doc(fixture.userId).get()).get("authorizationGeneration"), 2);
    } finally {
      await client.auth.signOut(auth);
      await auth._delete();
      await client.app.deleteApp(webApp);
    }
  });
});
