import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Firestore, DocumentReference } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { COLLECTIONS, identityDocumentId } from "../../infrastructure/firestore/paths.js";
import type { FirebaseAdminAuth } from "../../infrastructure/firebase/adminAuth.js";
import { asRecord, asTimestamp, now } from "../../infrastructure/firestore/values.js";
import type { AccountDeletionResult, CompletedDeletion, PublicDeletionConfirmation } from "./contracts.js";

const DELETION_TOKEN_TTL_MS = 30 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;
const PUBLIC_DELETION_REQUEST_LIMIT = 3;
const PUBLIC_DELETION_WINDOW_MS = 60 * 60 * 1000;

export interface DeletionEmailSender {
  send(input: Readonly<{ recipient: string; requestId: string; token: string; link: string }>): Promise<void>;
}

type RecoveryCodesResult = Readonly<{ generationId: string; codes: readonly string[] }>;
type PublicDeletionRequestResult = Readonly<{ requestId: string | null }>;
type DeletionProof = Readonly<{ status: "deleted"; operationId: string; proofId: string }>;
type DeletionOperationStatus = Readonly<{ status: "pending" | "remote_deleted" | "complete"; operationId: string; proofId: string | null }>;

export interface AccountLifecycleStore {
  issueRecoveryCodes(userId: string): Promise<RecoveryCodesResult>;
  consumeRecoveryCode(code: string): Promise<Readonly<{ customToken: string }>>;
  revokeSessions(userId: string, operationId: string): Promise<Readonly<{ status: "revoked"; operationId: string }>>;
  deleteAccount(userId: string, operationId: string): Promise<AccountDeletionResult>;
  completeDeletion(operationId: string, proofId: string): Promise<CompletedDeletion>;
  createPublicDeletionRequest(email: string, publicOrigin: string, sender: DeletionEmailSender): Promise<PublicDeletionRequestResult>;
  confirmPublicDeletion(requestId: string, token: string): Promise<PublicDeletionConfirmation>;
  readDeletionProof(proofId: string): Promise<DeletionProof | null>;
  readDeletionOperationStatus(operationId: string, accountUidHash: string): Promise<DeletionOperationStatus | null>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function recoveryCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(16);
  let raw = "";
  for (const byte of bytes) raw += alphabet[byte % alphabet.length];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

function operationRef(db: Firestore, operationId: string): DocumentReference {
  return db.collection(COLLECTIONS.accountDeletionOperations).doc(operationId);
}

export class FirestoreAccountLifecycleStore implements AccountLifecycleStore {
  public constructor(private readonly db: Firestore, private readonly auth: FirebaseAdminAuth) {}

  public async issueRecoveryCodes(userId: string): Promise<RecoveryCodesResult> {
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const generationId = randomUUID();
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
    const createdAt = now();
    await this.db.runTransaction(async (transaction) => {
      const user = await transaction.get(userRef);
      if (!user.exists || asRecord(user.data(), "user").deletedAt !== undefined) throw new Error("account_deleted");
      const existing = await transaction.get(this.db.collection(COLLECTIONS.recoveryCodeIndex).where("userId", "==", userId));
      for (const document of existing.docs) transaction.delete(document.ref);
      for (const code of codes) {
        transaction.create(this.db.collection(COLLECTIONS.recoveryCodeIndex).doc(sha256(code)), {
          userId,
          generationId,
          usedAt: null,
          createdAt,
        });
      }
      transaction.set(userRef.collection("security").doc("recoveryCodes"), { generationId, count: RECOVERY_CODE_COUNT, createdAt }, { merge: true });
    });
    return Object.freeze({ generationId, codes: Object.freeze(codes) });
  }

  public async consumeRecoveryCode(code: string): Promise<Readonly<{ customToken: string }>> {
    const indexRef = this.db.collection(COLLECTIONS.recoveryCodeIndex).doc(sha256(code));
    const firebaseSubject = await this.db.runTransaction(async (transaction) => {
      const current = await transaction.get(indexRef);
      if (!current.exists) throw new Error("recovery_code_invalid");
      const data = asRecord(current.data(), "recovery_code");
      if (data.usedAt !== null) throw new Error("recovery_code_used");
      if (typeof data.userId !== "string") throw new Error("recovery_code_invalid");
      const userId = data.userId;
      const user = await transaction.get(this.db.collection(COLLECTIONS.users).doc(userId));
      if (!user.exists || asRecord(user.data(), "user").deletedAt !== undefined) throw new Error("account_deleted");
      const identities = await transaction.get(this.db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId));
      const subjects = identities.docs
        .map((document) => asRecord(document.data(), "identity_mapping"))
        .filter((identity) => identity.provider === "firebase" && typeof identity.subject === "string")
        .map((identity) => identity.subject as string);
      if (subjects.length !== 1) throw new Error("recovery_code_invalid");
      transaction.update(indexRef, { usedAt: now() });
      const subject = subjects[0];
      if (!subject) throw new Error("recovery_code_invalid");
      return subject;
    });
    try {
      await this.auth.revokeRefreshTokens(firebaseSubject);
    } catch {
      throw new Error("recovery_session_revocation_failed");
    }
    return Object.freeze({ customToken: await this.auth.createCustomToken(firebaseSubject) });
  }

