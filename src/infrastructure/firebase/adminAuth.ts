import { getAuth } from "firebase-admin/auth";
import type { App } from "firebase-admin/app";

export interface FirebaseAdminAuth {
  createCustomToken(userId: string): Promise<string>;
  revokeRefreshTokens(userId: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
}

function isAuthUserNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "auth/user-not-found" || code === "user-not-found";
}

export function createFirebaseAdminAuth(app: App): FirebaseAdminAuth {
  const auth = getAuth(app);
  return Object.freeze({
    createCustomToken: (userId: string) => auth.createCustomToken(userId),
    revokeRefreshTokens: async (userId: string) => { await auth.revokeRefreshTokens(userId); },
    deleteUser: async (userId: string) => {
      try {
        await auth.deleteUser(userId);
      } catch (error) {
        if (!isAuthUserNotFound(error)) throw error;
      }
    },
  });
}
