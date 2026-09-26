import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldPath, getFirestore, Timestamp, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "../src/infrastructure/firestore/paths.js";
import { canonicalJson } from "../src/infrastructure/identity/canonicalJson.js";
import { parsePseudonymKeyRing } from "../src/infrastructure/security/pseudonymKeyRing.js";

const PROJECT = "patternly-app-sandbox";
const AUTH_HOST = "127.0.0.1:19099";
const FIRESTORE_HOST = "127.0.0.1:18081";
const TOMBSTONE_TTL_MS = 45 * 24 * 60 * 60 * 1_000;
const RETENTION_TTL_MS = 3 * 365 * 24 * 60 * 60 * 1_000;
const MANIFEST_VERSION = 1;

export type FixtureManifest = Readonly<{
  version: 1;
  fixtureId: string;
  projectId: typeof PROJECT;
  authUid: string;
  accountId: string;
  emailSha256: string;
  operationId?: string;
  operationIdsBefore?: readonly string[];
  proofIdsBefore?: readonly string[];
  integrityHmac: string;
  proofId?: string;
  userPaths?: readonly string[];
  ownedPaths?: readonly string[];
  reports?: readonly Readonly<{ path: string; expiresAtMs: number | null; audit: readonly Readonly<{ path: string; sha256: string }>[] }>[];
  tombstones?: readonly Readonly<{ path: string; provider: string; keyVersion: string; subjectHmac: string }>[];
}>;

type OwnedRoot = Readonly<{ collection: string; field: string }>;
const OWNED_ROOTS: readonly OwnedRoot[] = Object.freeze([
  { collection: COLLECTIONS.identityMappings, field: "userId" },
  { collection: COLLECTIONS.recoveryCodeIndex, field: "userId" },
  { collection: COLLECTIONS.sessionRevocationOperations, field: "userId" },
  { collection: COLLECTIONS.accountDataExportAudits, field: "userId" },
]);
const COMPLETED_OPERATION_FIELDS = new Set([
  "operationId", "status", "phase", "proofId", "operationSecretHash", "expectedAuthorizationGeneration", "fence", "leaseUntil",
  "createdAt", "updatedAt", "authDeletedAt", "remoteDeletedAt", "completedAt", "expiresAt",
]);

function fixtureHmacSecret(environment: NodeJS.ProcessEnv): string {
  const secret = environment.PROFILE06_FIXTURE_HMAC_SECRET;
  if (typeof secret !== "string" || !/^[a-f0-9]{64}$/u.test(secret)) throw new Error("fixture_hmac_secret_required");
  return secret;
}

export function signManifest(value: Omit<FixtureManifest, "integrityHmac">, secret: string): FixtureManifest {
  const key = fixtureHmacSecret({ PROFILE06_FIXTURE_HMAC_SECRET: secret });
  const unsigned = Object.fromEntries(Object.entries(value).filter(([field]) => field !== "integrityHmac"));
  const integrityHmac = createHmac("sha256", key).update(canonicalJson(unsigned), "utf8").digest("hex");
  return Object.freeze({ ...unsigned, integrityHmac }) as FixtureManifest;
}

