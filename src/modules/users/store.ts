import { randomUUID } from "node:crypto";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, identityDocumentId } from "../../infrastructure/firestore/paths.js";
import { asIsoString, asRecord, asTimestamp, now } from "../../infrastructure/firestore/values.js";
import type { AuthenticatedIdentity } from "../auth/contracts.js";
import { activeAuthorizationGeneration, assertExpectedAuthorizationGeneration } from "../auth/authorizationGeneration.js";
import type { PseudonymKeyRing } from "../../infrastructure/security/pseudonymKeyRing.js";

export type UserProfile = Readonly<{
  id: string;
  createdAt: string;
  acceptedTermsVersion: string | null;
  identity: Readonly<{ provider: string; subject: string; email: string | null; emailVerified: boolean }>;
}>;

export type AccountRegistrationInput = Readonly<{
  termsVersion: string;
  termsLocale: "en" | "pl";
  privacyPolicyVersion: string;
  privacyPolicyLocale: "en" | "pl";
  privacyPolicyAcknowledged: true;
}>;

export type AccountRegistrationAcceptance = AccountRegistrationInput & Readonly<{
  acceptedAt: string;
}>;

export type AccountRegistrationResult = Readonly<{
  created: boolean;
  user: UserProfile;
  acceptance: AccountRegistrationAcceptance | null;
}>;

export interface UserStore {
  resolveExistingUser(identity: AuthenticatedIdentity): Promise<Readonly<{ userId: string; authorizationGeneration: number }>>;
  pinSessionAuthorization(identity: AuthenticatedIdentity): Promise<Readonly<{ firebaseSubject: string; authorizationGeneration: number }>>;
  registerUser(identity: AuthenticatedIdentity, input: AccountRegistrationInput): Promise<AccountRegistrationResult>;
  readProfile(userId: string): Promise<UserProfile | null>;
  recordLegalAcceptance(userId: string, expectedAuthorizationGeneration: number, termsVersion: string): Promise<Readonly<{ termsVersion: string; acceptedAt: string }>>;
  recordPurchaseConfirmation(userId: string, expectedAuthorizationGeneration: number, input: Readonly<{ confirmationId: string; termsVersion: string; productIdentifier: string; storefrontPrice: string; locale: "en" | "pl" }>): Promise<Readonly<{ confirmationId: string; acceptedAt: string; attemptExpiresAt: string }>>;
}

function isExpiredTombstone(value: unknown): boolean {
  const expiresAt = asRecord(value, "deleted_identity").expiresAt;
  return (expiresAt instanceof Timestamp ? expiresAt.toMillis() : expiresAt instanceof Date ? expiresAt.getTime() : Number.POSITIVE_INFINITY) <= Date.now();
}

function profileFromIdentity(userId: string, createdAt: Timestamp, acceptedTermsVersion: string | null, identity: AuthenticatedIdentity): UserProfile {
  return Object.freeze({
    id: userId,
    createdAt: asIsoString(createdAt, "user_created_at"),
    acceptedTermsVersion,
    identity: Object.freeze({
      provider: identity.provider,
      subject: identity.subject,
      email: identity.email ?? null,
      emailVerified: identity.emailVerified,
    }),
  });
}

function profileFromStored(userId: string, storedUser: unknown, storedIdentity: Readonly<Record<string, unknown>>): UserProfile {
  const user = asRecord(storedUser, "user");
  if (typeof storedIdentity.provider !== "string" || typeof storedIdentity.subject !== "string" || typeof storedIdentity.emailVerified !== "boolean") throw new Error("identity_mapping_invalid");
  return Object.freeze({
    id: userId,
    createdAt: asIsoString(user.createdAt, "user_created_at"),
    acceptedTermsVersion: typeof user.acceptedTermsVersion === "string" ? user.acceptedTermsVersion : null,
    identity: Object.freeze({
      provider: storedIdentity.provider,
      subject: storedIdentity.subject,
      email: typeof storedIdentity.email === "string" ? storedIdentity.email : null,
      emailVerified: storedIdentity.emailVerified,
    }),
  });
}

export class FirestoreUserStore implements UserStore {
  public constructor(private readonly db: Firestore, private readonly pseudonymKeyRing: PseudonymKeyRing) {}

