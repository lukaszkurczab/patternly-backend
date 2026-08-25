import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import type { Environment } from "../../config/environment.js";

export type VerifiedIdentity = Readonly<{
  provider: "firebase";
  subject: string;
  email?: string;
  emailVerified: boolean;
}>;

export interface IdentityTokenVerifier {
  verify(idToken: string): Promise<VerifiedIdentity>;
}

export function createFirebaseTokenVerifier(environment: Environment): IdentityTokenVerifier | null {
  if (!environment.firebaseProjectId) return null;
  const app = getApps()[0] ?? initializeApp({ projectId: environment.firebaseProjectId });
  const auth = getAuth(app);
  return Object.freeze({
    async verify(idToken: string): Promise<VerifiedIdentity> {
      let claims: Awaited<ReturnType<typeof auth.verifyIdToken>>;
      try {
        claims = await auth.verifyIdToken(idToken, true);
      } catch {
        throw new Error("firebase_token_invalid");
      }
      if (claims.aud !== environment.firebaseProjectId) throw new Error("firebase_project_mismatch");
      if (claims.iss !== (environment.firebaseAuthIssuer ?? `https://securetoken.google.com/${environment.firebaseProjectId}`)) throw new Error("firebase_issuer_mismatch");
      if (!claims.uid || typeof claims.uid !== "string") throw new Error("firebase_subject_missing");
      return Object.freeze({
        provider: "firebase",
        subject: claims.uid,
        ...(typeof claims.email === "string" ? { email: claims.email } : {}),
        emailVerified: claims.email_verified === true,
      });
    },
  });
}
