import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Firestore, DocumentReference } from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { COLLECTIONS } from "../../infrastructure/firestore/paths.js";
import type { FirebaseAdminAuth } from "../../infrastructure/firebase/adminAuth.js";
import { asRecord, asTimestamp, now } from "../../infrastructure/firestore/values.js";
import type {
  AccountDeletionResult,
  CompletedDeletion,
} from "./contracts.js";
import type { PseudonymKeyRing } from "../../infrastructure/security/pseudonymKeyRing.js";
import { ACCOUNT_DELETION_TOMBSTONE_RETENTION_MS, LEGACY_ACCOUNT_DELETION_TOMBSTONE_RETENTION_MS, assertFirestoreAccountErasureComplete, deletedIdentityLogicalExpiryMs, eraseFirestoreAccountData } from "./firestoreAccountErasure.js";
import { assertExpectedAuthorizationGeneration, storedAuthorizationGeneration } from "../auth/authorizationGeneration.js";
import { RETENTION_POLICY } from "../retention/policy.js";
import { addUtcCalendarMonths } from "../../infrastructure/time/utcCalendar.js";

import type { RevenueCatCustomerDeletionClient } from "../../infrastructure/revenuecat/customerDeletion.js";

export type RevenueCatDeletionRuntime = Readonly<{ projectId: string; client: RevenueCatCustomerDeletionClient | null }>;
type RevenueCatDeletionCheckpoint = Readonly<{ projectId: string; status: "pending" | "accepted" | "absent" }>;

function revenueCatDeletionCheckpoint(data: Record<string, unknown>): RevenueCatDeletionCheckpoint | null {
  const value = data.revenueCatDeletion;
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("remote_deletion_pending");
  const checkpoint = value as Record<string, unknown>;
  if (Object.keys(checkpoint).sort().join(",") !== "projectId,status"
    || typeof checkpoint.projectId !== "string" || !/^proj[A-Za-z0-9]+$/u.test(checkpoint.projectId)
    || !["pending", "accepted", "absent"].includes(String(checkpoint.status))) throw new Error("remote_deletion_pending");
  return Object.freeze({ projectId: checkpoint.projectId, status: checkpoint.status as RevenueCatDeletionCheckpoint["status"] });
}

const SECURITY_OPERATION_LEASE_MS = 2 * 60 * 1000;
const SESSION_REVOCATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_REVOCATION_FIRST_USE_MS = 29 * 24 * 60 * 60 * 1000;
const SESSION_REVOCATION_FUTURE_SKEW_MS = 5 * 60 * 1000;
const SESSION_REVOCATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type SessionRevocationResult = Readonly<{ status: "revoked"; operationId: string; customToken: string }>;
type DeletionProof = Readonly<{ status: "deleted"; operationId: string; proofId: string }>;
type DeletionOperationStatus = Readonly<{ status: "pending" | "remote_deleted" | "complete"; operationId: string; proofId: string | null }>;
type DeletionPhase = "prepared" | "sessions_revoking" | "firestore_deleting" | "auth_deleting" | "revenuecat_deleting" | "remote_deleted" | "complete";
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
  revenueCatDeletion: RevenueCatDeletionCheckpoint | null;
  firestoreErasureCheckpoint: Readonly<{ deletedAt: Timestamp | Date; expiresAt: Timestamp | Date }> | null;
}>;

const DELETION_PHASES: readonly DeletionPhase[] = Object.freeze(["prepared", "sessions_revoking", "auth_deleting", "revenuecat_deleting", "firestore_deleting", "remote_deleted", "complete"]);

export interface AccountLifecycleStore {
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

function isExpiredIdentityTombstone(value: unknown, expected: Readonly<{ documentId: string; keyVersion: string; subjectHmac: string }>): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (data.provider !== "firebase" || data.keyVersion !== expected.keyVersion || data.subjectHmac !== expected.subjectHmac
    || `${data.keyVersion}_${data.subjectHmac}` !== expected.documentId) return false;
  return (deletedIdentityLogicalExpiryMs(data) ?? Number.POSITIVE_INFINITY) <= Date.now();
}

