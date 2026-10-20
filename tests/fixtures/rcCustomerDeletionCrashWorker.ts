import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createFirebaseAdminAuth } from "../../src/infrastructure/firebase/adminAuth.js";
import { PseudonymKeyRing } from "../../src/infrastructure/security/pseudonymKeyRing.js";
import { FirestoreAccountLifecycleStore } from "../../src/modules/account-lifecycle/store.js";

const [userId, operationId, secret, markerId] = process.argv.slice(2);
const firebaseProjectId = process.env.FIREBASE_PROJECT_ID ?? "";
const revenueCatProjectId = process.env.RC_DELETE_PROJECT_ID ?? "";
const pseudonymKey = process.env.RC_DELETE_PSEUDONYM_KEY ?? "";
if (!userId || !operationId || !secret || !markerId || !/^demo-patternly-rc-customer-deletion$/u.test(firebaseProjectId) || !/^proj[A-Za-z0-9]+$/u.test(revenueCatProjectId) || !pseudonymKey) {
  throw new Error("rc_delete_crash_worker_configuration_invalid");
}
const app = initializeApp({ projectId: firebaseProjectId }, `rc-delete-crash-worker-${process.pid}`);
const db = getFirestore(app);
const auth = createFirebaseAdminAuth(app);
const never = new Promise<never>(() => undefined);
const store = new FirestoreAccountLifecycleStore(db, auth, new PseudonymKeyRing([{ version: "rc_test_v1", status: "active", keyBase64: pseudonymKey }]), null, {
  projectId: revenueCatProjectId,
  client: {
    projectId: revenueCatProjectId,
    deleteCustomer: async (appUserId) => {
      await db.collection("rcCustomerDeletionFixtures").doc(markerId).set({ appUserId, effect: "accepted-by-fake", workerPid: process.pid });
      if (typeof process.send !== "function") throw new Error("rc_delete_worker_ipc_unavailable");
      process.send({ type: "fake_provider_effect_recorded" });
      return never;
    },
  },
});

void store.deleteAccount(userId, 1, operationId, secret).finally(() => deleteApp(app));
