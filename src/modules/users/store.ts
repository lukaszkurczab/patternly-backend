import { randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, identityDocumentId } from "../../infrastructure/firestore/paths.js";
import { asIsoString, asRecord, now } from "../../infrastructure/firestore/values.js";
import type { AuthenticatedIdentity } from "../auth/contracts.js";

export type UserProfile = Readonly<{
  id: string;
  createdAt: string;
  identity: Readonly<{ provider: string; subject: string; email: string | null; emailVerified: boolean }>;
}>;

export interface UserStore {
  ensureUser(identity: AuthenticatedIdentity): Promise<Readonly<{ userId: string }>>;
  readProfile(userId: string): Promise<UserProfile | null>;
  deleteAccount(userId: string): Promise<void>;
}

export class FirestoreUserStore implements UserStore {
  public constructor(private readonly db: Firestore) {}

  public async ensureUser(identity: AuthenticatedIdentity): Promise<Readonly<{ userId: string }>> {
    const identityId = identityDocumentId(identity.provider, identity.subject);
    const identityRef = this.db.collection(COLLECTIONS.identityMappings).doc(identityId);
    const deletedIdentityRef = this.db.collection(COLLECTIONS.deletedIdentities).doc(identityId);
    const userId = randomUUID();
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const createdAt = now();
    const result = await this.db.runTransaction(async (transaction) => {
      const [identitySnapshot, deletedSnapshot] = await transaction.getAll(identityRef, deletedIdentityRef);
      if (deletedSnapshot?.exists) throw new Error("account_deleted");
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
        return existingUserId;
      }
      transaction.create(userRef, { createdAt, updatedAt: createdAt });
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
      identity: Object.freeze({
        provider: identity.provider,
        subject: identity.subject,
        email: typeof identity.email === "string" ? identity.email : null,
        emailVerified: identity.emailVerified,
      }),
    });
  }

  public async deleteAccount(userId: string): Promise<void> {
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const identitySnapshot = await this.db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId).get();
    const recordedAt = now();
    await this.db.runTransaction(async (transaction) => {
      const userSnapshot = await transaction.get(userRef);
      if (!userSnapshot.exists) return;
      for (const identity of identitySnapshot.docs) {
        const tombstoneRef = this.db.collection(COLLECTIONS.deletedIdentities).doc(identity.id);
        transaction.create(tombstoneRef, { deletedAt: recordedAt, provider: asRecord(identity.data(), "identity_mapping").provider });
        transaction.delete(identity.ref);
      }
      transaction.update(userRef, { deletedAt: recordedAt, updatedAt: recordedAt });
    });
    await this.db.recursiveDelete(userRef);
  }
}
