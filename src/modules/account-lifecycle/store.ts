import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Firestore, DocumentReference, Query } from "firebase-admin/firestore";
import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { COLLECTIONS } from "../../infrastructure/firestore/paths.js";
import type { FirebaseAdminAuth } from "../../infrastructure/firebase/adminAuth.js";
import { asRecord, asTimestamp, now } from "../../infrastructure/firestore/values.js";
import type { AccountDeletionResult, CompletedDeletion } from "./contracts.js";
import type { PseudonymKeyRing } from "../../infrastructure/security/pseudonymKeyRing.js";
import { assertExpectedAuthorizationGeneration } from "../auth/authorizationGeneration.js";

const RECOVERY_CODE_COUNT = 10;
const TOMBSTONE_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;
const PROOF_RETENTION_MS = 3 * 365 * 24 * 60 * 60 * 1000;
const SECURITY_OPERATION_LEASE_MS = 2 * 60 * 1000;

type RecoveryCodesResult = Readonly<{ generationId: string; codes: readonly string[] }>;
type SessionRevocationResult = Readonly<{ status: "revoked"; operationId: string; customToken: string }>;
type DeletionProof = Readonly<{ status: "deleted"; operationId: string; proofId: string }>;
type DeletionOperationStatus = Readonly<{ status: "pending" | "remote_deleted" | "complete"; operationId: string; proofId: string | null }>;
type DeletionPhase = "prepared" | "sessions_revoking" | "firestore_deleting" | "auth_deleting" | "remote_deleted" | "complete";
type StoredDeletionIdentity = Readonly<{ identityId: string; provider: string; keyVersion: string; subjectHmac: string }>;
type StoredDeletionOperation = Readonly<{
  operationId: string;
  userId: string | null;
  proofId: string;
  status: string;
  phase: DeletionPhase;
  operationSecretHash: string;
  identityRefs: readonly StoredDeletionIdentity[];
  expectedAuthorizationGeneration: number;
  fence: string;
  leaseUntil: Timestamp | Date;
}>;

const DELETION_PHASES: readonly DeletionPhase[] = Object.freeze(["prepared", "sessions_revoking", "auth_deleting", "firestore_deleting", "remote_deleted", "complete"]);

export interface AccountLifecycleStore {
  issueRecoveryCodes(userId: string, expectedAuthorizationGeneration: number): Promise<RecoveryCodesResult>;
  consumeRecoveryCode(code: string): Promise<Readonly<{ customToken: string }>>;
  revokeSessions(userId: string, expectedAuthorizationGeneration: number, operationId: string): Promise<SessionRevocationResult>;
  deleteAccount(userId: string, expectedAuthorizationGeneration: number, operationId: string, operationSecret: string): Promise<AccountDeletionResult>;
  completeDeletion(operationId: string, proofId: string): Promise<CompletedDeletion>;
  resumeDeletion(operationId: string, operationSecret: string): Promise<DeletionOperationStatus | null>;
  readDeletionProof(proofId: string): Promise<DeletionProof | null>;
  readDeletionOperationStatus(operationId: string, operationSecret: string): Promise<DeletionOperationStatus | null>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isExpiredIdentityTombstone(value: unknown): boolean {
  const expiresAt = asRecord(value, "deleted_identity").expiresAt;
  const expiresAtMs = expiresAt instanceof Timestamp ? expiresAt.toMillis() : expiresAt instanceof Date ? expiresAt.getTime() : Number.POSITIVE_INFINITY;
  return expiresAtMs <= Date.now();
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

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze([...new Set(value.filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0))]);
}

function hashArray(value: unknown): readonly string[] {
  const values = stringArray(value);
  return Object.freeze(values.every((candidate) => /^[a-f0-9]{64}$/u.test(candidate)) ? values : []);
}

function deletionIdentityReferences(value: unknown): readonly StoredDeletionIdentity[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const references: StoredDeletionIdentity[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return Object.freeze([]);
    const data = candidate as Record<string, unknown>;
    if (typeof data.identityId !== "string" || !/^[a-z][a-z0-9_-]{0,31}_[a-f0-9]{64}$/u.test(data.identityId)) return Object.freeze([]);
    if (typeof data.provider !== "string" || data.provider.length === 0) return Object.freeze([]);
    if (typeof data.keyVersion !== "string" || data.keyVersion.length === 0) return Object.freeze([]);
    if (typeof data.subjectHmac !== "string" || !/^[a-f0-9]{64}$/u.test(data.subjectHmac)) return Object.freeze([]);
    if (data.identityId !== `${data.keyVersion}_${data.subjectHmac}`) return Object.freeze([]);
    if (seen.has(data.identityId)) return Object.freeze([]);
    seen.add(data.identityId);
    references.push(Object.freeze({ identityId: data.identityId, provider: data.provider, keyVersion: data.keyVersion, subjectHmac: data.subjectHmac }));
  }
  return Object.freeze(references);
}

function isAuthUserNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "auth/user-not-found" || code === "user-not-found";
}

function phaseFromData(data: Record<string, unknown>): DeletionPhase | null {
  const stored = data.phase;
  if (typeof stored === "string" && DELETION_PHASES.includes(stored as DeletionPhase)) {
    const phase = stored as DeletionPhase;
    if ((phase === "remote_deleted" || phase === "complete") && !(data.authDeletedAt instanceof Timestamp || data.authDeletedAt instanceof Date)) return null;
    if (phase === "remote_deleted") {
      const refs = deletionIdentityReferences(data.identityRefs);
      if (refs.length === 0 || typeof data.operationSecretHash !== "string" || !/^[a-f0-9]{64}$/u.test(data.operationSecretHash)) return null;
    }
    if (phase === "complete" && (typeof data.proofId !== "string" || typeof data.operationSecretHash !== "string" || !/^[a-f0-9]{64}$/u.test(data.operationSecretHash))) return null;
    return phase;
  }
  if (data.status === "complete" || data.status === "remote_deleted") return null;
  if (data.status === "remote_deleting") return "firestore_deleting";
  if (data.status === undefined || data.status === "pending" || data.status === "failed") return "prepared";
  return null;
}

function externalStatus(data: Record<string, unknown>, phase: DeletionPhase): DeletionOperationStatus["status"] {
  if (phase === "complete" || data.status === "complete") return "complete";
  if (phase === "remote_deleted") return "remote_deleted";
  return "pending";
}

