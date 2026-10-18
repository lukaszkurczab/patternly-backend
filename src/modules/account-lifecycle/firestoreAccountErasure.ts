import type { DocumentReference, DocumentSnapshot, Firestore, Query, Transaction } from "firebase-admin/firestore";
import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { COLLECTIONS } from "../../infrastructure/firestore/paths.js";

export const ACCOUNT_DELETION_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const LEGACY_ACCOUNT_DELETION_TOMBSTONE_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;

export type StoredDeletionIdentity = Readonly<{ identityId: string; provider: string; keyVersion: string; subjectHmac: string }>;

export type AccountErasureCounts = Readonly<{
  userTreeDocuments: number;
  identityMappings: number;
  recoveryCodeIndex: number;
  recoveryOperations: number;
  recoveryOperationResults: number;
  sessionRevocations: number;
  exportAudits: number;
  exportRateLimits: number;
  purchaseTransactions: number;
  contentReportsUnlinked: number;
  privacyRequestsUnlinked: number;
}>;

export type AccountErasureOptions = Readonly<{
  db: Firestore;
  userId: string | null;
  identityRefs: readonly StoredDeletionIdentity[];
  /** Runs inside every transaction that writes data, so production deletion keeps its operation lease and fence. */
  assertWriteAllowed: (transaction: Transaction) => Promise<void>;
  /** Verifies each stored identity against the deletion key ring before it is removed. */
  verifyMapping: (provider: string, subject: string, identity: StoredDeletionIdentity) => boolean;
  /** Production deletion rechecks the account-operation owner before removing the user root. */
  assertUserDeletionOwner?: (userData: Record<string, unknown>) => void;
  /** Produces the marker to preserve or write for each identity. */
  tombstoneWrite: (identity: StoredDeletionIdentity, existing: DocumentSnapshot, deletedAt: Timestamp) => Record<string, unknown>;
  /** Atomically checkpoints the first marker event; used only by the live lifecycle path. */
  prepareTombstones?: (transaction: Transaction, identities: readonly StoredDeletionIdentity[], existing: readonly DocumentSnapshot[], userExists: boolean, proposedDeletedAt: Timestamp) => Promise<Readonly<{ deletedAt: Timestamp; writes: readonly (Record<string, unknown> | null)[] }>>;
  /** Allows live readback to accept TTL-removed markers only after the original expiry. */
  tombstoneCheckpoint?: Readonly<{ deletedAt: Timestamp | Date; expiresAt: Timestamp | Date }>;
  getTombstoneCheckpoint?: () => Readonly<{ deletedAt: Timestamp | Date; expiresAt: Timestamp | Date }> | null;
}>;

export function deletedIdentityLogicalExpiryMs(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(",") !== "deletedAt,expiresAt,keyVersion,provider,subjectHmac"
    || typeof data.provider !== "string" || data.provider.length === 0
    || typeof data.keyVersion !== "string" || data.keyVersion.length === 0
    || typeof data.subjectHmac !== "string" || !/^[a-f0-9]{64}$/u.test(data.subjectHmac)) return null;
  try {
    const deletedAtMs = timestampMillis(data.deletedAt);
    const expiresAtMs = timestampMillis(data.expiresAt);
    if (expiresAtMs === deletedAtMs + ACCOUNT_DELETION_TOMBSTONE_RETENTION_MS) return expiresAtMs;
    if (expiresAtMs === deletedAtMs + LEGACY_ACCOUNT_DELETION_TOMBSTONE_RETENTION_MS) return deletedAtMs + ACCOUNT_DELETION_TOMBSTONE_RETENTION_MS;
  } catch { return null; }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("account_erasure_record_invalid");
  return value as Record<string, unknown>;
}

function timestampMillis(value: unknown): number {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  throw new Error("account_erasure_timestamp_invalid");
}

