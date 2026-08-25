import { getAppCheck } from "firebase-admin/app-check";
import { getApps, initializeApp } from "firebase-admin/app";
import type { Environment } from "../../config/environment.js";

export interface AppCheckTokenVerifier {
  verify(token: string): Promise<void>;
}

export function createFirebaseAppCheckVerifier(environment: Environment): AppCheckTokenVerifier | null {
  if (!environment.firebaseProjectId) return null;
  const app = getApps().find((candidate) => candidate.options.projectId === environment.firebaseProjectId)
    ?? initializeApp({ projectId: environment.firebaseProjectId });
  const appCheck = getAppCheck(app);
  return Object.freeze({
    async verify(token: string): Promise<void> {
      await appCheck.verifyToken(token);
    },
  });
}