function statusForPhase(phase: DeletionPhase): "pending" | "remote_deleting" | "remote_deleted" | "complete" {
  if (phase === "prepared" || phase === "sessions_revoking") return "pending";
  if (phase === "firestore_deleting" || phase === "auth_deleting") return "remote_deleting";
  if (phase === "remote_deleted") return "remote_deleted";
  return "complete";
}

function sameIdentityReferences(left: readonly StoredDeletionIdentity[], right: readonly StoredDeletionIdentity[]): boolean {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map((reference) => [reference.identityId, reference]));
  return left.every((reference) => {
    const other = rightById.get(reference.identityId);
    return other?.provider === reference.provider && other.keyVersion === reference.keyVersion && other.subjectHmac === reference.subjectHmac;
  });
}

function isTransientDeletionError(error: unknown): boolean {
  return error instanceof Error && ["remote_deletion_pending", "session_revocation_failed", "account_deletion_in_progress", "account_deletion_conflict"].includes(error.message);
}

export class FirestoreAccountLifecycleStore implements AccountLifecycleStore {
  public constructor(private readonly db: Firestore, private readonly auth: FirebaseAdminAuth, private readonly pseudonymKeyRing: PseudonymKeyRing) {}

  public async issueRecoveryCodes(userId: string, expectedAuthorizationGeneration: number): Promise<RecoveryCodesResult> {
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const generationId = randomUUID();
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
    const createdAt = now();
    await this.db.runTransaction(async (transaction) => {
      const user = await transaction.get(userRef);
      if (!user.exists) throw new Error("account_deleted");
      assertExpectedAuthorizationGeneration(asRecord(user.data(), "user"), expectedAuthorizationGeneration);
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
    const recovered = await this.db.runTransaction(async (transaction) => {
      const current = await transaction.get(indexRef);
      if (!current.exists) throw new Error("recovery_code_invalid");
      const data = asRecord(current.data(), "recovery_code");
      if (data.usedAt !== null) throw new Error("recovery_code_used");
      if (typeof data.userId !== "string") throw new Error("recovery_code_invalid");
      const userId = data.userId;
      const user = await transaction.get(this.db.collection(COLLECTIONS.users).doc(userId));
      if (!user.exists) throw new Error("account_deleted");
      const userData = asRecord(user.data(), "user");
      if (userData.deletedAt !== undefined || (userData.authorizationState !== undefined && userData.authorizationState !== "active")) throw new Error("account_deleted");
      const authorizationGeneration = userData.authorizationGeneration === undefined ? 1 : userData.authorizationGeneration;
      if (typeof authorizationGeneration !== "number" || !Number.isSafeInteger(authorizationGeneration) || authorizationGeneration <= 0) throw new Error("account_deleted");
      const identities = await transaction.get(this.db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId));
      const subjects = identities.docs
        .map((document) => asRecord(document.data(), "identity_mapping"))
        .filter((identity) => identity.provider === "firebase" && typeof identity.subject === "string")
        .map((identity) => identity.subject as string);
      if (subjects.length !== 1) throw new Error("recovery_code_invalid");
      const subject = subjects[0];
      if (!subject) throw new Error("recovery_code_invalid");
      const tombstoneRefs = this.pseudonymKeyRing.candidates("firebase", subject).map(({ documentId }) => this.db.collection(COLLECTIONS.deletedIdentities).doc(documentId));
      const tombstones = await transaction.getAll(...tombstoneRefs);
      if (tombstones.some((tombstone) => tombstone.exists && !isExpiredIdentityTombstone(tombstone.data()))) throw new Error("account_deleted");
      transaction.update(indexRef, { usedAt: now() });
      return Object.freeze({ subject, authorizationGeneration });
    });
    try {
      await this.auth.revokeRefreshTokens(recovered.subject);
    } catch {
      throw new Error("recovery_session_revocation_failed");
    }
    return Object.freeze({ customToken: await this.auth.createCustomToken(recovered.subject, { authorizationGeneration: recovered.authorizationGeneration }) });
  }

  public async revokeSessions(userId: string, expectedAuthorizationGeneration: number, operationId: string): Promise<SessionRevocationResult> {
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const operationRef = this.db.collection(COLLECTIONS.sessionRevocationOperations).doc(operationId);
    const claimedAt = now();
    const leaseUntil = Timestamp.fromMillis(claimedAt.toMillis() + SECURITY_OPERATION_LEASE_MS);
    const fence = randomUUID();
    const claim = await this.db.runTransaction(async (transaction) => {
      const user = await transaction.get(userRef);
      const operation = await transaction.get(operationRef);
      if (!user.exists) throw new Error("account_deleted");
      const userData = asRecord(user.data(), "user");
      assertExpectedAuthorizationGeneration(userData, expectedAuthorizationGeneration);
      if (expectedAuthorizationGeneration >= Number.MAX_SAFE_INTEGER) throw new Error("authorization_generation_invalid");

      let operationData: Record<string, unknown> | null = null;
      if (operation.exists) {
        operationData = asRecord(operation.data(), "session_revocation");
        if (operationData.userId !== userId) throw new Error("session_revocation_operation_conflict");
        if (operationData.expectedAuthorizationGeneration !== expectedAuthorizationGeneration) throw new Error("session_revocation_operation_conflict");
        if (operationData.status === "revoked") return Object.freeze({ kind: "complete" as const });
      }

      const currentSlot = userData.securityOperation;
      if (currentSlot !== undefined) {
        if (typeof currentSlot !== "object" || currentSlot === null || Array.isArray(currentSlot)) throw new Error("security_operation_conflict");
        const slot = currentSlot as Record<string, unknown>;
        if (typeof slot.kind !== "string" || typeof slot.operationId !== "string" || typeof slot.fence !== "string" || !(slot.leaseUntil instanceof Timestamp || slot.leaseUntil instanceof Date)) throw new Error("security_operation_conflict");
        const slotLeaseUntil = slot.leaseUntil instanceof Timestamp ? slot.leaseUntil.toMillis() : slot.leaseUntil.getTime();
        if (slotLeaseUntil > claimedAt.toMillis()) {
          if (slot.kind === "session_revoke" && slot.operationId === operationId) {
            if (slot.expectedAuthorizationGeneration !== expectedAuthorizationGeneration) throw new Error("session_revocation_operation_conflict");
            return Object.freeze({ kind: "in_progress" as const });
          }
          throw new Error("session_revocation_operation_conflict");
        }
      }

      const identities = await transaction.get(this.db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId));
      const subjects = [...new Set(identities.docs
        .map((document) => asRecord(document.data(), "identity_mapping"))
        .filter((identity) => identity.provider === "firebase" && typeof identity.subject === "string")
        .map((identity) => identity.subject as string))];
      if (subjects.length !== 1) throw new Error("session_revocation_identity_unavailable");
      const securityOperation = Object.freeze({ kind: "session_revoke", operationId, expectedAuthorizationGeneration, fence, leaseUntil });
      transaction.set(userRef, { securityOperation }, { merge: true });
      transaction.set(operationRef, {
        operationId,
        userId,
        expectedAuthorizationGeneration,
        status: "pending",
        updatedAt: claimedAt,
        failureCode: FieldValue.delete(),
      }, { merge: true });
      return Object.freeze({ kind: "claimed" as const, subjects: Object.freeze(subjects), fence });
    });
    const mintReplacementSession = async (knownSubject?: string): Promise<SessionRevocationResult> => {
      let subject = knownSubject;
      if (!subject) {
        const identities = await this.db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId).get();
        const subjects = [...new Set(identities.docs
          .map((document) => asRecord(document.data(), "identity_mapping"))
          .filter((identity) => identity.provider === "firebase" && typeof identity.subject === "string")
          .map((identity) => identity.subject as string))];
        if (subjects.length !== 1) throw new Error("session_revocation_identity_unavailable");
        [subject] = subjects;
      }
      if (!subject) throw new Error("session_revocation_identity_unavailable");
      try {
        const customToken = await this.auth.createCustomToken(subject, { authorizationGeneration: expectedAuthorizationGeneration });
        return Object.freeze({ status: "revoked", operationId, customToken });
      } catch {
        throw new Error("session_reissue_failed");
      }
    };