export function verifyManifest(value: unknown, secret: string): FixtureManifest {
  const manifest = validateManifest(value);
  const { integrityHmac, ...unsigned } = manifest;
  const expected = createHmac("sha256", fixtureHmacSecret({ PROFILE06_FIXTURE_HMAC_SECRET: secret })).update(canonicalJson(unsigned), "utf8").digest();
  const actual = Buffer.from(integrityHmac, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("fixture_manifest_integrity_invalid");
  return manifest;
}

export function validateEmulatorTarget(environment: NodeJS.ProcessEnv): void {
  if (environment.FIREBASE_PROJECT_ID !== PROJECT) throw new Error("fixture_project_mismatch");
  if (environment.FIREBASE_AUTH_EMULATOR_HOST !== AUTH_HOST) throw new Error("fixture_auth_host_mismatch");
  if (environment.FIRESTORE_EMULATOR_HOST !== FIRESTORE_HOST) throw new Error("fixture_firestore_host_mismatch");
}

export function validateManifest(value: unknown): FixtureManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture_manifest_invalid");
  const m = value as Record<string, unknown>;
  const allowedKeys = new Set(["version", "fixtureId", "projectId", "authUid", "accountId", "emailSha256", "operationId", "operationIdsBefore", "proofIdsBefore", "integrityHmac", "proofId", "userPaths", "ownedPaths", "reports", "tombstones"]);
  if (Object.keys(m).some((key) => !allowedKeys.has(key))) throw new Error("fixture_manifest_invalid");
  if (m.version !== MANIFEST_VERSION || m.projectId !== PROJECT || typeof m.fixtureId !== "string" || !/^[0-9a-f-]{36}$/u.test(m.fixtureId)
    || typeof m.authUid !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/u.test(m.authUid)
    || typeof m.accountId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(m.accountId)
    || typeof m.emailSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(m.emailSha256)
    || (m.operationId !== undefined && (typeof m.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(m.operationId)))
    || (m.operationIdsBefore !== undefined && (!Array.isArray(m.operationIdsBefore) || m.operationIdsBefore.some((id) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) || new Set(m.operationIdsBefore).size !== m.operationIdsBefore.length))
    || (m.proofIdsBefore !== undefined && (!Array.isArray(m.proofIdsBefore) || m.proofIdsBefore.some((id) => typeof id !== "string" || !/^proof_[A-Za-z0-9_-]{1,128}$/u.test(id)) || new Set(m.proofIdsBefore).size !== m.proofIdsBefore.length))
    || (m.proofId !== undefined && m.operationId === undefined)
    || typeof m.integrityHmac !== "string" || !/^[a-f0-9]{64}$/u.test(m.integrityHmac)) throw new Error("fixture_manifest_invalid");
  const isRecord = (entry: unknown): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry);
  const uidRoot = `users/${m.accountId}`;
  if (m.userPaths !== undefined && (!Array.isArray(m.userPaths) || m.userPaths.some((path) => typeof path !== "string"
    || (path !== uidRoot && !path.startsWith(`${uidRoot}/`)) || path.split("/").some((part) => !part || part === "." || part === "..")))) throw new Error("fixture_manifest_invalid");
  const permittedOwnedCollections = new Set(OWNED_ROOTS.map((root) => root.collection).concat(COLLECTIONS.accountDataExportRateLimits));
  if (m.ownedPaths !== undefined && (!Array.isArray(m.ownedPaths) || m.ownedPaths.some((path) => typeof path !== "string"
    || path.split("/").length !== 2 || !permittedOwnedCollections.has(path.split("/")[0]!)
    || (path.startsWith(`${COLLECTIONS.accountDataExportRateLimits}/`) && path !== `${COLLECTIONS.accountDataExportRateLimits}/${m.accountId}`)))) throw new Error("fixture_manifest_invalid");
  if (m.tombstones !== undefined && (!Array.isArray(m.tombstones) || m.tombstones.some((entry) => !isRecord(entry)
    || Object.keys(entry).some((key) => !["path", "provider", "keyVersion", "subjectHmac"].includes(key))
    || typeof entry.path !== "string" || !/^deletedIdentities\/[a-z][a-z0-9_-]{0,31}_[a-f0-9]{64}$/u.test(entry.path)
    || typeof entry.provider !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/u.test(entry.provider)
    || typeof entry.keyVersion !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/u.test(entry.keyVersion)
    || typeof entry.subjectHmac !== "string" || !/^[a-f0-9]{64}$/u.test(entry.subjectHmac)))) throw new Error("fixture_manifest_invalid");
  if (m.reports !== undefined && (!Array.isArray(m.reports) || m.reports.some((entry) => {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !["path", "expiresAtMs", "audit"].includes(key))
      || typeof entry.path !== "string" || !/^contentReports\/[^/]+$/u.test(entry.path)
      || !(entry.expiresAtMs === null || (typeof entry.expiresAtMs === "number" && Number.isSafeInteger(entry.expiresAtMs)))
      || !Array.isArray(entry.audit)) return true;
    return entry.audit.some((audit) => !isRecord(audit) || Object.keys(audit).some((key) => !["path", "sha256"].includes(key))
      || typeof audit.path !== "string" || audit.path.split("/").length !== 4 || !audit.path.startsWith(`${entry.path}/audit/`)
      || typeof audit.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(audit.sha256));
  }))) throw new Error("fixture_manifest_invalid");
  if (m.proofId !== undefined && (typeof m.proofId !== "string" || !/^proof_[A-Za-z0-9_-]{1,128}$/u.test(m.proofId))) throw new Error("fixture_manifest_invalid");
  return m as unknown as FixtureManifest;
}