function assertTombstones(identityRefs: readonly StoredDeletionIdentity[], snapshots: readonly DocumentSnapshot[], checkpoint?: AccountErasureOptions["tombstoneCheckpoint"], requireAll = true): void {
  if (identityRefs.length === 0 || snapshots.length !== identityRefs.length) throw new Error("remote_deletion_pending");
  for (let index = 0; index < identityRefs.length; index += 1) {
    const identity = identityRefs[index];
    const snapshot = snapshots[index];
    if (!identity || !snapshot || snapshot.id !== identity.identityId) throw new Error("remote_deletion_pending");
    if (!snapshot.exists) {
      const logicalExpiry = checkpoint ? deletedIdentityLogicalExpiryMs({ provider: identity.provider, keyVersion: identity.keyVersion, subjectHmac: identity.subjectHmac, deletedAt: checkpoint.deletedAt, expiresAt: checkpoint.expiresAt }) : null;
      if (requireAll || (checkpoint !== undefined && (logicalExpiry === null || logicalExpiry > Date.now()))) throw new Error("remote_deletion_pending");
      continue;
    }
    const data = asRecord(snapshot.data());
    if (data.provider !== identity.provider || data.keyVersion !== identity.keyVersion || data.subjectHmac !== identity.subjectHmac) throw new Error("remote_deletion_pending");
    if (deletedIdentityLogicalExpiryMs(data) === null) throw new Error("remote_deletion_pending");
    if (checkpoint && (timestampMillis(data.deletedAt) !== timestampMillis(checkpoint.deletedAt) || timestampMillis(data.expiresAt) !== timestampMillis(checkpoint.expiresAt))) throw new Error("remote_deletion_pending");
  }
}

function assertMappingsMatch(identityRefs: readonly StoredDeletionIdentity[], mappings: readonly DocumentSnapshot[], verifyMapping: AccountErasureOptions["verifyMapping"]): void {
  for (const mapping of mappings) {
    const data = asRecord(mapping.data());
    if (typeof data.provider !== "string" || typeof data.subject !== "string" || data.subject.length === 0
      || !identityRefs.some((expected) => expected.provider === data.provider && verifyMapping(data.provider as string, data.subject as string, expected))) {
      throw new Error("remote_deletion_pending");
    }
  }
}

export async function eraseFirestoreAccountData(options: AccountErasureOptions): Promise<AccountErasureCounts> {
  const { db, userId, identityRefs, assertWriteAllowed } = options;
  if (identityRefs.length === 0 || new Set(identityRefs.map(({ identityId }) => identityId)).size !== identityRefs.length) throw new Error("remote_deletion_pending");
  const userRef = userId === null ? null : db.collection(COLLECTIONS.users).doc(userId);
  const operationCounts = {
    userTreeDocuments: 0, identityMappings: 0, recoveryCodeIndex: 0, recoveryOperations: 0,
    recoveryOperationResults: 0, sessionRevocations: 0, exportAudits: 0, exportRateLimits: 0,
    purchaseTransactions: 0, contentReportsUnlinked: 0, privacyRequestsUnlinked: 0,
  };

  // Match the live lifecycle order: publish tombstones and remove identity mappings atomically.
  await db.runTransaction(async (transaction) => {
    await assertWriteAllowed(transaction);
    const user = userRef ? await transaction.get(userRef) : null;
    const mappings = userId === null ? null : await transaction.get(db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId));
    const tombstoneRefs = identityRefs.map((identity) => db.collection(COLLECTIONS.deletedIdentities).doc(identity.identityId));
    const tombstones = await transaction.getAll(...tombstoneRefs);
    if (mappings) assertMappingsMatch(identityRefs, mappings.docs, options.verifyMapping);
    assertTombstones(identityRefs, tombstones, options.tombstoneCheckpoint, false);
    if (user && !user.exists && mappings && mappings.size > 0) {
      throw new Error("remote_deletion_pending");
    }
    if (user?.exists) options.assertUserDeletionOwner?.(asRecord(user.data()));
    if (user && !user.exists && !options.tombstoneCheckpoint) assertTombstones(identityRefs, tombstones);
    const deletedAt = Timestamp.now();
    const tombstonePlan = options.prepareTombstones
      ? await options.prepareTombstones(transaction, identityRefs, tombstones, Boolean(user?.exists), deletedAt)
      : { deletedAt, writes: identityRefs.map((identity, index) => {
        const existing = tombstones[index];
        if (!identity || !existing) throw new Error("remote_deletion_pending");
        return options.tombstoneWrite(identity, existing, deletedAt);
      }) };
    const tombstoneWrites = tombstonePlan.writes;
    if (tombstoneWrites.length !== identityRefs.length) throw new Error("remote_deletion_pending");
    for (let index = 0; index < identityRefs.length; index += 1) {
      const existing = tombstones[index];
      const marker = tombstoneWrites[index];
      if (!existing) throw new Error("remote_deletion_pending");
      if (marker) transaction.set(existing.ref, marker);
    }
    if (mappings) {
      operationCounts.identityMappings = mappings.size;
      for (const mapping of mappings.docs) transaction.delete(mapping.ref);
    }
    if (user?.exists && userRef) transaction.set(userRef, { deletedAt: tombstonePlan.deletedAt, updatedAt: deletedAt }, { merge: true });
  });

  if (userId !== null && userRef) {
    operationCounts.recoveryCodeIndex += await deleteOwnedQuery(db.collection(COLLECTIONS.recoveryCodeIndex).where("userId", "==", userId), options);
    operationCounts.recoveryOperations += await deleteOwnedQuery(db.collection(COLLECTIONS.accountRecoveryOperations).where("userId", "==", userId), options);
    operationCounts.recoveryOperationResults += await deleteOwnedQuery(db.collection(COLLECTIONS.accountRecoveryOperationResults).where("userId", "==", userId), options);
    operationCounts.sessionRevocations += await deleteOwnedQuery(db.collection(COLLECTIONS.sessionRevocationOperations).where("userId", "==", userId), options);
    operationCounts.purchaseTransactions += await deleteOwnedQuery(db.collection("revenueCatTransactions").where("ownerAccountId", "==", userId), options, true);
    operationCounts.exportAudits += await deleteOwnedQuery(db.collection(COLLECTIONS.accountDataExportAudits).where("userId", "==", userId), options);
    const rateLimitRef = db.collection(COLLECTIONS.accountDataExportRateLimits).doc(userId);
    operationCounts.exportRateLimits += await deleteDocumentsOwned([rateLimitRef], options);
    operationCounts.contentReportsUnlinked += await unlinkOwnedReports(db.collection(COLLECTIONS.contentReports).where("accountId", "==", userId).orderBy(FieldPath.documentId()).limit(400), userId, options);
    operationCounts.privacyRequestsUnlinked += await unlinkOwnedPrivacyRequests(db.collection(COLLECTIONS.privacyRequests).where("userId", "==", userId).orderBy(FieldPath.documentId()).limit(400), userId, options);
    operationCounts.userTreeDocuments += await deleteSubtreeOwned(userRef, options);
    operationCounts.userTreeDocuments += await deleteRootUserOwned(userRef, options);

  }

  await assertFirestoreAccountErasureComplete(db, userId, identityRefs, options.getTombstoneCheckpoint?.() ?? options.tombstoneCheckpoint);
  return Object.freeze(operationCounts);
}