    if (claim.kind === "complete") return mintReplacementSession();
    if (claim.kind === "in_progress") throw new Error("session_revocation_in_progress");

    const finalize = async (status: "failed" | "revoked"): Promise<void> => this.db.runTransaction(async (transaction) => {
      const user = await transaction.get(userRef);
      const operation = await transaction.get(operationRef);
      if (!user.exists) throw new Error("account_deleted");
      const userData = asRecord(user.data(), "user");
      assertExpectedAuthorizationGeneration(userData, expectedAuthorizationGeneration);
      const slotValue = userData.securityOperation;
      if (typeof slotValue !== "object" || slotValue === null || Array.isArray(slotValue)) throw new Error("session_revocation_operation_conflict");
      const slot = slotValue as Record<string, unknown>;
      if (slot.kind !== "session_revoke" || slot.operationId !== operationId || slot.expectedAuthorizationGeneration !== expectedAuthorizationGeneration || slot.fence !== claim.fence) throw new Error("session_revocation_operation_conflict");
      if (!operation.exists) throw new Error("session_revocation_operation_conflict");
      const operationData = asRecord(operation.data(), "session_revocation");
      if (operationData.userId !== userId || operationData.expectedAuthorizationGeneration !== expectedAuthorizationGeneration || operationData.status !== "pending") throw new Error("session_revocation_operation_conflict");
      const updatedAt = now();
      transaction.set(operationRef, { status, updatedAt, ...(status === "failed" ? { failureCode: "session_revocation_failed" } : { failureCode: FieldValue.delete() }) }, { merge: true });
      transaction.set(userRef, { securityOperation: FieldValue.delete() }, { merge: true });
    });