export function assertFixturePaths(manifest: FixtureManifest, paths: readonly string[]): void {
  const exactRoot = `users/${manifest.accountId}`;
  const permittedOwnedCollections = new Set(OWNED_ROOTS.map((root) => root.collection).concat(COLLECTIONS.accountDataExportRateLimits));
  for (const path of paths) {
    const parts = path.split("/");
    const isUserPath = path === exactRoot || path.startsWith(`${exactRoot}/`);
    const isOwnedPath = parts.length === 2 && permittedOwnedCollections.has(parts[0]!) && manifest.ownedPaths?.includes(path);
    const reportRoot = manifest.reports?.some((item) => path === item.path) === true;
    const reportAudit = parts.length === 4 && parts[0] === COLLECTIONS.contentReports && parts[2] === "audit"
      && manifest.reports?.some((item) => item.path === `${parts[0]}/${parts[1]}` && item.audit.some((audit) => audit.path === path)) === true;
    const isReportPath = (parts.length === 2 && parts[0] === COLLECTIONS.contentReports && reportRoot) || reportAudit;
    const isTombstonePath = parts.length === 2 && parts[0] === COLLECTIONS.deletedIdentities && manifest.tombstones?.some((item) => item.path === path) === true;
    const isOperationPath = Boolean(manifest.operationId && path === `accountDeletionOperations/${manifest.operationId}`);
    const isProofPath = Boolean(manifest.proofId && path === `deletionProofs/${manifest.proofId}`);
    if (!isUserPath && !isOwnedPath && !isReportPath && !isTombstonePath && !isOperationPath && !isProofPath) throw new Error("fixture_path_outside_manifest");
  }
}

export function resolveMappedAccountId(authUid: string, mappings: readonly unknown[]): string {
  if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(authUid) || mappings.length !== 1) throw new Error("fixture_identity_mapping_ambiguous");
  const mapping = mappings[0];
  if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) throw new Error("fixture_identity_mapping_invalid");
  const record = mapping as Record<string, unknown>;
  if (record.provider !== "firebase" || record.subject !== authUid || typeof record.userId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(record.userId)) throw new Error("fixture_identity_mapping_invalid");
  return record.userId;
}

export function assertPreSnapshotGuards(input: Readonly<{
  authExists: boolean; mappingCount: number; mappedAccountId: string | null; expectedAccountId: string;
  accountRootExists: boolean; accountCreatedAtExists: boolean;
}>): void {
  if (!input.authExists) throw new Error("fixture_auth_subject_missing_before_snapshot");
  if (input.mappingCount !== 1 || input.mappedAccountId !== input.expectedAccountId) throw new Error("fixture_identity_mapping_changed");
  if (!input.accountRootExists || !input.accountCreatedAtExists) throw new Error("fixture_account_root_missing_before_snapshot");
}

export function selectNewOperationId(baselineIds: readonly string[], currentIds: readonly string[]): string {
  const baseline = new Set(baselineIds);
  if (baseline.size !== baselineIds.length || currentIds.some((id) => typeof id !== "string") || new Set(currentIds).size !== currentIds.length) {
    throw new Error("fixture_deletion_operation_mismatch");
  }
  const added = currentIds.filter((id) => !baseline.has(id));
  if (added.length !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(added[0]!)) {
    throw new Error("fixture_deletion_operation_delta_mismatch");
  }
  return added[0]!;
}