async function deleteDocumentsOwned(refs: readonly DocumentReference[], options: AccountErasureOptions): Promise<number> {
  let deleted = 0;
  const batchSize = 400;
  for (let offset = 0; offset < refs.length; offset += batchSize) {
    const batchRefs = refs.slice(offset, offset + batchSize);
    deleted += await options.db.runTransaction(async (transaction) => {
      await options.assertWriteAllowed(transaction);
      const snapshots = await transaction.getAll(...batchRefs);
      let committedCount = 0;
      for (const snapshot of snapshots) {
        if (!snapshot.exists) continue;
        transaction.delete(snapshot.ref);
        committedCount += 1;
      }
      return committedCount;
    });
  }
  return deleted;
}

async function deleteOwnedQuery(query: Query, options: AccountErasureOptions, recurse = false): Promise<number> {
  let deleted = 0;
  for (;;) {
    const page = await query.orderBy(FieldPath.documentId()).limit(200).get();
    if (page.empty) return deleted;
    if (recurse) for (const doc of page.docs) deleted += await deleteSubtreeOwned(doc.ref, options);
    deleted += await deleteDocumentsOwned(page.docs.map((doc) => doc.ref), options);
  }
}

async function unlinkOwnedReports(query: Query, userId: string, options: AccountErasureOptions): Promise<number> {
  let unlinked = 0;
  for (;;) {
    const page = await query.get();
    if (page.empty) return unlinked;
    unlinked += await options.db.runTransaction(async (transaction) => {
      await options.assertWriteAllowed(transaction);
      const reports = await transaction.getAll(...page.docs.map((report) => report.ref));
      const updatedAt = Timestamp.now();
      let committedCount = 0;
      for (const report of reports) {
        if (!report.exists) continue;
        const data = asRecord(report.data());
        if (data.accountId !== userId) continue;
        transaction.update(report.ref, { accountId: FieldValue.delete(), contactEmail: FieldValue.delete(), updatedAt });
        committedCount += 1;
      }
      return committedCount;
    });
  }
}

