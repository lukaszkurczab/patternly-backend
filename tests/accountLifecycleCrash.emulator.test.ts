import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { validateIsolatedEmulatorRuntime } from "../scripts/isolated-emulator-test-runner.mjs";
import { createFirebaseAdminAuth } from "../src/infrastructure/firebase/adminAuth.js";
import { COLLECTIONS } from "../src/infrastructure/firestore/paths.js";
import { PseudonymKeyRing } from "../src/infrastructure/security/pseudonymKeyRing.js";
import { FixtureAccountLifecycleStore as FirestoreAccountLifecycleStore } from "./revenueCatDeletionFixture.js";

const enabled = process.env.B4_CRASH_TESTS === "1";
for (const kind of ["revoke", "deletion"] as const) {
  test(`B4 SIGKILL after real ${kind} effect preserves unfinalized operation and resumes exact ID`, { skip: !enabled, timeout: 180_000 }, async (t) => {
    validateIsolatedEmulatorRuntime(process.env, "demo-patternly-b4-crash");
    const app = initializeApp({ projectId: "demo-patternly-b4-crash" }, `b4-parent-${kind}`);
    const db = getFirestore(app);
    const admin = getAuth(app);
    const actual = createFirebaseAdminAuth(app);
    const keyBase64 = randomBytes(32).toString("base64");
    const ring = new PseudonymKeyRing([{ version: "crash_v1", status: "active", keyBase64 }]);
    const userId = `b4-crash-user-${randomUUID()}`;
    const uid = `b4-crash-auth-${randomUUID()}`;
    const foreignId = `b4-crash-user-${randomUUID()}`;
    const secret = randomBytes(32).toString("hex");
    const time = Date.now().toString(16).padStart(12, "0");
    const operationId = kind === "revoke" ? `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}` : randomUUID();
    const userRef = db.collection(COLLECTIONS.users).doc(userId);
    const foreignRef = db.collection(COLLECTIONS.users).doc(foreignId);
    const identity = ring.active("firebase", uid);
    const identityRef = db.collection(COLLECTIONS.identityMappings).doc(identity.documentId);
    const opRef = db.collection(kind === "revoke" ? COLLECTIONS.sessionRevocationOperations : COLLECTIONS.accountDeletionOperations).doc(operationId);
    const worker = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/accountLifecycleCrashWorker.ts", import.meta.url))], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: process.env });
    let proofId: string | null = null;
    let workerKilled = false;
    try {
      await admin.createUser({ uid });
      await userRef.set({ authorizationGeneration: 1, authorizationState: "active" });
      await identityRef.set({ userId, provider: "firebase", subject: uid, keyVersion: identity.keyVersion, subjectHmac: identity.subjectHmac });
      await foreignRef.set({ authorizationGeneration: 7, authorizationState: "active", preserved: "foreign-learning-sentinel" });
      const foreignBefore = (await foreignRef.get()).data();
      const effect = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("provider_gate_timeout")), 15_000);
        worker.once("message", (message) => {
          clearTimeout(timer);
          if ((message as { stage?: string }).stage !== "provider_effect_complete") reject(Error("provider_gate_failed"));
          else resolve();
        });
        worker.once("error", () => { clearTimeout(timer); reject(Error("worker_start_failed")); });
      });
      worker.send({ kind, userId, operationId, operationSecret: secret, keyBase64 });
      await effect;
      const beforeKill = (await opRef.get()).data()!;
      assert.equal(beforeKill.status, kind === "revoke" ? "pending" : "remote_deleting");
      if (kind === "deletion") {
        assert.equal(beforeKill.phase, "auth_deleting");
        proofId = beforeKill.proofId as string;
        assert.equal((await db.collection(COLLECTIONS.deletionProofs).doc(proofId).get()).exists, false);
        await assert.rejects(admin.getUser(uid), (error: unknown) => (error as { code?: string }).code === "auth/user-not-found");
      }
      const exited = once(worker, "exit");
      assert.equal(worker.kill("SIGKILL"), true);
      const [code, signal] = await exited;
      workerKilled = true;
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
      assert.deepEqual((await opRef.get()).data(), beforeKill, "no catch/finalize/release ran after provider effect");
      const calls = { revoke: 0, mint: 0, delete: 0 };
      const restored = new FirestoreAccountLifecycleStore(db, {
        createCustomToken: async (...args) => { calls.mint++; return actual.createCustomToken(...args); },
        revokeRefreshTokens: async (subject) => { calls.revoke++; await actual.revokeRefreshTokens(subject); },
        deleteUser: async (subject) => { calls.delete++; await actual.deleteUser(subject); },
      }, ring, null);
      if (kind === "revoke") await assert.rejects(restored.revokeSessions(userId, 1, operationId), { message: "session_revocation_in_progress" });
      else {
        assert.equal((await restored.resumeDeletion(operationId, secret))?.status, "pending");
        assert.equal(await restored.resumeDeletion(operationId, "0".repeat(64)), null);
        await assert.rejects(restored.revokeSessions(userId, 1, operationId), { message: "authorization_generation_conflict" });
      }
      assert.deepEqual(calls, { revoke: 0, mint: 0, delete: 0 });
      // Natural lease expiry, no clock mock or rewrite of persisted ownership.
      const lease = (kind === "revoke" ? (await userRef.get()).get("securityOperation.leaseUntil") : beforeKill.leaseUntil) as Timestamp;
      while (Date.now() <= lease.toMillis()) await new Promise(resolve => setTimeout(resolve, Math.min(5000, lease.toMillis() - Date.now() + 10)));
      assert.ok(Date.now() > lease.toMillis());
      if (kind === "revoke") {
        assert.equal((await restored.revokeSessions(userId, 1, operationId)).status, "revoked");
        assert.equal(calls.revoke, 1, "unfinalized idempotent effect is retried; not guessed ACK");
        await restored.revokeSessions(userId, 1, operationId);
        assert.equal(calls.revoke, 1, "terminal replay never revokes again");
        await userRef.update({ authorizationGeneration: 2 });
        const mints = calls.mint;
        await assert.rejects(restored.revokeSessions(userId, 1, operationId), { message: "authorization_generation_conflict" });
        assert.equal(calls.mint, mints);
      } else {
        const result = await restored.resumeDeletion(operationId, secret);
        assert.equal(result?.status, "complete");
        assert.equal(result.proofId, proofId);
        assert.equal((await restored.readDeletionProof(proofId!))?.operationId, operationId);
        assert.deepEqual(await restored.resumeDeletion(operationId, secret), result);
        assert.equal(calls.mint, 0);
        assert.equal(calls.delete, 1, "user-not-found reconciles the previously completed Admin effect");
        assert.equal((await userRef.get()).exists, false);
      }
      assert.deepEqual((await foreignRef.get()).data(), foreignBefore);
      t.diagnostic(`SIGKILL=${workerKilled}; durable phase unchanged; natural lease expiry; exact ${kind} resumed; foreign preserved; stale generation non-minting`);
    } finally {
      if (!workerKilled) worker.kill("SIGKILL");
      await db.recursiveDelete(userRef);
      await foreignRef.delete();
      await identityRef.delete();
      await db.collection(COLLECTIONS.deletedIdentities).doc(identity.documentId).delete();
      await opRef.delete();
      if (proofId) await db.collection(COLLECTIONS.deletionProofs).doc(proofId).delete();
      await actual.deleteUser(uid);
      await db.terminate();
      await deleteApp(app);
    }
  });
}