export function assertNewProofId(baselineIds: readonly string[], currentIds: readonly string[], selectedProofId: string): void {
  const baseline = new Set(baselineIds);
  if (baseline.size !== baselineIds.length || new Set(currentIds).size !== currentIds.length) throw new Error("fixture_deletion_proof_mismatch");
  const added = currentIds.filter((id) => !baseline.has(id));
  if (added.length !== 1 || added[0] !== selectedProofId) throw new Error("fixture_deletion_proof_mismatch");
}

export function assertDeletionEvidenceContract(operationId: string, operationData: Record<string, unknown>, proofId: string, proofData: Record<string, unknown>): void {
  const operationCompletedAt = timestampMs(operationData.completedAt);
  if (Object.keys(operationData).some((key) => !COMPLETED_OPERATION_FIELDS.has(key))
    || Object.keys(operationData).length !== COMPLETED_OPERATION_FIELDS.size
    || operationData.operationId !== operationId || operationData.phase !== "complete" || operationData.status !== "complete"
    || operationCompletedAt === null || timestampMs(operationData.expiresAt) !== operationCompletedAt + RETENTION_TTL_MS) throw new Error("fixture_deletion_operation_mismatch");
  const proofCompletedAt = timestampMs(proofData.completedAt);
  if (Object.keys(proofData).sort().join(",") !== "completedAt,expiresAt,operationId,proofId,status"
    || proofData.proofId !== proofId || proofData.status !== "deleted" || proofData.operationId !== operationId
    || proofCompletedAt === null || proofCompletedAt !== operationCompletedAt || timestampMs(proofData.expiresAt) !== proofCompletedAt + RETENTION_TTL_MS
    || timestampMs(proofData.expiresAt) !== timestampMs(operationData.expiresAt)) throw new Error("fixture_deletion_proof_mismatch");
}

export function assertOwnedRootOwnership(path: string, accountId: string, exists: boolean, data: unknown): void {
  const [collection, documentId, extra] = path.split("/");
  if (!collection || !documentId || extra !== undefined) throw new Error("fixture_owned_path_invalid");
  if (collection === COLLECTIONS.accountDataExportRateLimits) {
    if (documentId !== accountId) throw new Error("fixture_owned_path_mismatch");
    return;
  }
  const root = OWNED_ROOTS.find((candidate) => candidate.collection === collection);
  if (!root) throw new Error("fixture_owned_path_invalid");
  if (exists && (typeof data !== "object" || data === null || Array.isArray(data) || (data as Record<string, unknown>)[root.field] !== accountId)) {
    throw new Error("fixture_owned_document_owner_mismatch");
  }
}

async function deleteOwnedRoot(db: Firestore, path: string, accountId: string): Promise<void> {
  const ref = db.doc(path);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    assertOwnedRootOwnership(path, accountId, snapshot.exists, snapshot.data());
    if (snapshot.exists) transaction.delete(ref);
  });
}

function normalize(value: unknown): unknown {
  if (value instanceof Timestamp) return { __timestampMs: value.toMillis() };
  if (value instanceof Date) return { __timestampMs: value.getTime() };
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalize(v)]));
  return value;
}

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(normalize(value)), "utf8").digest("hex"); }
function timestampMs(value: unknown): number | null { return value instanceof Timestamp ? value.toMillis() : value instanceof Date ? value.getTime() : null; }
function dbApp() { validateEmulatorTarget(process.env); return getApps()[0] ?? initializeApp({ projectId: PROJECT }); }

async function listTree(ref: DocumentReference): Promise<string[]> {
  const result = [ref.path];
  for (const collection of await ref.listCollections()) {
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = collection.orderBy(FieldPath.documentId()).limit(200);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      for (const doc of page.docs) result.push(...await listTree(doc.ref));
      cursor = page.docs.at(-1);
    }
  }
  return result;
}