async function unlinkOwnedPrivacyRequests(query: Query, userId: string, options: AccountErasureOptions): Promise<number> {
  let unlinked = 0;
  for (;;) {
    const page = await query.get();
    if (page.empty) return unlinked;
    unlinked += await options.db.runTransaction(async (transaction) => {
      await options.assertWriteAllowed(transaction);
      const requests = await transaction.getAll(...page.docs.map((request) => request.ref));
      let committedCount = 0;
      for (const request of requests) {
        if (!request.exists) continue;
        const data = asRecord(request.data());
        if (data.userId !== userId) continue;
        transaction.update(request.ref, { userId: FieldValue.delete(), subjectPseudonym: FieldValue.delete() });
        committedCount += 1;
      }
      return committedCount;
    });
  }
}

async function deleteSubtreeOwned(ref: DocumentReference, options: AccountErasureOptions): Promise<number> {
  let deleted = 0;
  const collections = await ref.listCollections();
  for (const collection of collections) {
    // listDocuments includes missing documents that still own subcollections.
    // The SDK has no cursor option for this API, so bound reads and writes by
    // processing the returned references in small chunks.
    const documentRefs = await collection.listDocuments();
    documentRefs.sort((left, right) => left.id.localeCompare(right.id));
    const pageSize = 200;
    for (let offset = 0; offset < documentRefs.length; offset += pageSize) {
      const page = documentRefs.slice(offset, offset + pageSize);
      for (const document of page) deleted += await deleteSubtreeOwned(document, options);
      deleted += await deleteDocumentsOwned(page, options);
    }
  }
  return deleted;
}

async function subtreeHasDocuments(ref: DocumentReference): Promise<boolean> {
  let found = false;
  for (const collection of await ref.listCollections()) {
    const documents = await collection.listDocuments();
    if (documents.length > 0) found = true;
    for (const document of documents) if (await subtreeHasDocuments(document)) found = true;
  }
  return found;
}

async function deleteRootUserOwned(userRef: DocumentReference, options: AccountErasureOptions): Promise<number> {
  return options.db.runTransaction(async (transaction) => {
    await options.assertWriteAllowed(transaction);
    const user = await transaction.get(userRef);
    if (!user.exists) return 0;
    const data = asRecord(user.data());
    options.assertUserDeletionOwner?.(data);
    transaction.delete(userRef);
    return 1;
  });
}

export async function assertFirestoreAccountErasureComplete(db: Firestore, userId: string | null, identityRefs: readonly StoredDeletionIdentity[], checkpoint?: AccountErasureOptions["tombstoneCheckpoint"]): Promise<void> {
  if (identityRefs.length === 0) throw new Error("remote_deletion_pending");
  const tombstones = await db.getAll(...identityRefs.map((identity) => db.collection(COLLECTIONS.deletedIdentities).doc(identity.identityId)));
  assertTombstones(identityRefs, tombstones, checkpoint, !checkpoint);
  if (userId === null) return;
  const userRef = db.collection(COLLECTIONS.users).doc(userId);
  const [user, mappings, recoveryCodes, recoveryOperations, recoveryResults, sessionRevocations, linkedReports, linkedPrivacyRequests, exportAudits, exportRateLimit, purchaseTransactions] = await Promise.all([
    userRef.get(),
    db.collection(COLLECTIONS.identityMappings).where("userId", "==", userId).get(),
    db.collection(COLLECTIONS.recoveryCodeIndex).where("userId", "==", userId).get(),
    db.collection(COLLECTIONS.accountRecoveryOperations).where("userId", "==", userId).get(),
    db.collection(COLLECTIONS.accountRecoveryOperationResults).where("userId", "==", userId).get(),
    db.collection(COLLECTIONS.sessionRevocationOperations).where("userId", "==", userId).get(),
    db.collection(COLLECTIONS.contentReports).where("accountId", "==", userId).get(),
    db.collection(COLLECTIONS.privacyRequests).where("userId", "==", userId).get(),
    db.collection(COLLECTIONS.accountDataExportAudits).where("userId", "==", userId).get(),
    db.collection(COLLECTIONS.accountDataExportRateLimits).doc(userId).get(),
    db.collection("revenueCatTransactions").where("ownerAccountId", "==", userId).get(),
  ]);
  if (user.exists || !mappings.empty || !recoveryCodes.empty || !recoveryOperations.empty || !recoveryResults.empty || !sessionRevocations.empty || !linkedReports.empty || !linkedPrivacyRequests.empty || !exportAudits.empty || exportRateLimit.exists || !purchaseTransactions.empty) throw new Error("remote_deletion_pending");
  if (await subtreeHasDocuments(userRef)) throw new Error("remote_deletion_pending");
}