  public async resolveExistingUser(identity: AuthenticatedIdentity): Promise<Readonly<{ userId: string; authorizationGeneration: number }>> {
    const identityId = identityDocumentId(identity.provider, identity.subject);
    const identityRef = this.db.collection(COLLECTIONS.identityMappings).doc(identityId);
    const deletedIdentityRefs = this.pseudonymKeyRing.candidates(identity.provider, identity.subject).map(({ documentId }) => this.db.collection(COLLECTIONS.deletedIdentities).doc(documentId));
    const result = await this.db.runTransaction(async (transaction) => {
      const [identitySnapshot, ...deletedSnapshots] = await transaction.getAll(identityRef, ...deletedIdentityRefs);
      if (deletedSnapshots.some((snapshot) => snapshot.exists && !isExpiredTombstone(snapshot.data()))) throw new Error("account_deleted");
      if (!identitySnapshot?.exists) throw new Error("account_not_found");
      const data = asRecord(identitySnapshot.data(), "identity_mapping");
      const existingUserId = data.userId;
      if (typeof existingUserId !== "string") throw new Error("identity_mapping_invalid");
      const existingUserRef = this.db.collection(COLLECTIONS.users).doc(existingUserId);
      const userSnapshot = await transaction.get(existingUserRef);
      if (!userSnapshot.exists) throw new Error("account_deleted");
      const user = asRecord(userSnapshot.data(), "user");
      const authorizationGeneration = activeAuthorizationGeneration(user);
      if (identity.authorizationGeneration === undefined) throw new Error("authorization_generation_required");
      if (identity.authorizationGeneration !== authorizationGeneration) throw new Error("authorization_generation_stale");
      return Object.freeze({ userId: existingUserId, authorizationGeneration });
    }, { readOnly: true });
    return result;
  }

  public async pinSessionAuthorization(identity: AuthenticatedIdentity): Promise<Readonly<{ firebaseSubject: string; authorizationGeneration: number }>> {
    const identityId = identityDocumentId(identity.provider, identity.subject);
    const identityRef = this.db.collection(COLLECTIONS.identityMappings).doc(identityId);
    const deletedIdentityRefs = this.pseudonymKeyRing.candidates(identity.provider, identity.subject).map(({ documentId }) => this.db.collection(COLLECTIONS.deletedIdentities).doc(documentId));
    return this.db.runTransaction(async (transaction) => {
      const [identitySnapshot, ...deletedSnapshots] = await transaction.getAll(identityRef, ...deletedIdentityRefs);
      if (deletedSnapshots.some((snapshot) => snapshot.exists && !isExpiredTombstone(snapshot.data()))) throw new Error("account_deleted");
      if (!identitySnapshot?.exists) throw new Error("account_not_found");
      const identityData = asRecord(identitySnapshot.data(), "identity_mapping");
      if (identityData.provider !== identity.provider || identityData.subject !== identity.subject || typeof identityData.userId !== "string") throw new Error("identity_mapping_invalid");
      const userId = identityData.userId;
      const userSnapshot = await transaction.get(this.db.collection(COLLECTIONS.users).doc(userId));
      if (!userSnapshot.exists) throw new Error("account_deleted");
      const user = asRecord(userSnapshot.data(), "user");
      if (user.deletedAt !== undefined || (user.authorizationState !== undefined && user.authorizationState !== "active")) throw new Error("account_deleted");
      const authorizationGeneration = user.authorizationGeneration === undefined ? 1 : user.authorizationGeneration;
      const authorizationRotatedAtSeconds = user.authorizationRotatedAtSeconds === undefined ? 0 : user.authorizationRotatedAtSeconds;
      if (!Number.isSafeInteger(authorizationGeneration) || typeof authorizationGeneration !== "number" || authorizationGeneration <= 0) throw new Error("account_deleted");
      if (!Number.isSafeInteger(authorizationRotatedAtSeconds) || typeof authorizationRotatedAtSeconds !== "number" || authorizationRotatedAtSeconds < 0) throw new Error("account_deleted");
      if (identity.authTime <= authorizationRotatedAtSeconds) throw new Error("recent_reauthentication_required");
      return Object.freeze({ firebaseSubject: identity.subject, authorizationGeneration });
    }, { readOnly: true });
  }