async function existingTreePaths(ref: DocumentReference): Promise<string[]> {
  const snapshot = await ref.get();
  const result = snapshot.exists ? [ref.path] : [];
  for (const collection of await ref.listCollections()) {
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = collection.orderBy(FieldPath.documentId()).limit(200);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      for (const doc of page.docs) result.push(...await existingTreePaths(doc.ref));
      cursor = page.docs.at(-1);
    }
  }
  return result;
}

async function snapshotBefore(db: Firestore, manifest: FixtureManifest): Promise<FixtureManifest> {
  let authExists = true;
  try { await getAuth(dbApp()).getUser(manifest.authUid); } catch { authExists = false; }
  const subjectMappings = await db.collection(COLLECTIONS.identityMappings)
    .where("provider", "==", "firebase").where("subject", "==", manifest.authUid).get();
  const mappedAccountId = subjectMappings.size === 1 ? resolveMappedAccountId(manifest.authUid, subjectMappings.docs.map((document) => document.data())) : null;
  const userRef = db.collection(COLLECTIONS.users).doc(manifest.accountId);
  const userSnapshot = await userRef.get();
  assertPreSnapshotGuards({ authExists, mappingCount: subjectMappings.size, mappedAccountId, expectedAccountId: manifest.accountId,
    accountRootExists: userSnapshot.exists, accountCreatedAtExists: userSnapshot.get("createdAt") instanceof Timestamp || userSnapshot.get("createdAt") instanceof Date });
  const operationBaseline = await db.collection(COLLECTIONS.accountDeletionOperations).get();
  const proofBaseline = await db.collection(COLLECTIONS.deletionProofs).get();
  const userPaths = await listTree(userRef);
  const ownedPaths: string[] = [];
  for (const root of OWNED_ROOTS) {
    const docs = await db.collection(root.collection).where(root.field, "==", manifest.accountId).get();
    ownedPaths.push(...docs.docs.map((doc) => doc.ref.path));
  }
  const rateLimit = db.collection(COLLECTIONS.accountDataExportRateLimits).doc(manifest.accountId);
  if ((await rateLimit.get()).exists) ownedPaths.push(rateLimit.path);
  const mappings = await db.collection(COLLECTIONS.identityMappings).where("userId", "==", manifest.accountId).get();
  const keyRingJson = process.env.DELETION_PSEUDONYM_KEYS_JSON;
  if (mappings.size > 0 && !keyRingJson) throw new Error("fixture_pseudonym_keyring_required");
  const keyRing = keyRingJson ? parsePseudonymKeyRing(keyRingJson) : null;
  const tombstones = mappings.docs.map((doc) => {
    const data = doc.data();
    if (data.userId !== manifest.accountId || typeof data.provider !== "string" || typeof data.subject !== "string" || !keyRing) throw new Error("fixture_identity_mapping_invalid");
    const pseudonym = keyRing.active(data.provider, data.subject);
    return { path: `${COLLECTIONS.deletedIdentities}/${pseudonym.documentId}`, provider: data.provider, keyVersion: pseudonym.keyVersion, subjectHmac: pseudonym.subjectHmac };
  });
  const reportsSnapshot = await db.collection(COLLECTIONS.contentReports).where("accountId", "==", manifest.accountId).get();
  const reports = await Promise.all(reportsSnapshot.docs.map(async (report) => {
    const audit: Array<{ path: string; sha256: string }> = [];
    const auditCollection = report.ref.collection("audit");
    const children = await auditCollection.orderBy(FieldPath.documentId()).get();
    for (const child of children.docs) audit.push({ path: child.ref.path, sha256: digest(child.data()) });
    return { path: report.ref.path, expiresAtMs: timestampMs(report.get("expiresAt")), audit };
  }));
  if (tombstones.length === 0) throw new Error("fixture_identity_mapping_missing_before_snapshot");
  return Object.freeze({ ...manifest,
    operationIdsBefore: Object.freeze(operationBaseline.docs.map((document) => document.id)),
    proofIdsBefore: Object.freeze(proofBaseline.docs.map((document) => document.id)),
    userPaths: Object.freeze(userPaths), ownedPaths: Object.freeze(ownedPaths), reports: Object.freeze(reports), tombstones: Object.freeze(tombstones) });
}