    try {
      for (const subject of claim.subjects) await this.auth.revokeRefreshTokens(subject);
    } catch {
      await finalize("failed");
      throw new Error("session_revocation_failed");
    }
    await finalize("revoked");
    return mintReplacementSession(claim.subjects[0]);
  }

  public async deleteAccount(userId: string, expectedAuthorizationGeneration: number, operationId: string, operationSecret: string): Promise<AccountDeletionResult> {
    const ref = operationRef(this.db, operationId);
    const operation = await this.prepareDeletionOperation(userId, expectedAuthorizationGeneration, operationId, operationSecret);
    if (operation.phase === "complete" || operation.phase === "remote_deleted") {
      if (operation.phase === "complete") {
        const proof = await this.readDeletionProof(operation.proofId);
        if (!proof || proof.operationId !== operationId) throw new Error("remote_deletion_pending");
      }
      return Object.freeze({ operationId, proofId: operation.proofId, status: "already_deleted" });
    }
    if (!operation.userId) throw new Error("remote_deletion_pending");
    return this.continueDeletion(operation);
  }

  public async completeDeletion(operationId: string, proofId: string): Promise<CompletedDeletion> {
    const ref = operationRef(this.db, operationId);
    const operation = await this.readStoredDeletionOperation(ref);
    if (operation.proofId !== proofId || !["remote_deleted", "complete"].includes(operation.phase)) throw new Error("remote_deletion_pending");
    if (operation.phase === "complete") {
      const proof = await this.readDeletionProof(proofId);
      if (!proof || proof.operationId !== operationId) throw new Error("remote_deletion_pending");
      return Object.freeze({ status: "deleted", operationId, proofId });
    }
    if (!operation.userId) throw new Error("remote_deletion_pending");
    try {
      await this.assertFirestoreDeletionComplete(operation.userId, operation.identityRefs);
    } catch {
      throw new Error("remote_deletion_pending");
    }
    const completedAt = now();
    await this.db.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      if (!current.exists) throw new Error("remote_deletion_pending");
      const currentData = asRecord(current.data(), "account_deletion_operation");
      const currentPhase = phaseFromData(currentData);
      if (currentPhase === null || currentData.userId !== operation.userId || currentData.proofId !== proofId || !["remote_deleted", "complete"].includes(currentPhase)) throw new Error("remote_deletion_pending");
      if (currentPhase === "complete") return;
      if (currentData.fence !== operation.fence) throw new Error("account_deletion_conflict");
      const currentIdentityRefs = deletionIdentityReferences(currentData.identityRefs);
      if (!sameIdentityReferences(operation.identityRefs, currentIdentityRefs)) throw new Error("remote_deletion_pending");
      const tombstoneSnapshots = await transaction.getAll(...operation.identityRefs.map((identity) => this.db.collection(COLLECTIONS.deletedIdentities).doc(identity.identityId)));
      this.assertTombstoneSnapshots(operation.identityRefs, tombstoneSnapshots);
      const expiresAt = Timestamp.fromMillis(completedAt.toMillis() + PROOF_RETENTION_MS);
      transaction.set(ref, { status: "complete", phase: "complete", completedAt, updatedAt: completedAt, expiresAt, userId: FieldValue.delete(), identityRefs: FieldValue.delete(), authSubjects: FieldValue.delete(), subjectHashes: FieldValue.delete(), failureCode: FieldValue.delete() }, { merge: true });
      transaction.set(this.db.collection(COLLECTIONS.deletionProofs).doc(proofId), { status: "deleted", operationId, proofId, completedAt, expiresAt }, { merge: true });
    });
    return Object.freeze({ status: "deleted", operationId, proofId });
  }

  public async resumeDeletion(operationId: string, operationSecret: string): Promise<DeletionOperationStatus | null> {
    let operation = await this.readBoundDeletionOperation(operationId, operationSecret);
    if (!operation) return null;
    if (operation.phase === "complete") {
      const proof = await this.readDeletionProof(operation.proofId);
      if (!proof || proof.operationId !== operationId) return null;
      return Object.freeze({ status: "complete", operationId, proofId: operation.proofId });
    }
    if (operation.phase === "remote_deleted") {
      try {
        await this.completeDeletion(operationId, operation.proofId);
      } catch (error) {
        if (!isTransientDeletionError(error)) throw error;
      }
      return this.readDeletionOperationStatus(operationId, operationSecret);
    }
    try {
      if (!operation.userId) return null;
      operation = await this.claimDeletionResume(operation);
      const result = await this.continueDeletion(operation);
      await this.completeDeletion(result.operationId, result.proofId);
    } catch (error) {
      if (!isTransientDeletionError(error)) throw error;
    }
    return this.readDeletionOperationStatus(operationId, operationSecret);
  }

  public async readDeletionProof(proofId: string): Promise<DeletionProof | null> {
    const snapshot = await this.db.collection(COLLECTIONS.deletionProofs).doc(proofId).get();
    if (!snapshot.exists) return null;
    const data = asRecord(snapshot.data(), "deletion_proof");
    if (data.status !== "deleted" || typeof data.operationId !== "string") return null;
    if (!(data.expiresAt instanceof Timestamp || data.expiresAt instanceof Date) || asTimestamp(data.expiresAt, "deletion_proof_expiry").toMillis() <= Date.now()) {
      await snapshot.ref.delete().catch(() => undefined);
      return null;
    }
    const operation = await operationRef(this.db, data.operationId).get();
    if (!operation.exists) return null;
    const operationData = asRecord(operation.data(), "account_deletion_operation");
    const phase = phaseFromData(operationData);
    if (phase !== "complete" || operationData.proofId !== proofId) return null;
    return Object.freeze({ status: "deleted", operationId: data.operationId, proofId });
  }

  public async readDeletionOperationStatus(operationId: string, operationSecret: string): Promise<DeletionOperationStatus | null> {
    const snapshot = await operationRef(this.db, operationId).get();
    if (!snapshot.exists) return null;
    const data = asRecord(snapshot.data(), "account_deletion_operation");
    if (data.operationSecretHash !== sha256(operationSecret)) return null;
    if (!["pending", "remote_deleting", "remote_deleted", "complete", "failed"].includes(String(data.status))) return null;
    const phase = phaseFromData(data);
    if (phase === null) return null;
    if (phase === "complete" && (!(data.expiresAt instanceof Timestamp || data.expiresAt instanceof Date) || asTimestamp(data.expiresAt, "account_deletion_operation_expiry").toMillis() <= Date.now())) {
      await snapshot.ref.delete().catch(() => undefined);
      return null;
    }
    if (phase === "complete") {
      const proofId = typeof data.proofId === "string" ? data.proofId : null;
      if (proofId === null || !(await this.readDeletionProof(proofId))) return null;
      return Object.freeze({ status: "complete", operationId, proofId });
    }
    if (!this.persistedDeletionSet(data)) return null;
    return Object.freeze({ status: externalStatus(data, phase), operationId, proofId: typeof data.proofId === "string" ? data.proofId : null });
  }

  private userOwnsDeletion(userData: Record<string, unknown>, operation: StoredDeletionOperation, fence: string): boolean {
    const slotValue = userData.securityOperation;
    if (typeof slotValue !== "object" || slotValue === null || Array.isArray(slotValue)) return false;
    const slot = slotValue as Record<string, unknown>;
    return userData.authorizationState === "deleting"
      && userData.authorizationGeneration === operation.expectedAuthorizationGeneration + 1
      && slot.kind === "account_delete"
      && slot.operationId === operation.operationId
      && slot.expectedAuthorizationGeneration === operation.expectedAuthorizationGeneration
      && slot.phase === operation.phase
      && slot.fence === fence;
  }

  private async claimDeletionResume(operation: StoredDeletionOperation): Promise<StoredDeletionOperation> {
    const ref = operationRef(this.db, operation.operationId);
    const userRef = this.db.collection(COLLECTIONS.users).doc(operation.userId ?? "");
    const fence = randomUUID();
    const claimedAt = now();
    const leaseUntil = Timestamp.fromMillis(claimedAt.toMillis() + SECURITY_OPERATION_LEASE_MS);
    await this.db.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      const user = await transaction.get(userRef);
      if (!current.exists) throw new Error("remote_deletion_pending");
      const data = asRecord(current.data(), "account_deletion_operation");
      const phase = phaseFromData(data);
      if (phase !== operation.phase || data.userId !== operation.userId || data.operationSecretHash !== operation.operationSecretHash) throw new Error("account_deletion_conflict");
      if (data.fence !== operation.fence) throw new Error("account_deletion_in_progress");
      const currentLease = data.leaseUntil;
      const currentLeaseMs = currentLease instanceof Timestamp ? currentLease.toMillis() : currentLease instanceof Date ? currentLease.getTime() : Number.POSITIVE_INFINITY;
      if (currentLeaseMs > claimedAt.toMillis()) throw new Error("account_deletion_in_progress");
      if (user.exists && !this.userOwnsDeletion(asRecord(user.data(), "user"), operation, operation.fence)) throw new Error("account_deletion_conflict");
      if (!user.exists && operation.phase !== "firestore_deleting") throw new Error("account_deletion_conflict");
      transaction.set(ref, { fence, leaseUntil, updatedAt: claimedAt, failureCode: FieldValue.delete(), status: statusForPhase(phase) }, { merge: true });
      if (user.exists) transaction.set(userRef, {
        securityOperation: Object.freeze({ kind: "account_delete", operationId: operation.operationId, expectedAuthorizationGeneration: operation.expectedAuthorizationGeneration, phase, fence, leaseUntil }),
        updatedAt: claimedAt,
      }, { merge: true });
    });
    return this.readStoredDeletionOperation(ref);
  }

  private async releaseDeletionLease(ref: DocumentReference, operation: StoredDeletionOperation, fence: string, failureCode: string): Promise<void> {
    const userRef = this.db.collection(COLLECTIONS.users).doc(operation.userId ?? "");
    const releasedAt = now();
    const leaseUntil = Timestamp.fromMillis(releasedAt.toMillis() - 1);
    await this.db.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      const user = await transaction.get(userRef);
      if (!current.exists) return;
      const data = asRecord(current.data(), "account_deletion_operation");
      if (data.phase !== operation.phase || data.fence !== fence) return;
      transaction.set(ref, { status: "failed", failureCode, leaseUntil, updatedAt: releasedAt }, { merge: true });
      if (user.exists && this.userOwnsDeletion(asRecord(user.data(), "user"), operation, fence)) transaction.set(userRef, {
        "securityOperation.leaseUntil": leaseUntil,
        updatedAt: releasedAt,
      }, { merge: true });
    });
  }

  private async continueDeletion(initial: StoredDeletionOperation): Promise<AccountDeletionResult> {
    const ref = operationRef(this.db, initial.operationId);
    let operation = initial;
    const userId = operation.userId;
    if (!userId) throw new Error("remote_deletion_pending");
    try {
      while (operation.phase !== "remote_deleted" && operation.phase !== "complete") {
        const fence = operation.fence;
        if (operation.phase === "sessions_revoking") {
          try {
            await this.revokeDeletionSubjects(await this.firebaseSubjectsForUser(userId, operation.identityRefs));
          } catch {
            await this.releaseDeletionLease(ref, operation, fence, "session_revocation_failed");
            throw new Error("session_revocation_failed");
          }
          operation = await this.advanceDeletionPhase(ref, operation, fence, "auth_deleting");
          continue;
        }
        if (operation.phase === "auth_deleting") {
          try {
            await this.deleteAuthSubjects(await this.firebaseSubjectsForUser(userId, operation.identityRefs));
          } catch {
            await this.releaseDeletionLease(ref, operation, fence, "auth_deletion_failed");
            throw new Error("remote_deletion_pending");
          }
          operation = await this.advanceDeletionPhase(ref, operation, fence, "firestore_deleting");
          continue;
        }
        if (operation.phase === "firestore_deleting") {
          try {
            await this.deleteFirestoreOwnedData(userId, operation.identityRefs, operation, fence);
          } catch {
            await this.releaseDeletionLease(ref, operation, fence, "firestore_deletion_failed").catch(() => undefined);
            throw new Error("remote_deletion_pending");
          }
          operation = await this.advanceDeletionPhase(ref, operation, fence, "remote_deleted");
          continue;
        }
        throw new Error("remote_deletion_pending");
      }
    } catch (error) {
      if (error instanceof Error && ["session_revocation_failed", "remote_deletion_pending", "account_deletion_in_progress", "account_deletion_conflict"].includes(error.message)) throw error;
      throw new Error("remote_deletion_pending");
    }
    operation = await this.readStoredDeletionOperation(ref);
    return Object.freeze({ operationId: operation.operationId, proofId: operation.proofId, status: operation.phase === "remote_deleted" ? "remote_deleted" : "already_deleted" });
  }

  private async prepareDeletionOperation(userId: string, expectedAuthorizationGeneration: number, operationId: string, operationSecret: string): Promise<StoredDeletionOperation> {
    const ref = operationRef(this.db, operationId);
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    await this.db.runTransaction(async (transaction) => {
      const user = await transaction.get(userRef);
      const current = await transaction.get(ref);
      if (!user.exists) throw new Error("account_deleted");
      if (current.exists) throw new Error("account_deletion_conflict");
      const userData = asRecord(user.data(), "user");
      assertExpectedAuthorizationGeneration(userData, expectedAuthorizationGeneration);
      if (userData.deletedAt !== undefined || (userData.authorizationState !== undefined && userData.authorizationState !== "active")) throw new Error("account_deleted");
      const currentSlot = userData.securityOperation;
      if (currentSlot !== undefined) {
        if (typeof currentSlot !== "object" || currentSlot === null || Array.isArray(currentSlot)) throw new Error("security_operation_conflict");
        const slot = currentSlot as Record<string, unknown>;
        const slotLease = slot.leaseUntil instanceof Timestamp || slot.leaseUntil instanceof Date;
        if (slot.kind === "session_revoke" && slot.expectedAuthorizationGeneration === expectedAuthorizationGeneration && typeof slot.operationId === "string" && typeof slot.fence === "string" && slotLease) {
          // Account deletion advances the generation and atomically replaces a session-revoke owner.
        } else if (slot.kind === "account_delete") {
          throw new Error("account_deletion_conflict");
        } else {
          throw new Error("security_operation_conflict");
        }
      }
      const identities = await transaction.get(this.db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId));
      const identityRefs = this.deletionIdentityReferences(identities.docs);
      if (identityRefs.length === 0) throw new Error("remote_deletion_pending");
      const createdAt = now();
      const proofId = `proof_${randomBytes(18).toString("base64url")}`;
      const fence = randomUUID();
      const leaseUntil = Timestamp.fromMillis(createdAt.toMillis() + SECURITY_OPERATION_LEASE_MS);
      transaction.create(ref, {
        operationId,
        userId,
        status: "pending",
        phase: "sessions_revoking",
        proofId,
        operationSecretHash: sha256(operationSecret),
        identityRefs,
        expectedAuthorizationGeneration,
        fence,
        leaseUntil,
        createdAt,
        updatedAt: createdAt,
      });
      transaction.set(userRef, {
        authorizationState: "deleting",
        authorizationGeneration: expectedAuthorizationGeneration + 1,
        securityOperation: Object.freeze({ kind: "account_delete", operationId, expectedAuthorizationGeneration, phase: "sessions_revoking", fence, leaseUntil }),
        updatedAt: createdAt,
      }, { merge: true });
    });
    return this.readStoredDeletionOperation(ref);
  }

  private async readStoredDeletionOperation(ref: DocumentReference): Promise<StoredDeletionOperation> {
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new Error("remote_deletion_pending");
    const data = asRecord(snapshot.data(), "account_deletion_operation");
    if (typeof data.proofId !== "string") throw new Error("remote_deletion_pending");
    const phase = phaseFromData(data);
    if (phase === null) throw new Error("remote_deletion_pending");
    const persisted = phase === "complete" ? null : this.persistedDeletionSet(data);
    if (phase !== "complete" && !persisted) throw new Error("remote_deletion_pending");
    const identityRefs = persisted?.identityRefs ?? deletionIdentityReferences(data.identityRefs);
    const expectedAuthorizationGeneration = data.expectedAuthorizationGeneration;
    const fence = data.fence;
    const leaseUntil = data.leaseUntil;
    if (typeof expectedAuthorizationGeneration !== "number" || !Number.isSafeInteger(expectedAuthorizationGeneration) || expectedAuthorizationGeneration <= 0 || typeof fence !== "string" || fence.length === 0 || !(leaseUntil instanceof Timestamp || leaseUntil instanceof Date)) throw new Error("remote_deletion_pending");
    return Object.freeze({
      operationId: ref.id,
      userId: typeof data.userId === "string" ? data.userId : null,
      proofId: data.proofId,
      status: typeof data.status === "string" ? data.status : statusForPhase(phase),
      phase,
      operationSecretHash: persisted?.operationSecretHash ?? String(data.operationSecretHash ?? ""),
      identityRefs,
      expectedAuthorizationGeneration,
      fence,
      leaseUntil,
    });
  }

  private async readBoundDeletionOperation(operationId: string, operationSecret: string): Promise<StoredDeletionOperation | null> {
    const ref = operationRef(this.db, operationId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return null;
    const data = asRecord(snapshot.data(), "account_deletion_operation");
    if (data.operationSecretHash !== sha256(operationSecret)) return null;
    if (typeof data.proofId !== "string") return null;
    const phase = phaseFromData(data);
    if (phase === null) return null;
    const persisted = phase === "complete" ? null : this.persistedDeletionSet(data);
    if (phase !== "complete" && !persisted) return null;
    const identityRefs = persisted?.identityRefs ?? deletionIdentityReferences(data.identityRefs);
    const expectedAuthorizationGeneration = data.expectedAuthorizationGeneration;
    const fence = data.fence;
    const leaseUntil = data.leaseUntil;
    if (typeof expectedAuthorizationGeneration !== "number" || !Number.isSafeInteger(expectedAuthorizationGeneration) || expectedAuthorizationGeneration <= 0 || typeof fence !== "string" || fence.length === 0 || !(leaseUntil instanceof Timestamp || leaseUntil instanceof Date)) return null;
    return Object.freeze({
      operationId,
      userId: typeof data.userId === "string" ? data.userId : null,
      proofId: data.proofId,
      status: typeof data.status === "string" ? data.status : statusForPhase(phase),
      phase,
      operationSecretHash: persisted?.operationSecretHash ?? String(data.operationSecretHash ?? ""),
      identityRefs,
      expectedAuthorizationGeneration,
      fence,
      leaseUntil,
    });
  }

  private async advanceDeletionPhase(ref: DocumentReference, operation: StoredDeletionOperation, fence: string, target: DeletionPhase): Promise<StoredDeletionOperation> {
    const userRef = this.db.collection(COLLECTIONS.users).doc(operation.userId ?? "");
    const nextFence = randomUUID();
    let advancedAt = now();
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("remote_deletion_pending");
      const data = asRecord(snapshot.data(), "account_deletion_operation");
      const current = phaseFromData(data);
      if (current !== operation.phase || data.fence !== fence || data.userId !== operation.userId) throw new Error("account_deletion_conflict");
      const leaseUntil = data.leaseUntil;
      const leaseMs = leaseUntil instanceof Timestamp ? leaseUntil.toMillis() : leaseUntil instanceof Date ? leaseUntil.getTime() : 0;
      if (leaseMs <= Date.now()) throw new Error("account_deletion_conflict");
      const user = operation.phase === "firestore_deleting" ? null : await transaction.get(userRef);
      if (user && (!user.exists || !this.userOwnsDeletion(asRecord(user.data(), "user"), operation, fence))) throw new Error("account_deletion_conflict");
      advancedAt = now();
      const nextLease = Timestamp.fromMillis(advancedAt.toMillis() + SECURITY_OPERATION_LEASE_MS);
      transaction.set(ref, {
        phase: target,
        status: statusForPhase(target),
        fence: nextFence,
        leaseUntil: nextLease,
        updatedAt: advancedAt,
        ...(target === "firestore_deleting" ? { authDeletedAt: advancedAt } : {}),
        ...(target === "remote_deleted" ? { authDeletedAt: data.authDeletedAt ?? advancedAt, remoteDeletedAt: advancedAt } : {}),
      }, { merge: true });
      if (target !== "remote_deleted" && user) transaction.set(userRef, {
        securityOperation: Object.freeze({ kind: "account_delete", operationId: operation.operationId, expectedAuthorizationGeneration: operation.expectedAuthorizationGeneration, phase: target, fence: nextFence, leaseUntil: nextLease }),
        updatedAt: advancedAt,
      }, { merge: true });
    });
    return this.readStoredDeletionOperation(ref);
  }

  private firebaseSubjects(documents: readonly { data: () => unknown }[]): readonly string[] {
    return Object.freeze([...new Set(documents
      .map((document) => asRecord(document.data(), "identity_mapping"))
      .filter((identity) => identity.provider === "firebase" && typeof identity.subject === "string" && identity.subject.length > 0)
      .map((identity) => identity.subject as string))]);
  }

  private deletionIdentityReferences(documents: readonly { data: () => unknown }[]): readonly StoredDeletionIdentity[] {
    const references: StoredDeletionIdentity[] = [];
    const seen = new Set<string>();
    for (const document of documents) {
      const identity = asRecord(document.data(), "identity_mapping");
      if (typeof identity.provider !== "string" || identity.provider.length === 0 || typeof identity.subject !== "string" || identity.subject.length === 0) continue;
      const pseudonym = this.pseudonymKeyRing.active(identity.provider, identity.subject);
      const identityId = pseudonym.documentId;
      if (seen.has(identityId)) continue;
      seen.add(identityId);
      references.push(Object.freeze({ identityId, provider: identity.provider, keyVersion: pseudonym.keyVersion, subjectHmac: pseudonym.subjectHmac }));
    }
    return Object.freeze(references);
  }

  private identityReferencesContainSubjects(references: readonly StoredDeletionIdentity[], subjects: readonly string[]): boolean {
    return subjects.every((subject) => references.some((reference) => reference.provider === "firebase" && this.pseudonymKeyRing.verify("firebase", subject, reference)));
  }

  private persistedDeletionSet(data: Record<string, unknown>): Readonly<{ operationSecretHash: string; identityRefs: readonly StoredDeletionIdentity[] }> | null {
    const phase = phaseFromData(data);
    if (phase === null || phase === "complete") return null;
    const operationSecretHash = typeof data.operationSecretHash === "string" && /^[a-f0-9]{64}$/u.test(data.operationSecretHash) ? data.operationSecretHash : null;
    const identityRefs = deletionIdentityReferences(data.identityRefs);
    if (!operationSecretHash || identityRefs.length === 0) return null;
    return Object.freeze({ operationSecretHash, identityRefs });
  }

  private async firebaseSubjectsForUser(userId: string, references: readonly StoredDeletionIdentity[]): Promise<readonly string[]> {
    const mappings = await this.db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId).get();
    const subjects = this.firebaseSubjects(mappings.docs);
    if (subjects.length === 0 || !this.identityReferencesContainSubjects(references, subjects)) throw new Error("remote_deletion_pending");
    return subjects;
  }

  private async revokeDeletionSubjects(subjects: readonly string[]): Promise<void> {
    for (const subject of subjects) {
      try {
        await this.auth.revokeRefreshTokens(subject);
      } catch (error) {
        if (isAuthUserNotFound(error)) continue;
        throw error;
      }
    }
  }

  private async deleteFirestoreOwnedData(userId: string, identityRefs: readonly StoredDeletionIdentity[], operation: StoredDeletionOperation, fence: string): Promise<void> {
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const operationDocument = operationRef(this.db, operation.operationId);
    await this.db.runTransaction(async (transaction) => {
      const storedOperation = await transaction.get(operationDocument);
      const user = await transaction.get(userRef);
      const mappings = await transaction.get(this.db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId));
      const operationData = storedOperation.exists ? asRecord(storedOperation.data(), "account_deletion_operation") : null;
      const leaseUntil = operationData?.leaseUntil;
      const leaseMs = leaseUntil instanceof Timestamp ? leaseUntil.toMillis() : leaseUntil instanceof Date ? leaseUntil.getTime() : 0;
      if (!storedOperation.exists || operationData?.phase !== "firestore_deleting" || operationData.fence !== fence || operationData.userId !== userId || leaseMs <= Date.now()) throw new Error("account_deletion_conflict");
      if (mappings.docs.some((mapping) => {
        const identity = asRecord(mapping.data(), "identity_mapping");
        if (typeof identity.provider !== "string" || typeof identity.subject !== "string") return true;
        const provider = identity.provider;
        const subject = identity.subject;
        return !identityRefs.some((expected) => expected.provider === provider && this.pseudonymKeyRing.verify(provider, subject, expected));
      })) throw new Error("remote_deletion_pending");
      const tombstoneRefs = identityRefs.map((identity) => this.db.collection(COLLECTIONS.deletedIdentities).doc(identity.identityId));
      const tombstones = await transaction.getAll(...tombstoneRefs);
      if (!user.exists) {
        if (mappings.docs.length > 0) throw new Error("remote_deletion_pending");
        this.assertTombstoneSnapshots(identityRefs, tombstones);
        return;
      }
      if (!this.userOwnsDeletion(asRecord(user.data(), "user"), operation, fence)) throw new Error("account_deletion_conflict");
      const deletedAt = now();
      for (let index = 0; index < identityRefs.length; index += 1) {
        const identity = identityRefs[index];
        const tombstone = tombstones[index];
        if (!identity || !tombstone) throw new Error("remote_deletion_pending");
        transaction.set(tombstone.ref, this.tombstoneWrite(identity, tombstone, deletedAt));
      }
      for (const mapping of mappings.docs) transaction.delete(mapping.ref);
      if (mappings.docs.some((mapping) => {
        const data = asRecord(mapping.data(), "identity_mapping");
        return typeof data.provider !== "string" || typeof data.subject !== "string" || data.subject.length === 0;
      })) throw new Error("remote_deletion_pending");
      if (user.exists) transaction.set(userRef, { deletedAt, updatedAt: deletedAt }, { merge: true });
    });

    await this.deleteOwnedQuery(this.db.collection(COLLECTIONS.recoveryCodeIndex).where("userId", "==", userId), operation, fence);
    await this.deleteOwnedQuery(this.db.collection(COLLECTIONS.sessionRevocationOperations).where("userId", "==", userId), operation, fence);
    await this.deleteOwnedQuery(this.db.collection(COLLECTIONS.accountDataExportAudits).where("userId", "==", userId), operation, fence);
    await this.deleteDocumentsOwned([this.db.collection(COLLECTIONS.accountDataExportRateLimits).doc(userId)], operation, fence);
    await this.unlinkOwnedReports(userId, operation, fence);
    await this.deleteSubtreeOwned(userRef, operation, fence);
    await this.deleteRootUserOwned(userRef, operation, fence);
    await this.assertFirestoreDeletionComplete(userId, identityRefs);
  }

  private async assertDeletionOwnerInTransaction(transaction: FirebaseFirestore.Transaction, operation: StoredDeletionOperation, fence: string, phase: DeletionPhase): Promise<void> {
    const snapshot = await transaction.get(operationRef(this.db, operation.operationId));
    if (!snapshot.exists) throw new Error("account_deletion_conflict");
    const data = asRecord(snapshot.data(), "account_deletion_operation");
    const leaseUntil = data.leaseUntil;
    const leaseMs = leaseUntil instanceof Timestamp ? leaseUntil.toMillis() : leaseUntil instanceof Date ? leaseUntil.getTime() : 0;
    if (data.phase !== phase || data.fence !== fence || data.userId !== operation.userId || leaseMs <= Date.now()) throw new Error("account_deletion_conflict");
  }

  private tombstoneWrite(identity: StoredDeletionIdentity, snapshot: { exists: boolean; data: () => unknown }, deletedAt: Timestamp): Record<string, unknown> {
    const existing = snapshot.exists ? asRecord(snapshot.data(), "deleted_identity") : null;
    if (existing !== null) {
      if (existing.provider !== identity.provider) throw new Error("remote_deletion_pending");
      if (existing.keyVersion !== identity.keyVersion || existing.subjectHmac !== identity.subjectHmac) throw new Error("remote_deletion_pending");
    }
    const existingDeletedAt = existing?.deletedAt instanceof Timestamp || existing?.deletedAt instanceof Date ? existing.deletedAt : deletedAt;
    return {
      provider: identity.provider,
      keyVersion: identity.keyVersion,
      subjectHmac: identity.subjectHmac,
      deletedAt: existingDeletedAt,
      expiresAt: Timestamp.fromMillis(asTimestamp(existingDeletedAt, "deleted_identity").toMillis() + TOMBSTONE_RETENTION_MS),
    };
  }

  private assertTombstoneSnapshots(identityRefs: readonly StoredDeletionIdentity[], tombstones: readonly { id: string; exists: boolean; data: () => unknown }[]): void {
    if (identityRefs.length === 0 || tombstones.length !== identityRefs.length) throw new Error("remote_deletion_pending");
    for (let index = 0; index < identityRefs.length; index += 1) {
      const identity = identityRefs[index];
      const tombstone = tombstones[index];
      if (!identity || !tombstone || tombstone.id !== identity.identityId || !tombstone.exists) throw new Error("remote_deletion_pending");
      const data = asRecord(tombstone.data(), "deleted_identity");
      if (data.provider !== identity.provider || data.keyVersion !== identity.keyVersion || data.subjectHmac !== identity.subjectHmac || !(data.expiresAt instanceof Timestamp || data.expiresAt instanceof Date)) throw new Error("remote_deletion_pending");
    }
  }

  private async deleteDocumentsOwned(refs: readonly DocumentReference[], operation: StoredDeletionOperation, fence: string): Promise<void> {
    const batchSize = 400;
    for (let offset = 0; offset < refs.length; offset += batchSize) {
      const batchRefs = refs.slice(offset, offset + batchSize);
      await this.db.runTransaction(async (transaction) => {
        await this.assertDeletionOwnerInTransaction(transaction, operation, fence, "firestore_deleting");
        for (const ref of batchRefs) transaction.delete(ref);
      });
    }
  }

  private async deleteOwnedQuery(query: Query, operation: StoredDeletionOperation, fence: string): Promise<void> {
    for (;;) {
      const page = await query.orderBy(FieldPath.documentId()).limit(400).get();
      if (page.empty) return;
      await this.deleteDocumentsOwned(page.docs.map((document) => document.ref), operation, fence);
    }
  }

  private async unlinkOwnedReports(userId: string, operation: StoredDeletionOperation, fence: string): Promise<void> {
    const query = this.db.collection(COLLECTIONS.contentReports).where("accountId", "==", userId).orderBy(FieldPath.documentId()).limit(400);
    for (;;) {
      const page = await query.get();
      if (page.empty) return;
      const refs = page.docs.map((report) => report.ref);
      await this.db.runTransaction(async (transaction) => {
        await this.assertDeletionOwnerInTransaction(transaction, operation, fence, "firestore_deleting");
        const reports = await transaction.getAll(...refs);
        const updatedAt = now();
        for (const report of reports) {
          if (report.exists && asRecord(report.data(), "content_report").accountId === userId) transaction.update(report.ref, {
            accountId: FieldValue.delete(),
            contactEmail: FieldValue.delete(),
            updatedAt,
          });
        }
      });
    }
  }

  private async deleteSubtreeOwned(ref: DocumentReference, operation: StoredDeletionOperation, fence: string): Promise<void> {
    const collections = await ref.listCollections();
    for (const collection of collections) {
      for (;;) {
        const page = await collection.orderBy(FieldPath.documentId()).limit(200).get();
        if (page.empty) break;
        for (const document of page.docs) await this.deleteSubtreeOwned(document.ref, operation, fence);
        await this.deleteDocumentsOwned(page.docs.map((document) => document.ref), operation, fence);
      }
    }
  }

  private async deleteRootUserOwned(userRef: DocumentReference, operation: StoredDeletionOperation, fence: string): Promise<void> {
    await this.db.runTransaction(async (transaction) => {
      await this.assertDeletionOwnerInTransaction(transaction, operation, fence, "firestore_deleting");
      const user = await transaction.get(userRef);
      if (!user.exists) return;
      if (!this.userOwnsDeletion(asRecord(user.data(), "user"), operation, fence)) throw new Error("account_deletion_conflict");
      transaction.delete(userRef);
    });
  }

  private async deleteAuthSubjects(subjects: readonly string[]): Promise<void> {
    for (const subject of subjects) {
      try {
        await this.auth.deleteUser(subject);
      } catch (error) {
        if (isAuthUserNotFound(error)) continue;
        throw error;
      }
    }
  }

  private async assertFirestoreDeletionComplete(userId: string, identityRefs: readonly StoredDeletionIdentity[]): Promise<void> {
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const [user, mappings, recoveryCodes, sessionRevocations, linkedReports, exportAudits, exportRateLimit] = await Promise.all([
      userRef.get(),
      this.db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId).get(),
      this.db.collection(COLLECTIONS.recoveryCodeIndex).where("userId", "==", userId).get(),
      this.db.collection(COLLECTIONS.sessionRevocationOperations).where("userId", "==", userId).get(),
      this.db.collection(COLLECTIONS.contentReports).where("accountId", "==", userId).get(),
      this.db.collection(COLLECTIONS.accountDataExportAudits).where("userId", "==", userId).get(),
      this.db.collection(COLLECTIONS.accountDataExportRateLimits).doc(userId).get(),
    ]);
    if (user.exists || !mappings.empty || !recoveryCodes.empty || !sessionRevocations.empty || !linkedReports.empty || !exportAudits.empty || exportRateLimit.exists) throw new Error("remote_deletion_pending");
    const childCollections = await userRef.listCollections();
    const childDocuments = await Promise.all(childCollections.map((collection) => collection.limit(1).get()));
    if (childDocuments.some((documents) => !documents.empty)) throw new Error("remote_deletion_pending");
    const tombstones = await this.db.getAll(...identityRefs.map((identity) => this.db.collection(COLLECTIONS.deletedIdentities).doc(identity.identityId)));
    this.assertTombstoneSnapshots(identityRefs, tombstones);
  }
}