function deletionLogicalExpiry(data: Record<string, unknown>, expiryField: string): number {
  const storedExpiry = asTimestamp(data.expiresAt, expiryField).toMillis();
  const completedAt = data.completedAt;
  if (!(completedAt instanceof Timestamp || completedAt instanceof Date)) return storedExpiry;
  const policyExpiry = addUtcCalendarMonths(asTimestamp(completedAt, "deletion_completed_at").toDate(), RETENTION_POLICY.accountDeletionProofMonths).getTime();
  return Math.min(storedExpiry, policyExpiry);
}

function operationRef(db: Firestore, operationId: string): DocumentReference {
  return db.collection(COLLECTIONS.accountDeletionOperations).doc(operationId);
}

function recoveryOperationRef(db: Firestore, operationId: string): DocumentReference {
  return db.collection(COLLECTIONS.accountRecoveryOperations).doc(operationId);
}

function recoveryOperationResultRef(db: Firestore, operationId: string): DocumentReference {
  return db.collection(COLLECTIONS.accountRecoveryOperationResults).doc(operationId);
}

function timestampMillis(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : value instanceof Date ? value.getTime() : Number.NEGATIVE_INFINITY;
}

// Only this lifecycle writer owns these records. Legacy revoked.updatedAt was
// written once at finalization (not on mint retry); unknown shapes cannot backfill.
function validateSessionRevocation(data: Record<string, unknown>, operationId: string, userId: string, generation: number, nowMs: number) {
  if (data.userId !== userId || data.expectedAuthorizationGeneration !== generation) throw new Error("session_revocation_operation_conflict");
  const allowed = ["operationId", "userId", "expectedAuthorizationGeneration", "status", "updatedAt", "failureCode", "terminalAt", "expiresAt"];
  const updatedAtMs = timestampMillis(data.updatedAt);
  if (data.operationId !== operationId || Object.keys(data).some((key) => !allowed.includes(key))
    || !Number.isFinite(updatedAtMs) || updatedAtMs < 0 || updatedAtMs > nowMs
    || !["pending", "failed", "revoked"].includes(String(data.status))) throw new Error("session_revocation_operation_invalid");
  if (data.status !== "revoked") {
    if ("terminalAt" in data || "expiresAt" in data
      || (data.status === "pending" && "failureCode" in data)
      || (data.status === "failed" && data.failureCode !== "session_revocation_failed")) throw new Error("session_revocation_operation_invalid");
    return null;
  }
  if ("failureCode" in data) throw new Error("session_revocation_operation_invalid");
  const legacy = !("terminalAt" in data) && !("expiresAt" in data);
  const terminalAt = legacy ? asTimestamp(data.updatedAt, "session_revocation") : data.terminalAt;
  const terminalMs = timestampMillis(terminalAt);
  const expiresAt = legacy ? Timestamp.fromMillis(terminalMs + SESSION_REVOCATION_RETENTION_MS) : data.expiresAt;
  const expiryMs = timestampMillis(expiresAt);
  if (!Number.isFinite(terminalMs) || terminalMs < 0 || terminalMs > nowMs
    || updatedAtMs !== terminalMs || expiryMs !== terminalMs + SESSION_REVOCATION_RETENTION_MS) throw new Error("session_revocation_operation_invalid");
  return { terminalAt: asTimestamp(terminalAt, "session_revocation"), expiresAt: asTimestamp(expiresAt, "session_revocation"), legacy };
}

