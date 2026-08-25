import { getAuth } from "firebase-admin/auth";
import type { App } from "firebase-admin/app";

export interface FirebaseAdminAuth {
  createCustomToken(userId: string): Promise<string>;
  revokeRefreshTokens(userId: string): Promise<void>;
}

export function createFirebaseAdminAuth(app: App): FirebaseAdminAuth {
  const auth = getAuth(app);
  return Object.freeze({
    createCustomToken: (userId: string) => auth.createCustomToken(userId),
    revokeRefreshTokens: async (userId: string) => { await auth.revokeRefreshTokens(userId); },
  });
}
