import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Firestore, DocumentReference } from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
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
type DeletionPhase = "prepared" | "sessions_revoking" | "firestore_deleting" | "auth_deleting" | "remote_deleted" | "complete";
type StoredDeletionIdentity = Readonly<{ identityId: string; provider: string; subjectHash: string }>;
type StoredDeletionOperation = Readonly<{
  operationId: string;
  userId: string;
  proofId: string;
  status: string;
  phase: DeletionPhase;
  authSubjects: readonly string[];
  subjectHashes: readonly string[];
  identityRefs: readonly StoredDeletionIdentity[];
}>;

const DELETION_PHASE_ORDER: Readonly<Record<DeletionPhase, number>> = Object.freeze({
  prepared: 0,
  sessions_revoking: 1,
  firestore_deleting: 2,
  auth_deleting: 3,
  remote_deleted: 4,
  complete: 5,
});
const DELETION_PHASES: readonly DeletionPhase[] = Object.freeze(Object.keys(DELETION_PHASE_ORDER) as DeletionPhase[]);

export interface AccountLifecycleStore {
  issueRecoveryCodes(userId: string): Promise<RecoveryCodesResult>;
  consumeRecoveryCode(code: string): Promise<Readonly<{ customToken: string }>>;
  revokeSessions(userId: string, operationId: string): Promise<Readonly<{ status: "revoked"; operationId: string }>>;
  deleteAccount(userId: string, operationId: string): Promise<AccountDeletionResult>;
  completeDeletion(operationId: string, proofId: string): Promise<CompletedDeletion>;
  resumeDeletion(operationId: string, accountUidHash: string): Promise<DeletionOperationStatus | null>;
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
    if (typeof data.identityId !== "string" || !/^[a-f0-9]{64}$/u.test(data.identityId)) return Object.freeze([]);
    if (typeof data.provider !== "string" || data.provider.length === 0) return Object.freeze([]);
    if (typeof data.subjectHash !== "string" || !/^[a-f0-9]{64}$/u.test(data.subjectHash)) return Object.freeze([]);
    if (seen.has(data.identityId)) return Object.freeze([]);
    seen.add(data.identityId);
    references.push(Object.freeze({ identityId: data.identityId, provider: data.provider, subjectHash: data.subjectHash }));
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
    if (phase === "remote_deleted" || phase === "complete") {
      const refs = deletionIdentityReferences(data.identityRefs);
      const hashes = hashArray(data.subjectHashes);
      if (refs.length === 0 || hashes.length === 0 || !hashes.every((hash) => refs.some((ref) => ref.provider === "firebase" && ref.subjectHash === hash))) return null;
    }
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
    return other?.provider === reference.provider && other.subjectHash === reference.subjectHash;
  });
}