function assertSessionRevocationFirstUse(operationId: string, nowMs: number): void {
  const issuedAt = Number.parseInt(operationId.replaceAll("-", "").slice(0, 12), 16);
  if (operationId[14] !== "7" || issuedAt < nowMs - SESSION_REVOCATION_FIRST_USE_MS
    || issuedAt > nowMs + SESSION_REVOCATION_FUTURE_SKEW_MS) throw new Error("session_revocation_operation_expired");
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

function deletionErasureCheckpoint(data: Record<string, unknown>): StoredDeletionOperation["firestoreErasureCheckpoint"] {
  const hasDeletedAt = Object.hasOwn(data, "firestoreErasureDeletedAt");
  const hasExpiresAt = Object.hasOwn(data, "firestoreErasureExpiresAt");
  if (!hasDeletedAt && !hasExpiresAt) return null;
  const deletedAt = data.firestoreErasureDeletedAt;
  const expiresAt = data.firestoreErasureExpiresAt;
  if (!(deletedAt instanceof Timestamp || deletedAt instanceof Date) || !(expiresAt instanceof Timestamp || expiresAt instanceof Date)) throw new Error("remote_deletion_pending");
  const logicalExpiry = deletedIdentityLogicalExpiryMs({
    provider: "firebase",
    keyVersion: "checkpoint",
    subjectHmac: "0".repeat(64),
    deletedAt,
    expiresAt,
  });
  if (logicalExpiry === null) throw new Error("remote_deletion_pending");
  return Object.freeze({ deletedAt, expiresAt });
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
  if (phase === "firestore_deleting" || phase === "auth_deleting" || phase === "revenuecat_deleting") return "remote_deleting";
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
  public constructor(
    private readonly db: Firestore,
    private readonly auth: FirebaseAdminAuth,
    private readonly pseudonymKeyRing: PseudonymKeyRing,
    private readonly revenueCatRuntime: RevenueCatDeletionRuntime | null = null,
  ) {}

  /** Retire an old Recovery Codes operation when revoke/delete takes ownership of its user slot. */
  private legacyRecoveryTerminalFields(terminalAt = now()): Readonly<{ status: "superseded"; terminalAt: Timestamp; updatedAt: Timestamp; expiresAt: Timestamp }> {
    return Object.freeze({
      status: "superseded",
      terminalAt,
      updatedAt: terminalAt,
      expiresAt: Timestamp.fromMillis(terminalAt.toMillis() + 30 * 24 * 60 * 60 * 1000),
    });
  }

  public async revokeSessions(userId: string, expectedAuthorizationGeneration: number, operationId: string): Promise<SessionRevocationResult> {
    if (!SESSION_REVOCATION_ID_PATTERN.test(operationId)) throw new Error("session_revocation_operation_invalid");
    const userRef = this.db.collection(COLLECTIONS.users).doc(userId);
    const operationRef = this.db.collection(COLLECTIONS.sessionRevocationOperations).doc(operationId);
    const fence = randomUUID();
    const claim = await this.db.runTransaction(async (transaction) => {
      const user = await transaction.get(userRef);
      const operation = await transaction.get(operationRef);
      if (!user.exists) throw new Error("account_deleted");
      const userData = asRecord(user.data(), "user");
      assertExpectedAuthorizationGeneration(userData, expectedAuthorizationGeneration);
      if (expectedAuthorizationGeneration >= Number.MAX_SAFE_INTEGER) throw new Error("authorization_generation_invalid");

      const claimedAt = now();
      const leaseUntil = Timestamp.fromMillis(claimedAt.toMillis() + SECURITY_OPERATION_LEASE_MS);
      if (operation.exists) {
        const terminal = validateSessionRevocation(asRecord(operation.data(), "session_revocation"), operationId, userId, expectedAuthorizationGeneration, claimedAt.toMillis());
        if (terminal) {
          // Persist the original legacy deadline even when already expired; never
          // restart retention from the migration/retry date.
          if (terminal.legacy) transaction.update(operationRef, { terminalAt: terminal.terminalAt, expiresAt: terminal.expiresAt });
          if (terminal.expiresAt.toMillis() <= claimedAt.toMillis()) return Object.freeze({ kind: "expired" as const });
          return Object.freeze({ kind: "complete" as const });
        }
      } else {
        assertSessionRevocationFirstUse(operationId, claimedAt.toMillis());
      }

      const currentSlot = userData.securityOperation;
      let expiredRecoveryOperation: FirebaseFirestore.DocumentSnapshot | null = null;
      let expiredRecoveryResult: FirebaseFirestore.DocumentSnapshot | null = null;
      let expiredRecoveryOperationRef: DocumentReference | null = null;
      let expiredRecoveryResultRef: DocumentReference | null = null;
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
        if (slot.kind === "account_recovery" || slot.kind === "recovery_reissue") {
          if (slot.expectedAuthorizationGeneration !== expectedAuthorizationGeneration) throw new Error("session_revocation_operation_conflict");
          expiredRecoveryOperationRef = recoveryOperationRef(this.db, slot.operationId);
          expiredRecoveryResultRef = recoveryOperationResultRef(this.db, slot.operationId);
          const recoverySnapshots = await transaction.getAll(expiredRecoveryOperationRef, expiredRecoveryResultRef);
          expiredRecoveryOperation = recoverySnapshots[0] ?? null;
          expiredRecoveryResult = recoverySnapshots[1] ?? null;
          if (!expiredRecoveryOperation?.exists) throw new Error("security_operation_conflict");
          const prior = asRecord(expiredRecoveryOperation.data(), "recovery_operation");
          const deadline = Math.min(
            timestampMillis(prior.resultExpiresAt),
            timestampMillis(slot.leaseUntil),
            slot.kind === "recovery_reissue" ? timestampMillis(prior.retryDeadline) : Number.POSITIVE_INFINITY,
            expiredRecoveryResult?.exists ? timestampMillis(asRecord(expiredRecoveryResult.data(), "recovery_operation_result").expiresAt) : Number.POSITIVE_INFINITY,
          );
          if (prior.userId !== userId || (prior.kind !== "recovery" && prior.kind !== "reissue") || deadline > claimedAt.toMillis()) {
            throw new Error("session_revocation_operation_conflict");
          }
        } else if (slot.kind !== "session_revoke") {
          throw new Error("session_revocation_operation_conflict");
        }
      }

      const identities = await transaction.get(this.db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId));
      const subjects = [...new Set(identities.docs
        .map((document) => asRecord(document.data(), "identity_mapping"))
        .filter((identity) => identity.provider === "firebase" && typeof identity.subject === "string")
        .map((identity) => identity.subject as string))];
      if (subjects.length !== 1) throw new Error("session_revocation_identity_unavailable");
      if (expiredRecoveryOperation?.exists && expiredRecoveryOperationRef && expiredRecoveryResultRef) {
        transaction.set(expiredRecoveryOperationRef, {
          ...this.legacyRecoveryTerminalFields(),
        }, { merge: true });
        if (expiredRecoveryResult?.exists) transaction.delete(expiredRecoveryResultRef);
      }
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
    const assertMintAllowed = async (): Promise<void> => this.db.runTransaction(async (transaction) => {
      const [user, operation] = await transaction.getAll(userRef, operationRef);
      if (!user?.exists) throw new Error("account_deleted");
      assertExpectedAuthorizationGeneration(asRecord(user.data(), "user"), expectedAuthorizationGeneration);
      if (!operation?.exists) throw new Error("session_revocation_operation_expired");
      const checkedAt = now().toMillis();
      const terminal = validateSessionRevocation(asRecord(operation.data(), "session_revocation"), operationId, userId, expectedAuthorizationGeneration, checkedAt);
      if (!terminal || terminal.legacy) throw new Error("session_revocation_operation_invalid");
      if (terminal.expiresAt.toMillis() <= checkedAt) throw new Error("session_revocation_operation_expired");
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
      await assertMintAllowed();
      let customToken: string;
      try {
        customToken = await this.auth.createCustomToken(subject, { authorizationGeneration: expectedAuthorizationGeneration });
      } catch {
        throw new Error("session_reissue_failed");
      }
      // A delete, generation change or expiry during provider work must not
      // return the token to the caller.
      await assertMintAllowed();
      return Object.freeze({ status: "revoked", operationId, customToken });
    };

    if (claim.kind === "expired") throw new Error("session_revocation_operation_expired");
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
      transaction.set(operationRef, { status, updatedAt, ...(status === "failed" ? { failureCode: "session_revocation_failed" } : {
        terminalAt: updatedAt,
        expiresAt: Timestamp.fromMillis(updatedAt.toMillis() + SESSION_REVOCATION_RETENTION_MS),
        failureCode: FieldValue.delete(),
      }) }, { merge: true });
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
    if (!operation.userId || !operation.revenueCatDeletion || operation.revenueCatDeletion.status === "pending") throw new Error("remote_deletion_pending");
    try {
      await this.assertFirestoreDeletionComplete(operation.userId, operation.identityRefs, operation.firestoreErasureCheckpoint ?? undefined);
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
      const providerCheckpoint = revenueCatDeletionCheckpoint(currentData);
      if (!providerCheckpoint || JSON.stringify(providerCheckpoint) !== JSON.stringify(operation.revenueCatDeletion)
        || providerCheckpoint.status === "pending") throw new Error("remote_deletion_pending");
      const currentIdentityRefs = deletionIdentityReferences(currentData.identityRefs);
      if (!sameIdentityReferences(operation.identityRefs, currentIdentityRefs)) throw new Error("remote_deletion_pending");
      const tombstoneSnapshots = await transaction.getAll(...operation.identityRefs.map((identity) => this.db.collection(COLLECTIONS.deletedIdentities).doc(identity.identityId)));
      const checkpoint = deletionErasureCheckpoint(currentData);
      if (checkpoint && operation.firestoreErasureCheckpoint
        && (asTimestamp(checkpoint.deletedAt, "deletion_checkpoint").toMillis() !== asTimestamp(operation.firestoreErasureCheckpoint.deletedAt, "deletion_checkpoint").toMillis()
          || asTimestamp(checkpoint.expiresAt, "deletion_checkpoint").toMillis() !== asTimestamp(operation.firestoreErasureCheckpoint.expiresAt, "deletion_checkpoint").toMillis())) throw new Error("remote_deletion_pending");
      this.assertTombstoneSnapshots(operation.identityRefs, tombstoneSnapshots, checkpoint ?? undefined);
      const expiresAt = Timestamp.fromDate(addUtcCalendarMonths(completedAt.toDate(), RETENTION_POLICY.accountDeletionProofMonths));
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
    if (!(data.expiresAt instanceof Timestamp || data.expiresAt instanceof Date) || deletionLogicalExpiry(data, "deletion_proof_expiry") <= Date.now()) {
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
    if (phase === "complete" && (!(data.expiresAt instanceof Timestamp || data.expiresAt instanceof Date) || deletionLogicalExpiry(data, "account_deletion_operation_expiry") <= Date.now())) {
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
          operation = await this.advanceDeletionPhase(ref, operation, fence, "revenuecat_deleting");
          continue;
        }
        if (operation.phase === "revenuecat_deleting") {
          try {
            const checkpoint = operation.revenueCatDeletion;
            const runtime = this.revenueCatRuntime;
            if (!checkpoint) throw new Error("revenuecat_deletion_configuration");
            if (checkpoint.status === "pending") {
              if (!runtime || checkpoint.projectId !== runtime.projectId
                || !runtime.client || runtime.client.projectId !== checkpoint.projectId) throw new Error("revenuecat_deletion_configuration");
              // The authorized backend account ID is the AppUserID used by APP.
              // Never substitute a Firebase UID, email, or current client SDK ID.
              const result = await runtime.client.deleteCustomer(userId, () => this.db.runTransaction(async (transaction) => {
                await this.assertDeletionOwnerInTransaction(transaction, operation, fence, "revenuecat_deleting");
              }));
              if (result.status !== "accepted" && result.status !== "absent") throw new Error("revenuecat_deletion_response");
              await this.db.runTransaction(async (transaction) => {
                await this.assertDeletionOwnerInTransaction(transaction, operation, fence, "revenuecat_deleting");
                const current = await transaction.get(ref);
                const currentCheckpoint = revenueCatDeletionCheckpoint(asRecord(current.data(), "account_deletion_operation"));
                if (currentCheckpoint?.projectId !== checkpoint.projectId || currentCheckpoint.status !== "pending") throw new Error("account_deletion_conflict");
                transaction.update(ref, { revenueCatDeletion: { projectId: checkpoint.projectId, status: result.status }, revenueCatDeletionRecordedAt: now() });
              });
            }
          } catch (error) {
            const code = error instanceof Error && error.message === "revenuecat_deletion_configuration"
              ? "revenuecat_deletion_configuration" : "revenuecat_deletion_failed";
            await this.releaseDeletionLease(ref, operation, fence, code).catch(() => undefined);
            throw new Error("remote_deletion_pending");
          }
          operation = await this.advanceDeletionPhase(ref, operation, fence, "firestore_deleting");
          continue;
        }
        if (operation.phase === "firestore_deleting") {
          // Unbound legacy operations cannot acquire a new provider target on retry.
          if (!operation.revenueCatDeletion || operation.revenueCatDeletion.status === "pending") {
            await this.releaseDeletionLease(ref, operation, fence, "revenuecat_deletion_unbound");
            throw new Error("remote_deletion_pending");
          }
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
    const projectId = this.revenueCatRuntime?.projectId;
    if (!projectId || !/^proj[A-Za-z0-9]+$/u.test(projectId)) throw new Error("remote_deletion_pending");
    await this.db.runTransaction(async (transaction) => {
      const user = await transaction.get(userRef);
      const current = await transaction.get(ref);
      if (!user.exists) throw new Error("account_deleted");
      if (current.exists) throw new Error("account_deletion_conflict");
      const userData = asRecord(user.data(), "user");
      assertExpectedAuthorizationGeneration(userData, expectedAuthorizationGeneration);
      if (userData.deletedAt !== undefined || (userData.authorizationState !== undefined && userData.authorizationState !== "active")) throw new Error("account_deleted");
      const currentSlot = userData.securityOperation;
      let recoverySlotOperation: FirebaseFirestore.DocumentSnapshot | null = null;
      let recoverySlotResult: FirebaseFirestore.DocumentSnapshot | null = null;
      let recoverySlotOperationRef: DocumentReference | null = null;
      let recoverySlotResultRef: DocumentReference | null = null;
      if (currentSlot !== undefined) {
        if (typeof currentSlot !== "object" || currentSlot === null || Array.isArray(currentSlot)) throw new Error("security_operation_conflict");
        const slot = currentSlot as Record<string, unknown>;
        const slotLease = slot.leaseUntil instanceof Timestamp || slot.leaseUntil instanceof Date;
        if (slot.kind === "session_revoke" && slot.expectedAuthorizationGeneration === expectedAuthorizationGeneration && typeof slot.operationId === "string" && typeof slot.fence === "string" && slotLease) {
          // Account deletion advances the generation and atomically replaces a session-revoke owner.
        } else if ((slot.kind === "account_recovery" || slot.kind === "recovery_reissue")
          && slot.expectedAuthorizationGeneration === expectedAuthorizationGeneration && typeof slot.operationId === "string" && typeof slot.fence === "string" && slotLease) {
          recoverySlotOperationRef = recoveryOperationRef(this.db, slot.operationId);
          recoverySlotResultRef = recoveryOperationResultRef(this.db, slot.operationId);
          const recoverySnapshots = await transaction.getAll(recoverySlotOperationRef, recoverySlotResultRef);
          recoverySlotOperation = recoverySnapshots[0] ?? null;
          recoverySlotResult = recoverySnapshots[1] ?? null;
          if (!recoverySlotOperation?.exists) throw new Error("security_operation_conflict");
          const recoveryData = asRecord(recoverySlotOperation.data(), "recovery_operation");
          if (recoveryData.userId !== userId || recoveryData.fence !== slot.fence
            || (slot.kind === "account_recovery" && recoveryData.kind !== "recovery")
            || (slot.kind === "recovery_reissue" && recoveryData.kind !== "reissue")) throw new Error("security_operation_conflict");
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
      if (recoverySlotOperation?.exists && recoverySlotOperationRef && recoverySlotResultRef) {
        transaction.set(recoverySlotOperationRef, {
          ...this.legacyRecoveryTerminalFields(),
        }, { merge: true });
        if (recoverySlotResult?.exists) transaction.delete(recoverySlotResultRef);
      }
      transaction.create(ref, {
        operationId,
        userId,
        status: "pending",
        phase: "sessions_revoking",
        revenueCatDeletion: { projectId, status: "pending" },
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
      revenueCatDeletion: revenueCatDeletionCheckpoint(data),
      firestoreErasureCheckpoint: deletionErasureCheckpoint(data),
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
      revenueCatDeletion: revenueCatDeletionCheckpoint(data),
      firestoreErasureCheckpoint: deletionErasureCheckpoint(data),
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
        ...(target === "revenuecat_deleting" ? { authDeletedAt: advancedAt } : {}),
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
    let committedCheckpoint = operation.firestoreErasureCheckpoint;
    await eraseFirestoreAccountData({
      db: this.db,
      userId,
      identityRefs,
      assertWriteAllowed: (transaction) => this.assertDeletionOwnerInTransaction(transaction, operation, fence, "firestore_deleting"),
      verifyMapping: (provider, subject, expected) => provider === expected.provider && this.pseudonymKeyRing.verify(provider, subject, expected),
      assertUserDeletionOwner: (data) => { if (!this.userOwnsDeletion(data, operation, fence)) throw new Error("account_deletion_conflict"); },
      tombstoneWrite: (identity, snapshot, deletedAt) => ({ provider: identity.provider, keyVersion: identity.keyVersion, subjectHmac: identity.subjectHmac, deletedAt, expiresAt: Timestamp.fromMillis(deletedAt.toMillis() + ACCOUNT_DELETION_TOMBSTONE_RETENTION_MS) }),
      prepareTombstones: async (transaction, identities, existing, userExists, proposedDeletedAt) => {
        const ref = operationRef(this.db, operation.operationId);
        const operationSnapshot = await transaction.get(ref);
        if (!operationSnapshot.exists) throw new Error("account_deletion_conflict");
        const operationData = asRecord(operationSnapshot.data(), "account_deletion_operation");
        const checkpoint = deletionErasureCheckpoint(operationData);
        const markerDetails = existing.map((snapshot, index) => {
          const identity = identities[index];
          if (!identity || !snapshot || !snapshot.exists) return null;
          const data = asRecord(snapshot.data(), "deleted_identity");
          if (snapshot.id !== identity.identityId || data.provider !== identity.provider || data.keyVersion !== identity.keyVersion || data.subjectHmac !== identity.subjectHmac) throw new Error("remote_deletion_pending");
          const logicalExpiry = deletedIdentityLogicalExpiryMs(data);
          if (logicalExpiry === null || !(data.deletedAt instanceof Timestamp || data.deletedAt instanceof Date) || !(data.expiresAt instanceof Timestamp || data.expiresAt instanceof Date)) throw new Error("remote_deletion_pending");
          return Object.freeze({ deletedAt: data.deletedAt, expiresAt: data.expiresAt, logicalExpiry });
        });
        const existingDetails = markerDetails.filter((detail): detail is NonNullable<typeof detail> => detail !== null);
        let deletedAt = checkpoint?.deletedAt ?? existingDetails[0]?.deletedAt ?? (userExists ? proposedDeletedAt : null);
        const deletedAtMillis = deletedAt instanceof Timestamp ? deletedAt.toMillis() : deletedAt?.getTime();
        let expiresAt = checkpoint?.expiresAt ?? existingDetails[0]?.expiresAt ?? (deletedAtMillis !== undefined ? Timestamp.fromMillis(deletedAtMillis + ACCOUNT_DELETION_TOMBSTONE_RETENTION_MS) : null);
        if (!deletedAt || !expiresAt || deletedIdentityLogicalExpiryMs({ provider: identities[0]?.provider, keyVersion: identities[0]?.keyVersion, subjectHmac: identities[0]?.subjectHmac, deletedAt, expiresAt }) === null) throw new Error("remote_deletion_pending");
        const deletedAtMs = deletedAt instanceof Timestamp ? deletedAt.toMillis() : deletedAt.getTime();
        const expiresAtMs = expiresAt instanceof Timestamp ? expiresAt.toMillis() : expiresAt.getTime();
        if (existingDetails.some((detail) => (detail.deletedAt instanceof Timestamp ? detail.deletedAt.toMillis() : detail.deletedAt.getTime()) !== deletedAtMs
          || (detail.expiresAt instanceof Timestamp ? detail.expiresAt.toMillis() : detail.expiresAt.getTime()) !== expiresAtMs)) throw new Error("remote_deletion_pending");
        if (checkpoint && existing.some((snapshot, index) => snapshot?.exists && markerDetails[index] === null)) throw new Error("remote_deletion_pending");
        if (!checkpoint && existing.some((snapshot) => !snapshot?.exists) && existingDetails.length > 0) throw new Error("remote_deletion_pending");
        if (!checkpoint && !userExists && existingDetails.length !== identities.length) throw new Error("remote_deletion_pending");
        if (!checkpoint) transaction.set(ref, { firestoreErasureDeletedAt: deletedAt, firestoreErasureExpiresAt: expiresAt }, { merge: true });
        committedCheckpoint = Object.freeze({ deletedAt, expiresAt });
        const writes = identities.map((identity, index) => {
          const snapshot = existing[index];
          if (!identity || !snapshot) throw new Error("remote_deletion_pending");
          if (snapshot.exists) return null;
          if (deletedIdentityLogicalExpiryMs({ provider: identity.provider, keyVersion: identity.keyVersion, subjectHmac: identity.subjectHmac, deletedAt, expiresAt })! <= Date.now()) return null;
          return { provider: identity.provider, keyVersion: identity.keyVersion, subjectHmac: identity.subjectHmac, deletedAt, expiresAt };
        });
        return Object.freeze({ deletedAt: deletedAt instanceof Timestamp ? deletedAt : Timestamp.fromDate(deletedAt), writes: Object.freeze(writes) });
      },
      ...(operation.firestoreErasureCheckpoint ? { tombstoneCheckpoint: operation.firestoreErasureCheckpoint } : {}),
      getTombstoneCheckpoint: () => committedCheckpoint,
    });
    if (!committedCheckpoint) throw new Error("remote_deletion_pending");
    await assertFirestoreAccountErasureComplete(this.db, userId, identityRefs, committedCheckpoint);
  }

  private async assertDeletionOwnerInTransaction(transaction: FirebaseFirestore.Transaction, operation: StoredDeletionOperation, fence: string, phase: DeletionPhase): Promise<void> {
    const snapshot = await transaction.get(operationRef(this.db, operation.operationId));
    if (!snapshot.exists) throw new Error("account_deletion_conflict");
    const data = asRecord(snapshot.data(), "account_deletion_operation");
    const leaseUntil = data.leaseUntil;
    const leaseMs = leaseUntil instanceof Timestamp ? leaseUntil.toMillis() : leaseUntil instanceof Date ? leaseUntil.getTime() : 0;
    if (data.phase !== phase || data.fence !== fence || data.userId !== operation.userId || leaseMs <= Date.now()) throw new Error("account_deletion_conflict");
  }

  private assertTombstoneSnapshots(identityRefs: readonly StoredDeletionIdentity[], tombstones: readonly { id: string; exists: boolean; data: () => unknown }[], checkpoint?: StoredDeletionOperation["firestoreErasureCheckpoint"]): void {
    if (identityRefs.length === 0 || tombstones.length !== identityRefs.length) throw new Error("remote_deletion_pending");
    for (let index = 0; index < identityRefs.length; index += 1) {
      const identity = identityRefs[index];
      const tombstone = tombstones[index];
      if (!identity || !tombstone || tombstone.id !== identity.identityId) throw new Error("remote_deletion_pending");
      if (!tombstone.exists) {
        const logicalExpiry = checkpoint ? deletedIdentityLogicalExpiryMs({ provider: identity.provider, keyVersion: identity.keyVersion, subjectHmac: identity.subjectHmac, deletedAt: checkpoint.deletedAt, expiresAt: checkpoint.expiresAt }) : null;
        if (logicalExpiry === null || logicalExpiry > Date.now()) throw new Error("remote_deletion_pending");
        continue;
      }
      const data = asRecord(tombstone.data(), "deleted_identity");
      if (data.provider !== identity.provider || data.keyVersion !== identity.keyVersion || data.subjectHmac !== identity.subjectHmac || deletedIdentityLogicalExpiryMs(data) === null
        || (checkpoint && (asTimestamp(data.deletedAt, "deleted_identity").toMillis() !== asTimestamp(checkpoint.deletedAt, "deletion_checkpoint").toMillis()
          || asTimestamp(data.expiresAt, "deleted_identity").toMillis() !== asTimestamp(checkpoint.expiresAt, "deletion_checkpoint").toMillis()))) throw new Error("remote_deletion_pending");
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

  private async assertFirestoreDeletionComplete(userId: string, identityRefs: readonly StoredDeletionIdentity[], checkpoint?: StoredDeletionOperation["firestoreErasureCheckpoint"]): Promise<void> {
    await assertFirestoreAccountErasureComplete(this.db, userId, identityRefs, checkpoint ?? undefined);
  }
}
