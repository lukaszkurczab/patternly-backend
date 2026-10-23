import { premiumSnapshotScope } from "./fixtures/premiumSnapshot.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { gcsPackageFixture } from "./fixtures/gcsPackageFixture.js";
import { gzipSync } from "node:zlib";
import { buildApplication } from "../src/api/app.js";
import { createFirebaseTokenVerifier } from "../src/infrastructure/firebase/verifier.js";
import { ContentPackageService, FirestoreContentPackagePointerStore, contentNodePackagePath } from "../src/modules/content/packages.js";
import { REVENUECAT_OFFICIAL_API_BASE_URL, parseSandboxPromotionalAccessPolicy, SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID, SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID, SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID } from "../src/config/sandboxPromotionalAccess.js";
import type { Environment } from "../src/config/environment.js";
import { TEST_APP_CHECK_TOKEN, clearFirestoreForProject, createEmulatorContext, createVerifiedAuthUser, createVerifiedRegisteredAuthUser, registerAuthUser, testEnvironment } from "./support.js";

test("sandbox promotional package access is owner-bound and rechecked at the expiry cutoff", async () => {
  await clearFirestoreForProject(SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID);
  const authApp = getApps().find((app) => app.name === "[DEFAULT]") ?? initializeApp({ projectId: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID });
  assert.equal(authApp.options.projectId, SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID);
  const ownerAuth = await createVerifiedAuthUser(undefined, SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID);
  const policyExpiresAtMs = Date.now() + 10 * 60_000;
  const policyJson = JSON.stringify({
    firebaseProjectId: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID,
    revenueCatProjectId: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID,
    revenueCatAppId: SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID,
    customerId: ownerAuth.localId,
    expiresAt: new Date(policyExpiresAtMs).toISOString(),
  });
  const policy = parseSandboxPromotionalAccessPolicy(policyJson)!;
  const environment: Environment = Object.freeze({
    ...testEnvironment,
    firebaseProjectId: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID,
    firebaseAuthIssuer: `https://securetoken.google.com/${SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID}`,
    revenueCatProjectId: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID,
    revenueCatAppId: SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID,
    revenueCatWebhookEnvironment: "SANDBOX",
    revenueCatApiBaseUrl: REVENUECAT_OFFICIAL_API_BASE_URL,
    sandboxPromotionalAccess: policy,
  });
  const gcs = gcsPackageFixture();
  const requestedUsers: string[] = [];
  const providerExpiresAt = "2099-01-01T00:00:00.000Z";
  let advanceClockAfterSigning = false;
  let service: ContentPackageService | undefined;
  const context = createEmulatorContext({
    environment,
    revenueCatEntitlementReader: { read: async (userId) => {
      requestedUsers.push(userId);
      return { ...premiumSnapshotScope, entitlement: "premium", productId: "monthly", state: "active", providerExpiresAt, providerGraceExpiresAt: null, providerObservedAt: new Date().toISOString() };
    } },
    createContentPackages: (db) => {
      service = new ContentPackageService(new FirestoreContentPackagePointerStore(db), gcs.storage);
      const describe = service.describeCurrent.bind(service);
      service.describeCurrent = async (...args) => {
        const descriptor = await describe(...args);
        if (advanceClockAfterSigning) Date.now = () => policyExpiresAtMs + 1;
        return descriptor;
      };
      return service;
    },
  });
  let expiredApp: ReturnType<typeof buildApplication> | undefined;
  let promotionalApp: ReturnType<typeof buildApplication> | undefined;
  try {
    const owner = await registerAuthUser(context, ownerAuth, SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID);
    assert.equal(owner.localId, ownerAuth.localId);
    const other = await createVerifiedRegisteredAuthUser(context, undefined, SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID);
    const ownerPolicy = parseSandboxPromotionalAccessPolicy(JSON.stringify({
      firebaseProjectId: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID,
      revenueCatProjectId: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID,
      revenueCatAppId: SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID,
      customerId: owner.userId,
      expiresAt: new Date(policyExpiresAtMs).toISOString(),
    }))!;
    const ownerEnvironment: Environment = Object.freeze({ ...environment, sandboxPromotionalAccess: ownerPolicy });
    promotionalApp = buildApplication({
      environment: ownerEnvironment,
      firestore: null,
      verifier: createFirebaseTokenVerifier(ownerEnvironment),
      appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
      stores: context.stores,
      revenueCatEntitlementReader: { read: async (userId: string) => {
        requestedUsers.push(userId);
        return { ...premiumSnapshotScope, entitlement: "premium", productId: "monthly", state: "active", providerExpiresAt, providerGraceExpiresAt: null, providerObservedAt: new Date().toISOString() };
      } },
      contentPackages: service!,
    });
    const artifact = Buffer.from('{"opaque":"owner-scoped promotional fixture"}', "utf8");
    const compressed = gzipSync(artifact, { level: 9 });
    const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const manifest = { schemaVersion: "patternly-content-node-package-v1", trackId: "sample-track", nodeId: "promo-node", contentVersion: "v1", artifactSha256: sha256(artifact), packageSha256: sha256(compressed), contentReleaseId: "release-1", minimumAppVersion: "1.0.0", packageFormat: "gzip", compressedSizeBytes: compressed.length, artifactSizeBytes: artifact.length, packagePath: contentNodePackagePath("sample-track", "promo-node", sha256(compressed)) };
    await service!.publish(manifest, compressed);
    const expected = await service!.describeCurrent("sample-track", "promo-node");
    assert.ok(expected);
    gcs.calls.length = 0;
    const headers = { authorization: `Bearer ${owner.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
    const otherHeaders = { authorization: `Bearer ${other.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };

    const deniedOwner = await promotionalApp.inject({ method: "GET", url: "/v1/content/packages/sample-track/promo-node", headers: otherHeaders });
    assert.equal(deniedOwner.statusCode, 403);
    assert.deepEqual(deniedOwner.json(), { error: { code: "entitlement_required" } });
    assert.equal(requestedUsers.length, 0, "a different account must be denied before provider access");
    assert.equal(gcs.calls.filter((call) => call.operation === "sign").length, 0, "a different account must be denied before signing");

    const allowed = await promotionalApp.inject({ method: "GET", url: "/v1/content/packages/sample-track/promo-node", headers });
    assert.equal(allowed.statusCode, 200);
    const body = allowed.json();
    const signedUrl = new URL(body.downloadUrl);
    const signedDate = signedUrl.searchParams.get("X-Goog-Date")!;
    const issuedAt = Date.parse(`${signedDate.slice(0, 4)}-${signedDate.slice(4, 6)}-${signedDate.slice(6, 8)}T${signedDate.slice(9, 11)}:${signedDate.slice(11, 13)}:${signedDate.slice(13, 15)}Z`);
    assert.deepEqual(body, {
      schemaVersion: "patternly-content-download-v1",
      manifest,
      object: { bucket: "patternly-local-contract", path: manifest.packagePath, generation: "12345678901234567" },
      downloadUrl: body.downloadUrl,
      expiresAt: new Date(issuedAt + Number(signedUrl.searchParams.get("X-Goog-Expires")) * 1_000).toISOString(),
    });
    assert.equal(allowed.headers["cache-control"], "private, no-store");
    assert.equal(signedUrl.searchParams.get("generation"), body.object.generation);
    assert.deepEqual(requestedUsers, [owner.userId]);

    const signsBeforeCutoff = gcs.calls.filter((call) => call.operation === "sign").length;
    const providerReadsBeforeCutoff = requestedUsers.length;
    const originalDateNow = Date.now;
    advanceClockAfterSigning = true;
    let crossedCutoff;
    try {
      crossedCutoff = await promotionalApp.inject({ method: "GET", url: "/v1/content/packages/sample-track/promo-node", headers });
    } finally {
      Date.now = originalDateNow;
      advanceClockAfterSigning = false;
    }
    assert.equal(crossedCutoff!.statusCode, 403, "the grant cutoff must be checked again after signing and protection");
    assert.deepEqual(crossedCutoff!.json(), { error: { code: "entitlement_required" } });
    assert.equal(requestedUsers.length, providerReadsBeforeCutoff + 1);
    assert.equal(gcs.calls.filter((call) => call.operation === "sign").length, signsBeforeCutoff + 1);

    const expiredPolicy = parseSandboxPromotionalAccessPolicy(JSON.stringify({
      firebaseProjectId: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID,
      revenueCatProjectId: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID,
      revenueCatAppId: SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID,
      customerId: owner.userId,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }))!;
    const expiredEnvironment: Environment = Object.freeze({ ...environment, sandboxPromotionalAccess: expiredPolicy });
    if (!service) throw new Error("content_package_service_missing");
    expiredApp = buildApplication({
      environment: expiredEnvironment,
      firestore: null,
      verifier: createFirebaseTokenVerifier(expiredEnvironment),
      appCheckVerifier: { verify: async (token) => { if (token !== TEST_APP_CHECK_TOKEN) throw new Error("app_check_invalid"); } },
      stores: context.stores,
      revenueCatEntitlementReader: { read: async (userId: string) => { requestedUsers.push(userId); return { ...premiumSnapshotScope, entitlement: "premium", productId: "monthly", state: "active", providerExpiresAt, providerGraceExpiresAt: null, providerObservedAt: new Date().toISOString() }; } },
      contentPackages: service,
    });
    const signsBeforeExpiredRequest = gcs.calls.filter((call) => call.operation === "sign").length;
    const providerReadsBeforeExpiredRequest = requestedUsers.length;
    const expiredResponse = await expiredApp.inject({ method: "GET", url: "/v1/content/packages/sample-track/promo-node", headers });
    assert.equal(expiredResponse.statusCode, 403);
    assert.deepEqual(expiredResponse.json(), { error: { code: "entitlement_required" } });
    assert.equal(requestedUsers.length, providerReadsBeforeExpiredRequest, "an expired policy boots safely and denies before provider access");
    assert.equal(gcs.calls.filter((call) => call.operation === "sign").length, signsBeforeExpiredRequest, "an expired policy denies before signing");
  } finally {
    await expiredApp?.close();
    await promotionalApp?.close();
    await context.close();
  }
});