function isTransientDeletionError(error: unknown): boolean {
  return error instanceof Error && ["remote_deletion_pending", "session_revocation_failed"].includes(error.message);
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
    const writeResult = async (status: "failed" | "revoked") => this.db.runTransaction(async (transaction) => {
      const user = await transaction.get(this.db.collection(COLLECTIONS.users).doc(userId));
      if (!user.exists || asRecord(user.data(), "user").deletedAt !== undefined) throw new Error("account_deleted");
      transaction.set(ref, { operationId, userId, status, ...(status === "failed" ? { failureCode: "session_revocation_failed" } : {}), updatedAt: now() }, { merge: true });
    });
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
      await writeResult("failed");
      throw new Error("session_revocation_failed");
    }
    await writeResult("revoked");
    return Object.freeze({ status: "revoked", operationId });
  }

  public async deleteAccount(userId: string, operationId: string): Promise<AccountDeletionResult> {
    const ref = operationRef(this.db, operationId);
    let operation = await this.prepareDeletionOperation(userId, operationId);
    if (operation.phase === "complete" || operation.phase === "remote_deleted") {
      if (operation.phase === "complete") {
        const proof = await this.readDeletionProof(operation.proofId);
        if (!proof || proof.operationId !== operationId) throw new Error("remote_deletion_pending");
      }
      return Object.freeze({ operationId, proofId: operation.proofId, status: "already_deleted" });
    }

    if (DELETION_PHASE_ORDER[operation.phase] < DELETION_PHASE_ORDER.firestore_deleting) {
      const phase = await this.advanceDeletionPhase(ref, "sessions_revoking");
      if (DELETION_PHASE_ORDER[phase] <= DELETION_PHASE_ORDER.sessions_revoking) {
        try {
          await this.revokeDeletionSubjects(operation.authSubjects);
        } catch {
          await ref.set({ failureCode: "session_revocation_failed", updatedAt: now() }, { merge: true });
          throw new Error("session_revocation_failed");
        }
        await this.advanceDeletionPhase(ref, "firestore_deleting");
      }
    }

    operation = await this.readStoredDeletionOperation(ref);
    if (DELETION_PHASE_ORDER[operation.phase] < DELETION_PHASE_ORDER.auth_deleting) {
      const phase = await this.advanceDeletionPhase(ref, "firestore_deleting");
      if (phase === "firestore_deleting") {
        try {
          await this.deleteFirestoreOwnedData(userId, operation.identityRefs, operation.authSubjects);
        } catch {
          throw new Error("remote_deletion_pending");
        }
        await this.advanceDeletionPhase(ref, "auth_deleting");
      }
    }

    operation = await this.readStoredDeletionOperation(ref);
    if (DELETION_PHASE_ORDER[operation.phase] < DELETION_PHASE_ORDER.remote_deleted) {
      const phase = await this.advanceDeletionPhase(ref, "auth_deleting");
      if (phase === "auth_deleting") {
        try {
          await this.deleteAuthSubjects(operation.authSubjects);
        } catch {
          await ref.set({ failureCode: "auth_deletion_failed", updatedAt: now() }, { merge: true });
          throw new Error("remote_deletion_pending");
        }
        await this.advanceDeletionPhase(ref, "remote_deleted");
      }
    }

    operation = await this.readStoredDeletionOperation(ref);
    return Object.freeze({ operationId, proofId: operation.proofId, status: operation.phase === "remote_deleted" ? "remote_deleted" : "already_deleted" });
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
      const currentIdentityRefs = deletionIdentityReferences(currentData.identityRefs);
      if (!sameIdentityReferences(operation.identityRefs, currentIdentityRefs)) throw new Error("remote_deletion_pending");
      const requests = await transaction.get(this.db.collection(COLLECTIONS.deletionRequests).where("userId", "==", operation.userId));
      const tombstoneSnapshots = await transaction.getAll(...operation.identityRefs.map((identity) => this.db.collection(COLLECTIONS.deletedIdentities).doc(identity.identityId)));
      this.assertTombstoneSnapshots(operation.identityRefs, tombstoneSnapshots);
      transaction.set(ref, { status: "complete", phase: "complete", authSubjects: FieldValue.delete(), completedAt, updatedAt: completedAt }, { merge: true });
      transaction.set(this.db.collection(COLLECTIONS.deletionProofs).doc(proofId), { status: "deleted", operationId, proofId, completedAt }, { merge: true });
      for (const request of requests.docs) {
        // A completed public link keeps its original proof across independent deletions.
        if (asRecord(request.data(), "deletion_request").status === "complete") continue;
        transaction.set(request.ref, { status: "complete", operationId, proofId, completedAt, updatedAt: completedAt }, { merge: true });
      }
      for (const tombstone of tombstoneSnapshots) transaction.update(tombstone.ref, { subject: FieldValue.delete(), operationId: FieldValue.delete(), proofId: FieldValue.delete() });
    });
    return Object.freeze({ status: "deleted", operationId, proofId });
  }

  public async resumeDeletion(operationId: string, accountUidHash: string): Promise<DeletionOperationStatus | null> {
    const operation = await this.readBoundDeletionOperation(operationId, accountUidHash);
    if (!operation) return null;
    if (operation.phase === "complete") {
      const proof = await this.readDeletionProof(operation.proofId);
      if (!proof || proof.operationId !== operationId) return null;
      return Object.freeze({ status: "complete", operationId, proofId: operation.proofId });
    }
    try {
      const result = await this.deleteAccount(operation.userId, operationId);
      await this.completeDeletion(result.operationId, result.proofId);
    } catch (error) {
      if (!isTransientDeletionError(error)) throw error;
    }
    return this.readDeletionOperationStatus(operationId, accountUidHash);
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
    const created = await this.db.runTransaction(async (transaction) => {
      const user = await transaction.get(this.db.collection(COLLECTIONS.users).doc(userIds[0]!));
      if (!user.exists || asRecord(user.data(), "user").deletedAt !== undefined) return false;
      transaction.create(this.db.collection(COLLECTIONS.deletionRequests).doc(requestId), { requestId, emailHash: sha256(email), tokenHash: sha256(token), userId: userIds[0], operationId: null, status: "pending", expiresAt, createdAt: now() });
      return true;
    });
    if (!created) return Object.freeze({ requestId: null });
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
      if (data.status === "complete") {
        if (typeof data.operationId !== "string" || typeof data.proofId !== "string") throw new Error("deletion_request_invalid");
        const operationSnapshot = await transaction.get(operationRef(this.db, data.operationId));
        const proofSnapshot = await transaction.get(this.db.collection(COLLECTIONS.deletionProofs).doc(data.proofId));
        const operationData = operationSnapshot.exists ? asRecord(operationSnapshot.data(), "account_deletion_operation") : null;
        const proofData = proofSnapshot.exists ? asRecord(proofSnapshot.data(), "deletion_proof") : null;
        if (operationData === null || phaseFromData(operationData) !== "complete" || operationData.proofId !== data.proofId || proofData?.status !== "deleted" || proofData.operationId !== data.operationId) throw new Error("deletion_request_invalid");
        return Object.freeze({ status: "complete", operationId: data.operationId, proofId: data.proofId });
      }
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
    const operation = await operationRef(this.db, data.operationId).get();
    if (!operation.exists) return null;
    const operationData = asRecord(operation.data(), "account_deletion_operation");
    const phase = phaseFromData(operationData);
    if (phase !== "complete" || operationData.proofId !== proofId) return null;
    return Object.freeze({ status: "deleted", operationId: data.operationId, proofId });
  }

  public async readDeletionOperationStatus(operationId: string, accountUidHash: string): Promise<DeletionOperationStatus | null> {
    const snapshot = await operationRef(this.db, operationId).get();
    if (!snapshot.exists) return null;
    const data = asRecord(snapshot.data(), "account_deletion_operation");
    const subjectHashes = hashArray(data.subjectHashes);
    if (!subjectHashes.includes(accountUidHash)) return null;
    if (!["pending", "remote_deleting", "remote_deleted", "complete", "failed"].includes(String(data.status))) return null;
    const phase = phaseFromData(data);
    if (phase === null) return null;
    if (phase === "complete") {
      const proofId = typeof data.proofId === "string" ? data.proofId : null;
      if (proofId === null || !(await this.readDeletionProof(proofId))) return null;
      return Object.freeze({ status: "complete", operationId, proofId });
    }
    if (!this.persistedDeletionSet(data)) return null;
    return Object.freeze({ status: externalStatus(data, phase), operationId, proofId: typeof data.proofId === "string" ? data.proofId : null });
  }

  private async prepareDeletionOperation(userId: string, operationId: string): Promise<StoredDeletionOperation> {
    const ref = operationRef(this.db, operationId);
    await this.db.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      if (!current.exists) {
        const identities = await transaction.get(this.db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId));
        let authSubjects = this.firebaseSubjects(identities.docs);
        let identityRefs = this.deletionIdentityReferences(identities.docs);
        if (authSubjects.length === 0 || identityRefs.length === 0) {
          const activeOperations = await transaction.get(this.db.collection(COLLECTIONS.accountDeletionOperations).where("userId", "==", userId).limit(20));
          for (const document of activeOperations.docs) {
            const existing = this.persistedDeletionSet(asRecord(document.data(), "account_deletion_operation"));
            if (!existing) continue;
            authSubjects = existing.authSubjects;
            identityRefs = existing.identityRefs;
            break;
          }
        }
        if (authSubjects.length === 0 || identityRefs.length === 0) throw new Error("remote_deletion_pending");
        const createdAt = now();
        const proofId = `proof_${randomBytes(18).toString("base64url")}`;
        transaction.create(ref, {
          operationId,
          userId,
          status: "pending",
          phase: "prepared",
          proofId,
          authSubjects,
          subjectHashes: authSubjects.map(sha256),
          identityRefs,
          createdAt,
          updatedAt: createdAt,
        });
        return;
      }

      const data = asRecord(current.data(), "account_deletion_operation");
      if (data.userId !== userId) throw new Error("remote_deletion_pending");
      const phase = phaseFromData(data);
      if (phase === null) throw new Error("remote_deletion_pending");
      if (phase === "complete") return;
      const persisted = this.persistedDeletionSet(data);
      if (!persisted) throw new Error("remote_deletion_pending");
      const { authSubjects, subjectHashes, identityRefs } = persisted;
      if (typeof data.proofId !== "string" || data.proofId.length === 0) throw new Error("remote_deletion_pending");
      const updatedAt = now();
      transaction.set(ref, {
        status: statusForPhase(phase),
        phase,
        authSubjects,
        subjectHashes,
        identityRefs,
        updatedAt,
      }, { merge: true });
    });
    return this.readStoredDeletionOperation(ref);
  }

  private async readStoredDeletionOperation(ref: DocumentReference): Promise<StoredDeletionOperation> {
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new Error("remote_deletion_pending");
    const data = asRecord(snapshot.data(), "account_deletion_operation");
    if (typeof data.userId !== "string" || typeof data.proofId !== "string") throw new Error("remote_deletion_pending");
    const phase = phaseFromData(data);
    if (phase === null) throw new Error("remote_deletion_pending");
    const persisted = phase === "complete" ? null : this.persistedDeletionSet(data);
    if (phase !== "complete" && !persisted) throw new Error("remote_deletion_pending");
    const authSubjects = persisted?.authSubjects ?? stringArray(data.authSubjects);
    const subjectHashes = persisted?.subjectHashes ?? hashArray(data.subjectHashes);
    const identityRefs = persisted?.identityRefs ?? deletionIdentityReferences(data.identityRefs);
    return Object.freeze({
      operationId: ref.id,
      userId: data.userId,
      proofId: data.proofId,
      status: typeof data.status === "string" ? data.status : statusForPhase(phase),
      phase,
      authSubjects,
      subjectHashes,
      identityRefs,
    });
  }

  private async readBoundDeletionOperation(operationId: string, accountUidHash: string): Promise<StoredDeletionOperation | null> {
    const ref = operationRef(this.db, operationId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return null;
    const data = asRecord(snapshot.data(), "account_deletion_operation");
    const subjectHashes = hashArray(data.subjectHashes);
    if (!subjectHashes.includes(accountUidHash)) return null;
    if (typeof data.userId !== "string" || typeof data.proofId !== "string") return null;
    const phase = phaseFromData(data);
    if (phase === null) return null;
    const persisted = phase === "complete" ? null : this.persistedDeletionSet(data);
    if (phase !== "complete" && !persisted) return null;
    const authSubjects = persisted?.authSubjects ?? stringArray(data.authSubjects);
    const identityRefs = persisted?.identityRefs ?? deletionIdentityReferences(data.identityRefs);
    return Object.freeze({
      operationId,
      userId: data.userId,
      proofId: data.proofId,
      status: typeof data.status === "string" ? data.status : statusForPhase(phase),
      phase,
      authSubjects,
      subjectHashes,
      identityRefs,
    });
  }

  private async advanceDeletionPhase(ref: DocumentReference, target: DeletionPhase): Promise<DeletionPhase> {
    let result: DeletionPhase = target;
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("remote_deletion_pending");
      const data = asRecord(snapshot.data(), "account_deletion_operation");
      const current = phaseFromData(data);
      if (current === null) throw new Error("remote_deletion_pending");
      if (DELETION_PHASE_ORDER[current] > DELETION_PHASE_ORDER[target]) {
        result = current;
        return;
      }
      result = target;
      const updatedAt = now();
      transaction.set(ref, {
        phase: target,
        status: statusForPhase(target),
        updatedAt,
        ...(target === "remote_deleted" ? { remoteDeletedAt: updatedAt, authDeletedAt: updatedAt } : {}),
      }, { merge: true });
    });
    return result;
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
      const identityId = identityDocumentId(identity.provider, identity.subject);
      if (seen.has(identityId)) continue;
      seen.add(identityId);
      references.push(Object.freeze({ identityId, provider: identity.provider, subjectHash: sha256(identity.subject) }));
    }
    return Object.freeze(references);
  }

  private firebaseIdentityReferences(subjects: readonly string[]): readonly StoredDeletionIdentity[] {
    return Object.freeze(subjects.map((subject) => Object.freeze({ identityId: identityDocumentId("firebase", subject), provider: "firebase", subjectHash: sha256(subject) })));
  }

  private identityReferencesContainSubjects(references: readonly StoredDeletionIdentity[], subjects: readonly string[]): boolean {
    return subjects.every((subject) => {
      const subjectHash = sha256(subject);
      return references.some((reference) => reference.provider === "firebase" && reference.subjectHash === subjectHash && reference.identityId === identityDocumentId("firebase", subject));
    });
  }

  private persistedDeletionSet(data: Record<string, unknown>): Readonly<{ authSubjects: readonly string[]; subjectHashes: readonly string[]; identityRefs: readonly StoredDeletionIdentity[] }> | null {
    const phase = phaseFromData(data);
    if (phase === null || phase === "complete") return null;
    const authSubjects = stringArray(data.authSubjects);
    const subjectHashes = hashArray(data.subjectHashes);
    if (authSubjects.length === 0 || subjectHashes.length !== authSubjects.length || authSubjects.some((subject) => !subjectHashes.includes(sha256(subject)))) return null;
    const parsedRefs = deletionIdentityReferences(data.identityRefs);
    const identityRefs = parsedRefs.length > 0 ? parsedRefs : this.firebaseIdentityReferences(authSubjects);
    if (identityRefs.length === 0 || !this.identityReferencesContainSubjects(identityRefs, authSubjects)) return null;
    return Object.freeze({ authSubjects, subjectHashes, identityRefs });
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

  private async deleteFirestoreOwnedData(userId: string, identityRefs: readonly StoredDeletionIdentity[], authSubjects: readonly string[]): Promise<void> {
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    await this.db.runTransaction(async (transaction) => {
      const user = await transaction.get(userRef);
      const mappings = await transaction.get(this.db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId));
      const currentIdentities = this.deletionIdentityReferences(mappings.docs);
      const expectedById = new Map(identityRefs.map((identity) => [identity.identityId, identity]));
      if (currentIdentities.some((identity) => {
        const expected = expectedById.get(identity.identityId);
        return expected?.provider !== identity.provider || expected.subjectHash !== identity.subjectHash;
      })) throw new Error("remote_deletion_pending");
      const tombstoneRefs = identityRefs.map((identity) => this.db.collection(COLLECTIONS.deletedIdentities).doc(identity.identityId));
      const tombstones = await transaction.getAll(...tombstoneRefs);
      const rawSubjectsByHash = new Map(authSubjects.map((subject) => [sha256(subject), subject]));
      const deletedAt = now();
      for (let index = 0; index < identityRefs.length; index += 1) {
        const identity = identityRefs[index];
        const tombstone = tombstones[index];
        if (!identity || !tombstone) throw new Error("remote_deletion_pending");
        const rawSubject = identity.provider === "firebase" ? rawSubjectsByHash.get(identity.subjectHash) : undefined;
        transaction.set(tombstone.ref, this.tombstoneWrite(identity, tombstone, rawSubject, deletedAt), { merge: true });
      }
      for (const mapping of mappings.docs) transaction.delete(mapping.ref);
      if (mappings.docs.some((mapping) => {
        const data = asRecord(mapping.data(), "identity_mapping");
        return typeof data.provider !== "string" || typeof data.subject !== "string" || data.subject.length === 0;
      })) throw new Error("remote_deletion_pending");
      if (user.exists) transaction.set(userRef, { deletedAt, updatedAt: deletedAt }, { merge: true });
    });

    const recoveryCodes = await this.db.collection(COLLECTIONS.recoveryCodeIndex).where("userId", "==", userId).get();
    await this.deleteDocuments(recoveryCodes.docs.map((document) => document.ref));
    const sessionRevocations = await this.db.collection(COLLECTIONS.sessionRevocationOperations).where("userId", "==", userId).get();
    await this.deleteDocuments(sessionRevocations.docs.map((document) => document.ref));
    await this.unlinkOwnedReports(userId);
    await this.db.recursiveDelete(userRef);
    await this.assertFirestoreDeletionComplete(userId, identityRefs);
  }

  private tombstoneWrite(identity: StoredDeletionIdentity, snapshot: { exists: boolean; data: () => unknown }, rawSubject: string | undefined, deletedAt: Timestamp): Record<string, unknown> {
    const existing = snapshot.exists ? asRecord(snapshot.data(), "deleted_identity") : null;
    if (existing !== null) {
      if (existing.provider !== identity.provider) throw new Error("remote_deletion_pending");
      if (existing.subjectHash !== identity.subjectHash) throw new Error("remote_deletion_pending");
      if (existing.subject !== undefined && (typeof existing.subject !== "string" || sha256(existing.subject) !== identity.subjectHash)) throw new Error("remote_deletion_pending");
    }
    const existingDeletedAt = existing?.deletedAt instanceof Timestamp || existing?.deletedAt instanceof Date ? existing.deletedAt : deletedAt;
    const existingSubject = existing?.subject;
    const mutableLinkage = existing !== null && ("operationId" in existing || "proofId" in existing) ? { operationId: FieldValue.delete(), proofId: FieldValue.delete() } : {};
    return {
      provider: identity.provider,
      subjectHash: identity.subjectHash,
      deletedAt: existingDeletedAt,
      ...(typeof existingSubject === "string" ? { subject: existingSubject } : existing === null && rawSubject !== undefined ? { subject: rawSubject } : {}),
      ...mutableLinkage,
    };
  }

  private assertTombstoneSnapshots(identityRefs: readonly StoredDeletionIdentity[], tombstones: readonly { id: string; exists: boolean; data: () => unknown }[]): void {
    if (identityRefs.length === 0 || tombstones.length !== identityRefs.length) throw new Error("remote_deletion_pending");
    for (let index = 0; index < identityRefs.length; index += 1) {
      const identity = identityRefs[index];
      const tombstone = tombstones[index];
      if (!identity || !tombstone || tombstone.id !== identity.identityId || !tombstone.exists) throw new Error("remote_deletion_pending");
      const data = asRecord(tombstone.data(), "deleted_identity");
      if (data.provider !== identity.provider || data.subjectHash !== identity.subjectHash) throw new Error("remote_deletion_pending");
      if (data.subject !== undefined && (typeof data.subject !== "string" || sha256(data.subject) !== identity.subjectHash)) throw new Error("remote_deletion_pending");
    }
  }

  private async deleteDocuments(refs: readonly DocumentReference[]): Promise<void> {
    const batchSize = 450;
    for (let offset = 0; offset < refs.length; offset += batchSize) {
      const batch = this.db.batch();
      for (const ref of refs.slice(offset, offset + batchSize)) batch.delete(ref);
      await batch.commit();
    }
  }

  private async unlinkOwnedReports(userId: string): Promise<void> {
    const reports = await this.db.collection(COLLECTIONS.contentReports).where("accountId", "==", userId).get();
    const batchSize = 450;
    for (let offset = 0; offset < reports.docs.length; offset += batchSize) {
      const batch = this.db.batch();
      const updatedAt = now();
      for (const report of reports.docs.slice(offset, offset + batchSize)) batch.update(report.ref, { accountId: FieldValue.delete(), contactEmail: FieldValue.delete(), updatedAt });
      await batch.commit();
    }
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
    const [user, mappings, recoveryCodes, sessionRevocations, linkedReports] = await Promise.all([
      userRef.get(),
      this.db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId).get(),
      this.db.collection(COLLECTIONS.recoveryCodeIndex).where("userId", "==", userId).get(),
      this.db.collection(COLLECTIONS.sessionRevocationOperations).where("userId", "==", userId).get(),
      this.db.collection(COLLECTIONS.contentReports).where("accountId", "==", userId).get(),
    ]);
    if (user.exists || !mappings.empty || !recoveryCodes.empty || !sessionRevocations.empty || !linkedReports.empty) throw new Error("remote_deletion_pending");
    const childCollections = await userRef.listCollections();
    const childDocuments = await Promise.all(childCollections.map((collection) => collection.limit(1).get()));
    if (childDocuments.some((documents) => !documents.empty)) throw new Error("remote_deletion_pending");
    const tombstones = await this.db.getAll(...identityRefs.map((identity) => this.db.collection(COLLECTIONS.deletedIdentities).doc(identity.identityId)));
    this.assertTombstoneSnapshots(identityRefs, tombstones);
  }
}