  public async registerUser(identity: AuthenticatedIdentity, input: AccountRegistrationInput): Promise<AccountRegistrationResult> {
    const identityId = identityDocumentId(identity.provider, identity.subject);
    const identityRef = this.db.collection(COLLECTIONS.identityMappings).doc(identityId);
    const deletedIdentityRefs = this.pseudonymKeyRing.candidates(identity.provider, identity.subject).map(({ documentId }) => this.db.collection(COLLECTIONS.deletedIdentities).doc(documentId));
    const userId = randomUUID();
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const acceptanceRef = userRef.collection("legalAcceptances").doc(`terms-${input.termsVersion}`);
    const createdAt = now();
    const result = await this.db.runTransaction(async (transaction) => {
      const [identitySnapshot, ...deletedSnapshots] = await transaction.getAll(identityRef, ...deletedIdentityRefs);
      if (deletedSnapshots.some((snapshot) => snapshot.exists && !isExpiredTombstone(snapshot.data()))) throw new Error("account_deleted");
      if (identitySnapshot?.exists) {
        const identityData = asRecord(identitySnapshot.data(), "identity_mapping");
        const existingUserId = identityData.userId;
        if (typeof existingUserId !== "string") throw new Error("identity_mapping_invalid");
        const existingUserSnapshot = await transaction.get(this.db.collection(COLLECTIONS.users).doc(existingUserId));
        if (!existingUserSnapshot.exists || asRecord(existingUserSnapshot.data(), "user").deletedAt !== undefined) throw new Error("account_deleted");
        return {
          created: false as const,
          user: profileFromStored(existingUserId, existingUserSnapshot.data(), identityData),
          acceptance: null,
        };
      }
      for (const snapshot of deletedSnapshots) if (snapshot.exists) transaction.delete(snapshot.ref);
      transaction.create(userRef, { createdAt, updatedAt: createdAt, acceptedTermsVersion: input.termsVersion, authorizationGeneration: 1, authorizationState: "active", authorizationRotatedAtSeconds: 0, ...(identity.email === undefined ? {} : { contactEmail: identity.email }), contactEmailVerified: identity.emailVerified });
      // `identityRef` was read as missing above. A transactional set keeps
      // that CAS while allowing a concurrent registration winner to trigger
      // a transaction retry instead of an ALREADY_EXISTS write failure.
      transaction.set(identityRef, {
        provider: identity.provider,
        subject: identity.subject,
        userId,
        ...(identity.email === undefined ? {} : { email: identity.email }),
        emailVerified: identity.emailVerified,
        createdAt,
        updatedAt: createdAt,
      });
      const evidence = {
        kind: "terms_acceptance_and_privacy_acknowledgement",
        ...input,
        acceptedAt: createdAt,
      };
      transaction.create(acceptanceRef, evidence);
      return {
        created: true as const,
        user: profileFromIdentity(userId, createdAt, input.termsVersion, identity),
        acceptance: evidence,
      };
    });
    return Object.freeze({
      created: result.created,
      user: result.user,
      acceptance: result.acceptance === null ? null : Object.freeze({
        termsVersion: String(result.acceptance.termsVersion),
        termsLocale: result.acceptance.termsLocale,
        privacyPolicyVersion: String(result.acceptance.privacyPolicyVersion),
        privacyPolicyLocale: result.acceptance.privacyPolicyLocale,
        privacyPolicyAcknowledged: true,
        acceptedAt: asIsoString(result.acceptance.acceptedAt, "account_registration_accepted_at"),
      }),
    });
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

  public async recordLegalAcceptance(userId: string, expectedAuthorizationGeneration: number, termsVersion: string): Promise<Readonly<{ termsVersion: string; acceptedAt: string }>> {
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const acceptanceRef = userRef.collection("legalAcceptances").doc(`terms-${termsVersion}`);
    const acceptedAt = now();
    const stored = await this.db.runTransaction(async (transaction) => {
      const [user, existing] = await transaction.getAll(userRef, acceptanceRef);
      if (!user?.exists) throw new Error("account_deleted");
      assertExpectedAuthorizationGeneration(asRecord(user.data(), "user"), expectedAuthorizationGeneration);
      if (existing?.exists) return asRecord(existing.data(), "legal_acceptance");
      const evidence = { kind: "terms_and_minimum_age", termsVersion, minimumAgeConfirmed: 18, acceptedAt };
      transaction.create(acceptanceRef, evidence);
      transaction.update(userRef, { acceptedTermsVersion: termsVersion, updatedAt: acceptedAt });
      return evidence;
    });
    return Object.freeze({ termsVersion: String(stored.termsVersion), acceptedAt: asIsoString(stored.acceptedAt, "legal_acceptance_at") });
  }

  public async recordPurchaseConfirmation(userId: string, expectedAuthorizationGeneration: number, input: Readonly<{ confirmationId: string; termsVersion: string; productIdentifier: string; storefrontPrice: string; locale: "en" | "pl" }>): Promise<Readonly<{ confirmationId: string; acceptedAt: string; attemptExpiresAt: string }>> {
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const confirmationRef = userRef.collection("purchaseConfirmations").doc(input.confirmationId);
    const activeAttemptRef = userRef.collection("purchaseAttempts").doc("active");
    const acceptedAt = now();
    const attemptExpiresAt = Timestamp.fromMillis(acceptedAt.toMillis() + 15 * 60 * 1_000);
    const evidence = { ...input, billingPeriod: "P1M", autoRenews: true, trialOffered: false, immediateStartRequested: true, acceptedAt };
    const result = await this.db.runTransaction(async (transaction) => {
      const [user, existing, activeAttempt] = await transaction.getAll(userRef, confirmationRef, activeAttemptRef);
      if (!user?.exists) throw new Error("account_deleted");
      const userData = asRecord(user.data(), "user");
      assertExpectedAuthorizationGeneration(userData, expectedAuthorizationGeneration);
      if (userData.acceptedTermsVersion !== input.termsVersion) throw new Error("legal_acceptance_required");
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
