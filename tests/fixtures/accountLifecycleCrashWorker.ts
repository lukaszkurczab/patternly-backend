import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createFirebaseAdminAuth } from "../../src/infrastructure/firebase/adminAuth.js";
import { PseudonymKeyRing } from "../../src/infrastructure/security/pseudonymKeyRing.js";
import { FirestoreAccountLifecycleStore } from "../../src/modules/account-lifecycle/store.js";

// Test-only child. IPC is acknowledged after the real Admin effect returns;
// the parent kills this process before the store can persist finalization.
if (process.env.FIREBASE_PROJECT_ID !== "demo-patternly-b4-crash"
  || process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:19119"
  || process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:18119" || !process.send) throw Error("fixture_runtime_rejected");

process.once("message", (input: unknown) => {
  void (async () => {
    const value = input as Record<string, unknown>;
    if (!value || !["revoke", "deletion"].includes(String(value.kind))
      || typeof value.userId !== "string" || !value.userId.startsWith("b4-crash-user-")
      || typeof value.operationId !== "string" || typeof value.operationSecret !== "string"
      || typeof value.keyBase64 !== "string") throw Error("fixture_input_rejected");
    const app = initializeApp({ projectId: "demo-patternly-b4-crash" }, `b4-worker-${process.pid}`);
    const actual = createFirebaseAdminAuth(app);
    const stopAfterEffect = async () => {
      process.send!({ stage: "provider_effect_complete", kind: value.kind });
      setInterval(() => {}, 1000);
      await new Promise<never>(() => {});
    };
    const auth = {
      ...actual,
      revokeRefreshTokens: async (uid: string) => { await actual.revokeRefreshTokens(uid); if (value.kind === "revoke") await stopAfterEffect(); },
      deleteUser: async (uid: string) => { await actual.deleteUser(uid); if (value.kind === "deletion") await stopAfterEffect(); },
    };
    const ring = new PseudonymKeyRing([{ version: "crash_v1", status: "active", keyBase64: value.keyBase64 }]);
    const store = new FirestoreAccountLifecycleStore(getFirestore(app), auth, ring, null);
    if (value.kind === "revoke") await store.revokeSessions(value.userId, 1, value.operationId);
    else await store.deleteAccount(value.userId, 1, value.operationId, value.operationSecret);
    throw Error("fixture_effect_gate_missed");
  })().catch(() => { process.send?.({ stage: "worker_failed" }); process.exitCode = 1; process.disconnect(); });
});
