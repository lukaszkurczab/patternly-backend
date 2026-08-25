import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import type { Environment } from "../../config/environment.js";

export type FirestoreRuntime = Readonly<{
  app: App;
  db: Firestore;
  ping: () => Promise<boolean>;
  close: () => Promise<void>;
}>;

export function createFirestoreRuntime(environment: Environment): FirestoreRuntime {
  if (!environment.firebaseProjectId) throw new Error("firestore_project_id_required");
  const existing = getApps().find((candidate) => candidate.options.projectId === environment.firebaseProjectId);
  const app = existing ?? initializeApp({ projectId: environment.firebaseProjectId });
  const db = getFirestore(app);
  return Object.freeze({
    app,
    db,
    async ping() {
      await db.collection("users").limit(1).get();
      return true;
    },
    close: () => db.terminate(),
  });
}