async function assertDeleted(db: Firestore, manifest: FixtureManifest): Promise<FixtureManifest> {
  if (!manifest.operationIdsBefore || !manifest.proofIdsBefore || !manifest.userPaths || !manifest.ownedPaths || !manifest.reports || !manifest.tombstones || manifest.tombstones.length === 0) throw new Error("fixture_before_snapshot_required");
  const auth = getAuth(dbApp());
  try { await auth.getUser(manifest.authUid); throw new Error("fixture_auth_subject_present"); } catch (error: unknown) {
    if (error instanceof Error && error.message === "fixture_auth_subject_present") throw error;
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code !== "auth/user-not-found" && code !== "user-not-found") throw error;
  }
  const remainingUserPaths = await existingTreePaths(db.collection(COLLECTIONS.users).doc(manifest.accountId));
  if (remainingUserPaths.length > 0) throw new Error("fixture_user_tree_present");
  for (const path of manifest.ownedPaths) if ((await db.doc(path).get()).exists) throw new Error("fixture_owned_root_present");
  for (const root of OWNED_ROOTS) {
    if (!(await db.collection(root.collection).where(root.field, "==", manifest.accountId).limit(1).get()).empty) throw new Error("fixture_owned_root_present");
  }
  if ((await db.collection(COLLECTIONS.accountDataExportRateLimits).doc(manifest.accountId).get()).exists) throw new Error("fixture_owned_root_present");
  for (const report of manifest.reports) {
    const ref = db.doc(report.path);
    const snap = await ref.get();
    if (!snap.exists || snap.get("accountId") !== undefined || snap.get("contactEmail") !== undefined || timestampMs(snap.get("expiresAt")) !== report.expiresAtMs) throw new Error("fixture_report_retention_mismatch");
    for (const audit of report.audit) {
      const auditSnap = await db.doc(audit.path).get();
      if (!auditSnap.exists || digest(auditSnap.data()) !== audit.sha256) throw new Error("fixture_report_audit_mismatch");
    }
  }
  for (const expected of manifest.tombstones) {
    const snap = await db.doc(expected.path).get();
    const data = snap.data();
    if (!data || Object.keys(data).sort().join(",") !== "deletedAt,expiresAt,keyVersion,provider,subjectHmac"
      || data.provider !== expected.provider || data.keyVersion !== expected.keyVersion || data.subjectHmac !== expected.subjectHmac
      || timestampMs(data.deletedAt) === null || timestampMs(data.expiresAt) !== timestampMs(data.deletedAt)! + TOMBSTONE_TTL_MS) throw new Error("fixture_tombstone_contract_mismatch");
  }
  const currentOperations = await db.collection(COLLECTIONS.accountDeletionOperations).get();
  const operationId = selectNewOperationId(manifest.operationIdsBefore, currentOperations.docs.map((document) => document.id));
  const operationRef = db.collection(COLLECTIONS.accountDeletionOperations).doc(operationId);
  const operation = await operationRef.get();
  if (!operation.exists) throw new Error("fixture_deletion_operation_mismatch");
  const operationData = operation.data() ?? {};
  const proofId = operation.get("proofId");
  if (typeof proofId !== "string" || !/^proof_[A-Za-z0-9_-]+$/u.test(proofId)) throw new Error("fixture_deletion_proof_missing");
  const proof = await db.collection(COLLECTIONS.deletionProofs).doc(proofId).get();
  const proofData = proof.data();
  const currentProofs = await db.collection(COLLECTIONS.deletionProofs).get();
  assertNewProofId(manifest.proofIdsBefore, currentProofs.docs.map((document) => document.id), proofId);
  if (!proofData || proof.id !== proofId || (manifest.operationId !== undefined && manifest.operationId !== operationId)
    || (manifest.proofId !== undefined && manifest.proofId !== proofId)) throw new Error("fixture_deletion_proof_mismatch");
  assertDeletionEvidenceContract(operationId, operationData, proofId, proofData);
  return Object.freeze({ ...manifest, operationId, proofId });
}