  public async revokeSessions(userId: string, operationId: string): Promise<Readonly<{ status: "revoked"; operationId: string }>> {
    const ref = this.db.collection(COLLECTIONS.sessionRevocationOperations).doc(operationId);
    const existing = await ref.get();
    if (existing.exists) {
      const data = asRecord(existing.data(), "session_revocation");
      if (data.userId !== userId) throw new Error("session_revocation_operation_conflict");
      if (data.status === "revoked") return Object.freeze({ status: "revoked", operationId });
    }
    const identities = await this.db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId).get();
    const subjects = identities.docs.map((document) => asRecord(document.data(), "identity_mapping")).filter((data) => data.provider === "firebase" && typeof data.subject === "string").map((data) => data.subject as string);
    try {
      for (const subject of subjects) await this.auth.revokeRefreshTokens(subject);
    } catch {
      await ref.set({ operationId, userId, status: "failed", failureCode: "session_revocation_failed", updatedAt: now() }, { merge: true });
      throw new Error("session_revocation_failed");
    }
    await ref.set({ operationId, userId, status: "revoked", updatedAt: now() }, { merge: true });
    return Object.freeze({ status: "revoked", operationId });
  }

  public async deleteAccount(userId: string, operationId: string): Promise<AccountDeletionResult> {
    const ref = operationRef(this.db, operationId);
    const current = await ref.get();
    if (current.exists) {
      const data = asRecord(current.data(), "account_deletion_operation");
      if (data.userId !== userId) throw new Error("remote_deletion_pending");
      if (data.status === "complete" || data.status === "remote_deleted") return Object.freeze({ operationId, proofId: String(data.proofId), status: "already_deleted" });
    } else {
      await ref.create({ operationId, userId, status: "pending", proofId: `proof_${randomBytes(18).toString("base64url")}`, createdAt: now(), updatedAt: now() });
    }
    const afterCreate = asRecord((await ref.get()).data(), "account_deletion_operation");
    const proofId = typeof afterCreate.proofId === "string" ? afterCreate.proofId : `proof_${randomBytes(18).toString("base64url")}`;
    if (afterCreate.status !== "remote_deleting") {
      const identities = await this.db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId).get();
      const subjects = identities.docs.map((document) => asRecord(document.data(), "identity_mapping")).filter((data) => data.provider === "firebase" && typeof data.subject === "string").map((data) => data.subject as string);
      await ref.set({ subjectHashes: subjects.map(sha256), updatedAt: now() }, { merge: true });
      try {
        for (const subject of subjects) await this.auth.revokeRefreshTokens(subject);
      } catch {
        await ref.set({ status: "failed", failureCode: "session_revocation_failed", updatedAt: now() }, { merge: true });
        throw new Error("session_revocation_failed");
      }
      await this.db.runTransaction(async (transaction) => {
        const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
        const user = await transaction.get(userRef);
        const mappings = await transaction.get(this.db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId));
        if (!user.exists && mappings.empty) {
          transaction.set(ref, { status: "remote_deleting", proofId, updatedAt: now() }, { merge: true });
          return;
        }
        if (mappings.empty) throw new Error("remote_deletion_pending");
        const deletedAt = now();
        for (const mapping of mappings.docs) {
          const data = asRecord(mapping.data(), "identity_mapping");
          transaction.set(this.db.collection(COLLECTIONS.deletedIdentities).doc(identityDocumentId(String(data.provider), String(data.subject))), { provider: data.provider, deletedAt, operationId, proofId }, { merge: true });
          transaction.delete(mapping.ref);
        }
        transaction.set(userRef, { deletedAt, updatedAt: deletedAt }, { merge: true });
        transaction.set(ref, { status: "remote_deleting", proofId, updatedAt: deletedAt }, { merge: true });
      });
    }
    try {
      await this.db.recursiveDelete(this.db.collection(COLLECTIONS.users).doc(userId));
    } catch {
      throw new Error("remote_deletion_pending");
    }
    await ref.set({ status: "remote_deleted", proofId, remoteDeletedAt: now(), updatedAt: now() }, { merge: true });
    return Object.freeze({ operationId, proofId, status: "remote_deleted" });
  }

  public async completeDeletion(operationId: string, proofId: string): Promise<CompletedDeletion> {
    const ref = operationRef(this.db, operationId);
    const operation = await ref.get();
    if (!operation.exists) throw new Error("remote_deletion_pending");
    const data = asRecord(operation.data(), "account_deletion_operation");
    if (data.proofId !== proofId || !["remote_deleted", "complete"].includes(String(data.status))) throw new Error("remote_deletion_pending");
    const completedAt = now();
    await this.db.runTransaction(async (transaction) => {
      const requests = await transaction.get(this.db.collection(COLLECTIONS.deletionRequests).where("operationId", "==", operationId));
      transaction.set(ref, { status: "complete", completedAt, updatedAt: completedAt }, { merge: true });
      transaction.set(this.db.collection(COLLECTIONS.deletionProofs).doc(proofId), { status: "deleted", operationId, proofId, completedAt }, { merge: true });
      for (const request of requests.docs) transaction.set(request.ref, { status: "complete", proofId, completedAt }, { merge: true });
    });
    return Object.freeze({ status: "deleted", operationId, proofId });
  }

  public async createPublicDeletionRequest(email: string, publicOrigin: string, sender: DeletionEmailSender): Promise<PublicDeletionRequestResult> {
    const rateLimitRef = this.db.collection(COLLECTIONS.rateLimitBuckets).doc(sha256(`public-deletion:${email}`));
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(rateLimitRef);
      const data = snapshot.exists ? asRecord(snapshot.data(), "deletion_rate_limit") : {};
      const windowStartedAt = data.windowStartedAt ? asTimestamp(data.windowStartedAt, "deletion_rate_limit_window").toMillis() : 0;
      const count = typeof data.count === "number" ? data.count : 0;
      const currentMs = Date.now();
      const nextCount = currentMs - windowStartedAt >= PUBLIC_DELETION_WINDOW_MS ? 1 : count + 1;
      if (nextCount > PUBLIC_DELETION_REQUEST_LIMIT) throw new Error("deletion_rate_limited");
      transaction.set(rateLimitRef, { count: nextCount, windowStartedAt: Timestamp.fromMillis(currentMs), updatedAt: now() }, { merge: true });
    });
    const identities = await this.db.collection(COLLECTIONS.identityMappings).where("email", "==", email).get();
    const userIds = [...new Set(identities.docs.map((document) => asRecord(document.data(), "identity_mapping").userId).filter((value): value is string => typeof value === "string"))];
    if (userIds.length !== 1) return Object.freeze({ requestId: null });
    const requestId = randomUUID();
    const token = randomBytes(24).toString("base64url");
    const expiresAt = Timestamp.fromMillis(Date.now() + DELETION_TOKEN_TTL_MS);
    await this.db.collection(COLLECTIONS.deletionRequests).doc(requestId).create({ requestId, emailHash: sha256(email), tokenHash: sha256(token), userId: userIds[0], operationId: null, status: "pending", expiresAt, createdAt: now() });
    try {
      const link = `${publicOrigin.replace(/\/$/u, "")}/deletion?requestId=${encodeURIComponent(requestId)}&token=${encodeURIComponent(token)}`;
      await sender.send({ recipient: email, requestId, token, link });
    } catch {
      await this.db.collection(COLLECTIONS.deletionRequests).doc(requestId).delete();
      throw new Error("deletion_email_unavailable");
    }
    return Object.freeze({ requestId });
  }

  public async confirmPublicDeletion(requestId: string, token: string): Promise<PublicDeletionConfirmation> {
    const ref = this.db.collection(COLLECTIONS.deletionRequests).doc(requestId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("deletion_request_invalid");
      const data = asRecord(snapshot.data(), "deletion_request");
      if (data.tokenHash !== sha256(token) || typeof data.userId !== "string") throw new Error("deletion_request_invalid");
      if (data.status === "complete" && typeof data.operationId === "string" && typeof data.proofId === "string") return Object.freeze({ status: "complete", operationId: data.operationId, proofId: data.proofId });
      if (asTimestamp(data.expiresAt, "deletion_request_expiry").toMillis() < Date.now()) throw new Error("deletion_request_expired");
      const operationId = typeof data.operationId === "string" ? data.operationId : randomUUID();
      transaction.set(ref, { status: "possession_verified", operationId, verifiedAt: now(), updatedAt: now() }, { merge: true });
      return Object.freeze({ status: "pending", userId: data.userId, operationId });
    });
  }

  public async readDeletionProof(proofId: string): Promise<DeletionProof | null> {
    const snapshot = await this.db.collection(COLLECTIONS.deletionProofs).doc(proofId).get();
    if (!snapshot.exists) return null;
    const data = asRecord(snapshot.data(), "deletion_proof");
    if (data.status !== "deleted" || typeof data.operationId !== "string") return null;
    return Object.freeze({ status: "deleted", operationId: data.operationId, proofId });
  }

  public async readDeletionOperationStatus(operationId: string, accountUidHash: string): Promise<DeletionOperationStatus | null> {
    const snapshot = await operationRef(this.db, operationId).get();
    if (!snapshot.exists) return null;
    const data = asRecord(snapshot.data(), "account_deletion_operation");
    const subjectHashes = Array.isArray(data.subjectHashes) ? data.subjectHashes.filter((value): value is string => typeof value === "string") : [];
    if (!subjectHashes.includes(accountUidHash)) return null;
    if (!["pending", "remote_deleting", "remote_deleted", "complete"].includes(String(data.status))) return null;
    return Object.freeze({ status: data.status === "complete" ? "complete" : data.status === "remote_deleted" ? "remote_deleted" : "pending", operationId, proofId: typeof data.proofId === "string" ? data.proofId : null });
  }
}
