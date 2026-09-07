import { randomUUID } from "node:crypto";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, identityDocumentId } from "../../infrastructure/firestore/paths.js";
import { asIsoString, asRecord, asTimestamp, now } from "../../infrastructure/firestore/values.js";
import type { AuthenticatedIdentity } from "../auth/contracts.js";
import type { PseudonymKeyRing } from "../../infrastructure/security/pseudonymKeyRing.js";

export type UserProfile = Readonly<{
  id: string;
  createdAt: string;
  acceptedTermsVersion: string | null;
  identity: Readonly<{ provider: string; subject: string; email: string | null; emailVerified: boolean }>;
}>;

export interface UserStore {
  ensureUser(identity: AuthenticatedIdentity): Promise<Readonly<{ userId: string }>>;
  readProfile(userId: string): Promise<UserProfile | null>;
  recordLegalAcceptance(userId: string, termsVersion: string): Promise<Readonly<{ termsVersion: string; acceptedAt: string }>>;
  recordPurchaseConfirmation(userId: string, input: Readonly<{ confirmationId: string; termsVersion: string; productIdentifier: string; storefrontPrice: string; locale: "en" | "pl" }>): Promise<Readonly<{ confirmationId: string; acceptedAt: string; attemptExpiresAt: string }>>;
}

function isExpiredTombstone(value: unknown): boolean {
  const expiresAt = asRecord(value, "deleted_identity").expiresAt;
  return (expiresAt instanceof Timestamp ? expiresAt.toMillis() : expiresAt instanceof Date ? expiresAt.getTime() : Number.POSITIVE_INFINITY) <= Date.now();
}

export class FirestoreUserStore implements UserStore {
  public constructor(private readonly db: Firestore, private readonly pseudonymKeyRing: PseudonymKeyRing) {}

  public async ensureUser(identity: AuthenticatedIdentity): Promise<Readonly<{ userId: string }>> {
    const identityId = identityDocumentId(identity.provider, identity.subject);
    const identityRef = this.db.collection(COLLECTIONS.identityMappings).doc(identityId);
    const deletedIdentityRefs = this.pseudonymKeyRing.candidates(identity.provider, identity.subject).map(({ documentId }) => this.db.collection(COLLECTIONS.deletedIdentities).doc(documentId));
    const userId = randomUUID();
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const createdAt = now();
    const result = await this.db.runTransaction(async (transaction) => {
      const [identitySnapshot, ...deletedSnapshots] = await transaction.getAll(identityRef, ...deletedIdentityRefs);
      if (deletedSnapshots.some((snapshot) => snapshot.exists && !isExpiredTombstone(snapshot.data()))) throw new Error("account_deleted");
      for (const snapshot of deletedSnapshots) if (snapshot.exists) transaction.delete(snapshot.ref);
      if (identitySnapshot?.exists) {
        const data = asRecord(identitySnapshot.data(), "identity_mapping");
        const existingUserId = data.userId;
        if (typeof existingUserId !== "string") throw new Error("identity_mapping_invalid");
        const existingUserRef = this.db.collection(COLLECTIONS.users).doc(existingUserId);
        const userSnapshot = await transaction.get(existingUserRef);
        if (!userSnapshot.exists || asRecord(userSnapshot.data(), "user").deletedAt !== undefined) throw new Error("account_deleted");
        transaction.update(identityRef, {
          ...(identity.email === undefined ? {} : { email: identity.email }),
          emailVerified: identity.emailVerified,
          updatedAt: createdAt,
        });
        transaction.update(existingUserRef, { ...(identity.email === undefined ? {} : { contactEmail: identity.email }), contactEmailVerified: identity.emailVerified, updatedAt: createdAt });
        return existingUserId;
      }
      transaction.create(userRef, { createdAt, updatedAt: createdAt, ...(identity.email === undefined ? {} : { contactEmail: identity.email }), contactEmailVerified: identity.emailVerified });
      transaction.create(identityRef, {
        provider: identity.provider,
        subject: identity.subject,
        userId,
        ...(identity.email === undefined ? {} : { email: identity.email }),
        emailVerified: identity.emailVerified,
        createdAt,
        updatedAt: createdAt,
      });
      return userId;
    });
    return Object.freeze({ userId: result });
  }