async function cleanup(db: Firestore, manifest: FixtureManifest): Promise<void> {
  if (!manifest.operationId || !manifest.proofId) throw new Error("fixture_deletion_evidence_required");
  const paths = [
    ...(manifest.userPaths ?? []), ...(manifest.ownedPaths ?? []),
    ...(manifest.reports ?? []).flatMap((report) => [report.path, ...report.audit.map((audit) => audit.path)]),
    ...(manifest.tombstones ?? []).map((tombstone) => tombstone.path), `accountDeletionOperations/${manifest.operationId}`, `deletionProofs/${manifest.proofId}`,
  ];
  assertFixturePaths(manifest, paths);
  const ownedPaths = manifest.ownedPaths ?? [];
  for (const path of ownedPaths) {
    const snapshot = await db.doc(path).get();
    assertOwnedRootOwnership(path, manifest.accountId, snapshot.exists, snapshot.data());
  }
  const ownedPathSet = new Set(ownedPaths);
  for (const path of paths) {
    if (ownedPathSet.has(path)) await deleteOwnedRoot(db, path, manifest.accountId);
    else await db.doc(path).delete();
  }
  try { await getAuth(dbApp()).deleteUser(manifest.authUid); } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code !== "auth/user-not-found" && code !== "user-not-found") throw error;
  }
}

async function readManifest(path: string, secret: string): Promise<FixtureManifest> { return verifyManifest(JSON.parse(await readFile(path, "utf8")), secret); }
async function saveManifest(path: string, value: FixtureManifest): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }

export async function runFixtureCli(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  validateEmulatorTarget(env);
  const secret = fixtureHmacSecret(env);
  const [command, ...options] = args;
  const value = (name: string): string => { const index = options.indexOf(name); const next = options[index + 1]; if (index < 0 || !next || next.startsWith("--")) throw new Error("fixture_argument_missing"); return next; };
  if (command === "bind") {
    const email = value("--email").trim().toLowerCase();
    const auth = getAuth(dbApp());
    const user = await auth.getUserByEmail(email);
    const mappings = await getFirestore(dbApp()).collection(COLLECTIONS.identityMappings)
      .where("provider", "==", "firebase").where("subject", "==", user.uid).get();
    const accountId = resolveMappedAccountId(user.uid, mappings.docs.map((document) => document.data()));
    const manifest = signManifest({ version: 1, fixtureId: randomUUID(), projectId: PROJECT, authUid: user.uid, accountId, emailSha256: createHash("sha256").update(email).digest("hex") }, secret);
    await saveManifest(value("--manifest"), manifest);
    return { fixtureId: manifest.fixtureId, accountId: manifest.accountId };
  }
  const manifestPath = value("--manifest");
  const manifest = await readManifest(manifestPath, secret);
  if (command === "snapshot-before") return saveAndReturn(manifestPath, signManifest(await snapshotBefore(getFirestore(dbApp()), manifest), secret));
  if (command === "assert-deleted") return saveAndReturn(manifestPath, signManifest(await assertDeleted(getFirestore(dbApp()), manifest), secret));
  if (command === "cleanup") { await cleanup(getFirestore(dbApp()), manifest); return { cleaned: true, fixtureId: manifest.fixtureId }; }
  throw new Error("fixture_command_invalid");
}

async function saveAndReturn(path: string, manifest: FixtureManifest): Promise<unknown> { await saveManifest(path, manifest); return { fixtureId: manifest.fixtureId, accountId: manifest.accountId, inspected: true }; }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await runFixtureCli(process.argv.slice(2)))}\n`); }
  catch { process.stdout.write(`${JSON.stringify({ error: "profile06_fixture_failed" })}\n`); process.exitCode = 1; }
}
