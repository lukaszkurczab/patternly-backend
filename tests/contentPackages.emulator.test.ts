import { premiumSnapshotScope } from "./fixtures/premiumSnapshot.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { gcsPackageFixture } from "./fixtures/gcsPackageFixture.js";
import { gzipSync } from "node:zlib";
import { ContentPackageService, FirestoreContentPackagePointerStore, contentNodePackagePath } from "../src/modules/content/packages.js";
import { TEST_APP_CHECK_TOKEN, clearFirestore, createEmulatorContext, createVerifiedAuthUser, registerAuthUser } from "./support.js";

test("emulator package route enforces App Check and fresh entitlement and issues only generation-bound descriptors", async () => {
  await clearFirestore();
  const gcs = gcsPackageFixture();
  let result: "active" | "grace" | "hold" | "expired" | "refunded" | "unavailable" | "throw" = "active";
  let providerExpiresAt = "2099-01-01T00:00:00.000Z";
  let providerGraceExpiresAt = "2099-01-02T00:00:00.000Z";
  const requestedUsers: string[] = [];
  let packageReadCount = 0;
  const context = createEmulatorContext({
    revenueCatEntitlementReader: { read: async (userId) => {
      requestedUsers.push(userId);
      if (result === "throw") throw new Error("provider offline");
      return { ...premiumSnapshotScope, entitlement: "premium", productId: "monthly", state: result, providerExpiresAt, providerGraceExpiresAt, providerObservedAt: new Date().toISOString() };
    } },
    createContentPackages: (db) => {
      const service = new ContentPackageService(new FirestoreContentPackagePointerStore(db), gcs.storage);
      const readCurrent = service.describeCurrent.bind(service);
      service.describeCurrent = async (...args) => { packageReadCount += 1; return readCurrent(...args); };
      return service;
    },
  });
  try {
    const user = await registerAuthUser(context, await createVerifiedAuthUser());
    const artifact = Buffer.from('{"opaque":"premium fixture"}', "utf8");
    const compressed = gzipSync(artifact, { level: 9 });
    const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const manifest = { schemaVersion: "patternly-content-node-package-v1", trackId: "sample-track", nodeId: "premium-node", contentVersion: "v1", artifactSha256: sha256(artifact), packageSha256: sha256(compressed), contentReleaseId: "release-1", minimumAppVersion: "1.0.0", packageFormat: "gzip", compressedSizeBytes: compressed.length, artifactSizeBytes: artifact.length, packagePath: contentNodePackagePath("sample-track", "premium-node", sha256(compressed)) };
    await context.app.inject({ method: "GET", url: "/v1/content/packages/sample-track/premium-node" }).then((response) => assert.equal(response.statusCode, 401));
    const invalidAppCheck = await context.app.inject({ method: "GET", url: "/v1/content/packages/sample-track/premium-node", headers: { authorization: `Bearer ${user.idToken}`, "x-firebase-appcheck": "invalid" } });
    assert.equal(invalidAppCheck.statusCode, 401);
    const headers = { authorization: `Bearer ${user.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN };
    const unknown = await context.app.inject({ method: "GET", url: "/v1/content/packages/sample-track/premium-node", headers });
    assert.equal(unknown.statusCode, 404);
    await context.app.inject({ method: "GET", url: "/v1/content/packages/bad%2Ftrack/premium-node", headers }).then((response) => assert.equal(response.statusCode, 400));
    await context.app.inject({ method: "GET", url: "/v1/content/packages/sample-track/premium-node", headers }).then((response) => assert.equal(response.statusCode, 404));
    const service = new ContentPackageService(new FirestoreContentPackagePointerStore(context.db), gcs.storage);
    await service.publish(manifest, compressed);
    const active = await context.app.inject({ method: "GET", url: "/v1/content/packages/sample-track/premium-node", headers });
    assert.equal(active.statusCode, 200);
    assert.match(String(active.headers["content-type"]), /application\/json/u);
    assert.equal(active.headers["cache-control"], "private, no-store");
    assert.deepEqual(active.json().manifest, manifest);
    assert.equal(active.json().object.generation, "12345678901234567");
    assert.equal(new URL(active.json().downloadUrl).searchParams.get("generation"), active.json().object.generation);
    assert.equal(requestedUsers.at(-1), user.userId);
    result = "grace";
    assert.equal((await context.app.inject({ method: "GET", url: "/v1/content/packages/sample-track/premium-node", headers })).statusCode, 200);
    for (const denied of ["hold", "expired", "refunded"] as const) {
      result = denied;
      const beforeReads = packageReadCount;
      const [existing, unpublished] = await Promise.all([
        context.app.inject({ method: "GET", url: "/v1/content/packages/sample-track/premium-node", headers }),
        context.app.inject({ method: "GET", url: "/v1/content/packages/sample-track/unknown-node", headers }),
      ]);
      assert.equal(existing.statusCode, 403, denied);
      assert.equal(unpublished.statusCode, 403, denied);
      assert.deepEqual(existing.json(), { error: { code: "entitlement_required" } });
      assert.deepEqual(unpublished.json(), existing.json());
      assert.equal(packageReadCount, beforeReads, "denied requests must not read or decompress packages");
    }
    for (const invalidDate of [
      { state: "active" as const, field: "expiry" as const, date: "2000-01-01T00:00:00.000Z" },
      { state: "active" as const, field: "expiry" as const, date: "not-a-date" },
      { state: "grace" as const, field: "grace" as const, date: "2000-01-01T00:00:00.000Z" },
      { state: "grace" as const, field: "grace" as const, date: "not-a-date" },
    ]) {
      result = invalidDate.state;
      providerExpiresAt = "2099-01-01T00:00:00.000Z";
      providerGraceExpiresAt = "2099-01-02T00:00:00.000Z";
      if (invalidDate.field === "expiry") providerExpiresAt = invalidDate.date;
      else providerGraceExpiresAt = invalidDate.date;
      const beforeReads = packageReadCount;
      const response = await context.app.inject({ method: "GET", url: "/v1/content/packages/sample-track/premium-node", headers });
      assert.equal(response.statusCode, 403, `${invalidDate.state} ${invalidDate.date}`);
      assert.deepEqual(response.json(), { error: { code: "entitlement_required" } });
      assert.equal(packageReadCount, beforeReads, "invalid or expired entitlement dates must not read packages");
    }
    for (const unavailable of ["unavailable", "throw"] as const) {
      result = unavailable;
      const response = await context.app.inject({ method: "GET", url: "/v1/content/packages/sample-track/premium-node", headers });
      assert.equal(response.statusCode, 503, unavailable);
      assert.deepEqual(response.json(), { error: { code: "entitlement_unavailable" } });
    }
    result = "active";
    providerExpiresAt = "2099-01-01T00:00:00.000Z";
    providerGraceExpiresAt = "2099-01-02T00:00:00.000Z";
    gcs.bytes.set(manifest.packagePath, Buffer.from("corrupt"));
    const corrupt = await context.app.inject({ method: "GET", url: "/v1/content/packages/sample-track/premium-node", headers });
    assert.equal(corrupt.statusCode, 503);
    assert.deepEqual(corrupt.json(), { error: { code: "package_unavailable" } });
    gcs.bytes.delete(manifest.packagePath);
    const missing = await context.app.inject({ method: "GET", url: "/v1/content/packages/sample-track/premium-node", headers });
    assert.equal(missing.statusCode, 503);
    assert.deepEqual(missing.json(), { error: { code: "package_unavailable" } });
  } finally {
    await context.close();
  }
});