  public async readProfile(userId: string): Promise<UserProfile | null> {
    const userSnapshot = await this.db.collection(COLLECTIONS.users).doc(userId).get();
    if (!userSnapshot.exists) return null;
    const user = asRecord(userSnapshot.data(), "user");
    if (user.deletedAt !== undefined) return null;
    const identities = await this.db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId).limit(1).get();
    const identitySnapshot = identities.docs[0];
    if (!identitySnapshot) return null;
    const identity = asRecord(identitySnapshot.data(), "identity_mapping");
    if (typeof identity.provider !== "string" || typeof identity.subject !== "string" || typeof identity.emailVerified !== "boolean") throw new Error("identity_mapping_invalid");
    return Object.freeze({
      id: userId,
      createdAt: asIsoString(user.createdAt, "user_created_at"),
      acceptedTermsVersion: typeof user.acceptedTermsVersion === "string" ? user.acceptedTermsVersion : null,
      identity: Object.freeze({
        provider: identity.provider,
        subject: identity.subject,
        email: typeof identity.email === "string" ? identity.email : null,
        emailVerified: identity.emailVerified,
      }),
    });
  }

  public async recordLegalAcceptance(userId: string, termsVersion: string): Promise<Readonly<{ termsVersion: string; acceptedAt: string }>> {
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const acceptanceRef = userRef.collection("legalAcceptances").doc(`terms-${termsVersion}`);
    const acceptedAt = now();
    const stored = await this.db.runTransaction(async (transaction) => {
      const [user, existing] = await transaction.getAll(userRef, acceptanceRef);
      if (!user?.exists || asRecord(user.data(), "user").deletedAt !== undefined) throw new Error("account_deleted");
      if (existing?.exists) return asRecord(existing.data(), "legal_acceptance");
      const evidence = { kind: "terms_and_minimum_age", termsVersion, minimumAgeConfirmed: 18, acceptedAt };
      transaction.create(acceptanceRef, evidence);
      transaction.update(userRef, { acceptedTermsVersion: termsVersion, updatedAt: acceptedAt });
      return evidence;
    });
    return Object.freeze({ termsVersion: String(stored.termsVersion), acceptedAt: asIsoString(stored.acceptedAt, "legal_acceptance_at") });
  }

  public async recordPurchaseConfirmation(userId: string, input: Readonly<{ confirmationId: string; termsVersion: string; productIdentifier: string; storefrontPrice: string; locale: "en" | "pl" }>): Promise<Readonly<{ confirmationId: string; acceptedAt: string; attemptExpiresAt: string }>> {
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const confirmationRef = userRef.collection("purchaseConfirmations").doc(input.confirmationId);
    const activeAttemptRef = userRef.collection("purchaseAttempts").doc("active");
    const acceptedAt = now();
    const attemptExpiresAt = Timestamp.fromMillis(acceptedAt.toMillis() + 15 * 60 * 1_000);
    const evidence = { ...input, billingPeriod: "P1M", autoRenews: true, trialOffered: false, immediateStartRequested: true, acceptedAt };
    const result = await this.db.runTransaction(async (transaction) => {
      const [user, existing, activeAttempt] = await transaction.getAll(userRef, confirmationRef, activeAttemptRef);
      if (!user?.exists || asRecord(user.data(), "user").acceptedTermsVersion !== input.termsVersion) throw new Error("legal_acceptance_required");
      if (existing?.exists) {
        const data = asRecord(existing.data(), "purchase_confirmation");
        const storedAcceptedAt = asTimestamp(data.acceptedAt, "purchase_confirmation_at");
        const storedAttemptExpiresAt = data.attemptExpiresAt instanceof Timestamp ? data.attemptExpiresAt : Timestamp.fromMillis(storedAcceptedAt.toMillis() + 15 * 60 * 1_000);
        return { acceptedAt: storedAcceptedAt.toDate().toISOString(), attemptExpiresAt: storedAttemptExpiresAt.toDate().toISOString() };
      }
      if (activeAttempt?.exists) {
        const data = asRecord(activeAttempt.data(), "purchase_attempt");
        const expiresAt = data.expiresAt instanceof Timestamp ? data.expiresAt.toMillis() : 0;
        if (expiresAt > acceptedAt.toMillis() && data.consumedAt == null) throw new Error("purchase_attempt_active");
      }
      transaction.create(confirmationRef, { ...evidence, attemptExpiresAt });
      transaction.set(activeAttemptRef, { confirmationId: input.confirmationId, productIdentifier: input.productIdentifier, createdAt: acceptedAt, expiresAt: attemptExpiresAt, consumedAt: null });
      return { acceptedAt: asIsoString(acceptedAt, "purchase_confirmation_at"), attemptExpiresAt: asIsoString(attemptExpiresAt, "purchase_attempt_expires_at") };
    });
    return Object.freeze({ confirmationId: input.confirmationId, ...result });
  }

}
