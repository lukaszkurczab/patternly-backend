import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { assertDeletionEvidenceContract, assertFixturePaths, assertNewProofId, assertOwnedRootOwnership, assertPreSnapshotGuards, resolveMappedAccountId, selectNewOperationId, signManifest, validateEmulatorTarget, validateManifest, verifyManifest } from "../scripts/profile06-deletion-fixture.js";

const hmacSecret = randomBytes(32).toString("hex");
const manifest = signManifest(Object.freeze({
  version: 1 as const,
  fixtureId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId: "patternly-app-sandbox" as const,
  authUid: "emulator-user-1",
  accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  emailSha256: "a".repeat(64),
  operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  operationIdsBefore: ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"],
  proofIdsBefore: ["proof_previous"],
  proofId: "proof_fixture-proof-1",
  userPaths: ["users/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "users/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/progress/doc"],
  ownedPaths: ["recoveryCodeIndex/code-1"],
  reports: [{ path: "contentReports/report-1", expiresAtMs: null, audit: [{ path: "contentReports/report-1/audit/created", sha256: "b".repeat(64) }] }],
  tombstones: [{ path: "deletedIdentities/test_" + "c".repeat(64), provider: "firebase", keyVersion: "test", subjectHmac: "c".repeat(64) }],
}), hmacSecret);

const env = { FIREBASE_PROJECT_ID: "patternly-app-sandbox", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:19099", FIRESTORE_EMULATOR_HOST: "127.0.0.1:18081" };

test("emulator target guard requires exact project and loopback endpoints", () => {
  assert.doesNotThrow(() => validateEmulatorTarget(env));
  for (const changed of [
    { ...env, FIREBASE_PROJECT_ID: "patternly-app" },
    { ...env, FIREBASE_AUTH_EMULATOR_HOST: "localhost:19099" },
    { ...env, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" },
    { ...env, FIRESTORE_EMULATOR_HOST: "10.0.0.2:18081" },
    { ...env, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
  ]) assert.throws(() => validateEmulatorTarget(changed));
});

test("manifest guard requires exact fixture identity, email digest and operation ID", () => {
  assert.equal(validateManifest(manifest).accountId, manifest.accountId);
  for (const changed of [
    { ...manifest, projectId: "other-project" },
    { ...manifest, authUid: "not/a/uid" },
    { ...manifest, accountId: "not-an-internal-uuid" },
    { ...manifest, emailSha256: "raw-email@example.com" },
    { ...manifest, operationId: "../other" },
    { ...manifest, proofId: "unbound-proof" },
  ]) assert.throws(() => validateManifest(changed));
  assert.throws(() => validateManifest({ ...manifest, password: "must-not-be-manifested" }));
});

test("Auth UID maps to exactly one Firebase identity and an internal UUID account", () => {
  const authUid = "firebase-auth-subject";
  const accountId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  assert.equal(resolveMappedAccountId(authUid, [{ provider: "firebase", subject: authUid, userId: accountId }]), accountId);
  assert.throws(() => resolveMappedAccountId(authUid, []), { message: "fixture_identity_mapping_ambiguous" });
  assert.throws(() => resolveMappedAccountId(authUid, [
    { provider: "firebase", subject: authUid, userId: accountId },
    { provider: "firebase", subject: authUid, userId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
  ]), { message: "fixture_identity_mapping_ambiguous" });
  assert.throws(() => resolveMappedAccountId(authUid, [{ provider: "firebase", subject: "another-subject", userId: accountId }]), { message: "fixture_identity_mapping_invalid" });
  assert.throws(() => resolveMappedAccountId(authUid, [{ provider: "google", subject: authUid, userId: accountId }]), { message: "fixture_identity_mapping_invalid" });
  assert.throws(() => resolveMappedAccountId(authUid, [{ provider: "firebase", subject: authUid, userId: authUid }]), { message: "fixture_identity_mapping_invalid" });
});

test("manifest guard validates every captured path and nested report audit entry", () => {
  for (const changed of [
    { ...manifest, userPaths: ["users/another-user/private"] },
    { ...manifest, userPaths: ["users/emulator-user-1/../private"] },
    { ...manifest, ownedPaths: ["rateLimitBuckets/global"] },
    { ...manifest, ownedPaths: [42] },
    { ...manifest, tombstones: ["deletedIdentities/not-a-pseudonym"] },
    { ...manifest, tombstones: [{ path: "deletedIdentities/test_" + "c".repeat(64), provider: "firebase", keyVersion: "test", subject: "raw-subject" }] },
    { ...manifest, reports: [null] },
    { ...manifest, reports: [{ path: "contentReports/report-1", expiresAtMs: "later", audit: [] }] },
    { ...manifest, reports: [{ path: "contentReports/report-1", expiresAtMs: null, audit: [{ path: "users/other/audit/x", sha256: "b".repeat(64) }] }] },
    { ...manifest, reports: [{ path: "contentReports/report-1", expiresAtMs: null, audit: [{ path: "contentReports/report-1/audit/x", sha256: "invalid" }] }] },
  ]) assert.throws(() => validateManifest(changed));
});

test("manifest integrity rejects cleanup-path tampering before destructive work", () => {
  const changed = { ...manifest, ownedPaths: ["recoveryCodeIndex/someone-elses-document"] };
  assert.throws(() => verifyManifest(changed, hmacSecret), { message: "fixture_manifest_integrity_invalid" });
  assert.throws(() => verifyManifest(manifest, "local-only-secret-with-at-least-32-bytes"), { message: "fixture_hmac_secret_required" });
  assert.throws(() => verifyManifest(manifest, "f".repeat(64)), { message: "fixture_manifest_integrity_invalid" });
});

test("pre-deletion snapshot guard rejects post-delete or incomplete account state", () => {
  const complete = { authExists: true, mappingCount: 1, mappedAccountId: manifest.accountId, expectedAccountId: manifest.accountId, accountRootExists: true, accountCreatedAtExists: true };
  assert.doesNotThrow(() => assertPreSnapshotGuards(complete));
  for (const changed of [
    { ...complete, authExists: false },
    { ...complete, mappingCount: 0, mappedAccountId: null },
    { ...complete, mappingCount: 2 },
    { ...complete, mappedAccountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    { ...complete, accountRootExists: false },
    { ...complete, accountCreatedAtExists: false },
  ]) assert.throws(() => assertPreSnapshotGuards(changed));
});

test("post-delete evidence requires exactly one operation and proof beyond signed baselines", () => {
  const operationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  assert.equal(selectNewOperationId(manifest.operationIdsBefore!, [...manifest.operationIdsBefore!, operationId]), operationId);
  assert.throws(() => selectNewOperationId(manifest.operationIdsBefore!, manifest.operationIdsBefore!), { message: "fixture_deletion_operation_delta_mismatch" });
  assert.throws(() => selectNewOperationId(manifest.operationIdsBefore!, [...manifest.operationIdsBefore!, operationId, "ffffffff-ffff-4fff-8fff-ffffffffffff"]), { message: "fixture_deletion_operation_delta_mismatch" });
  assert.throws(() => selectNewOperationId(manifest.operationIdsBefore!, [...manifest.operationIdsBefore!, "not-a-uuid"]), { message: "fixture_deletion_operation_delta_mismatch" });
  assertNewProofId(manifest.proofIdsBefore!, [...manifest.proofIdsBefore!, "proof_new"], "proof_new");
  assert.throws(() => assertNewProofId(manifest.proofIdsBefore!, manifest.proofIdsBefore!, "proof_new"), { message: "fixture_deletion_proof_mismatch" });
  assert.throws(() => assertNewProofId(manifest.proofIdsBefore!, [...manifest.proofIdsBefore!, "proof_one", "proof_two"], "proof_one"), { message: "fixture_deletion_proof_mismatch" });
  assert.throws(() => assertNewProofId(manifest.proofIdsBefore!, [...manifest.proofIdsBefore!, "proof_other"], "proof_new"), { message: "fixture_deletion_proof_mismatch" });
});

test("deletion operation and proof retain the complete linked contract", () => {
  const operationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const proofId = "proof_new";
  const completedAt = new Date("2026-01-01T00:00:00.000Z");
  const expiresAt = new Date(completedAt.getTime() + 3 * 365 * 24 * 60 * 60 * 1_000);
  const operation = {
    operationId, status: "complete", phase: "complete", proofId, operationSecretHash: "a".repeat(64), expectedAuthorizationGeneration: 1,
    fence: "fence", leaseUntil: completedAt, createdAt: completedAt, updatedAt: completedAt, authDeletedAt: completedAt,
    remoteDeletedAt: completedAt, completedAt, expiresAt,
  };
  const proof = { status: "deleted", operationId, proofId, completedAt, expiresAt };
  assert.doesNotThrow(() => assertDeletionEvidenceContract(operationId, operation, proofId, proof));
  assert.throws(() => assertDeletionEvidenceContract("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", operation, proofId, proof), { message: "fixture_deletion_operation_mismatch" });
  assert.throws(() => assertDeletionEvidenceContract(operationId, operation, "proof_wrong", proof), { message: "fixture_deletion_proof_mismatch" });
  assert.throws(() => assertDeletionEvidenceContract(operationId, { ...operation, userId: manifest.accountId }, proofId, proof), { message: "fixture_deletion_operation_mismatch" });
  assert.throws(() => assertDeletionEvidenceContract(operationId, operation, proofId, { ...proof, operationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }), { message: "fixture_deletion_proof_mismatch" });
});

test("cleanup paths must belong to the manifest's exact UID and captured retained roots", () => {
  assert.doesNotThrow(() => assertFixturePaths(manifest, [
    `users/${manifest.accountId}/progress/doc`,
    "recoveryCodeIndex/code-1",
    "contentReports/report-1/audit/created",
    manifest.tombstones![0]!.path,
    `accountDeletionOperations/${manifest.operationId}`,
    "deletionProofs/proof_fixture-proof-1",
  ]));
  for (const path of ["users/someone-else", "identityMappings/unrecorded", "contentReports/unrecorded", "rateLimitBuckets/global"]) {
    assert.throws(() => assertFixturePaths(manifest, [path]), { message: "fixture_path_outside_manifest" });
  }
});

test("cleanup validates surviving owned-root documents and exact rate-limit document identity", () => {
  assert.doesNotThrow(() => assertOwnedRootOwnership("recoveryCodeIndex/code-1", manifest.accountId, true, { userId: manifest.accountId }));
  assert.doesNotThrow(() => assertOwnedRootOwnership("recoveryCodeIndex/code-1", manifest.accountId, false, undefined));
  assert.throws(() => assertOwnedRootOwnership("recoveryCodeIndex/someone-elses-document", manifest.accountId, true, { userId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }), { message: "fixture_owned_document_owner_mismatch" });
  assert.doesNotThrow(() => assertOwnedRootOwnership(`accountDataExportRateLimits/${manifest.accountId}`, manifest.accountId, true, {}));
  assert.throws(() => assertOwnedRootOwnership("accountDataExportRateLimits/someone-else", manifest.accountId, false, undefined), { message: "fixture_owned_path_mismatch" });
});
