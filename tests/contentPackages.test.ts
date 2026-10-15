import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { ContentPackageService, LocalFilesystemContentPackageStorage, contentNodePackagePath, verifyContentNodePackage, type ContentNodePackageManifest } from "../src/modules/content/packages.js";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const artifact = Buffer.from('{"nodeId":"unit-test","questions":[]}', "utf8");
  const compressed = gzipSync(artifact, { level: 9 });
  const manifest: ContentNodePackageManifest = { schemaVersion: "patternly-content-node-package-v1", trackId: "sample-track", nodeId: "unit-test", contentVersion: "v1", artifactSha256: digest(artifact), packageSha256: digest(compressed), contentReleaseId: "release-1", minimumAppVersion: "1.0.0", packageFormat: "gzip", compressedSizeBytes: compressed.length, artifactSizeBytes: artifact.length, packagePath: contentNodePackagePath("sample-track", "unit-test", digest(compressed)) };
  return { artifact, compressed, manifest };
}

test("strict package manifest binds path, compressed bytes and opaque artifact bytes", () => {
  const value = fixture();
  assert.equal(verifyContentNodePackage(value.manifest, value.compressed).packageSha256, value.manifest.packageSha256);
  assert.throws(() => verifyContentNodePackage({ ...value.manifest, packagePath: "packages/../escape.gzip" }, value.compressed), /manifest_invalid/u);
  assert.throws(() => verifyContentNodePackage(value.manifest, Buffer.from("different")), /bytes_invalid/u);
  assert.throws(() => verifyContentNodePackage({ ...value.manifest, artifactSha256: "0".repeat(64) }, value.compressed), /artifact_invalid/u);
  for (const minimumAppVersion of ["1.0.0-beta", "01.0.0", "1.0.0+build"]) assert.throws(() => verifyContentNodePackage({ ...value.manifest, minimumAppVersion }, value.compressed), /manifest_invalid/u);
  assert.throws(() => contentNodePackagePath("../escape", "unit-test", value.manifest.packageSha256), /identity_invalid/u);
});

test("filesystem storage contains paths and publisher activates only after immutable verified writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "patternly-content-package-"));
  const events: string[] = [];
  const value = fixture();
  const pointers = {
    async writeImmutableManifest() { events.push("manifest"); },
    async activate() { events.push("pointer"); },
    async readCurrent() { return value.manifest; },
  };
  try {
    const storage = new LocalFilesystemContentPackageStorage(root);
    const service = new ContentPackageService(pointers, storage);
    await service.publish(value.manifest, value.compressed);
    assert.deepEqual(events, ["manifest", "pointer"]);
    assert.deepEqual(await storage.read(value.manifest.packagePath), value.compressed);
    await assert.rejects(storage.read("packages/../../etc/passwd"), /path_invalid/u);
    await assert.rejects(storage.writeImmutable(value.manifest.packagePath, Buffer.from("conflict")), /immutable_conflict/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publication leaves pointer unchanged when package bytes cannot be verified", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "patternly-content-package-"));
  let activated = false;
  const value = fixture();
  try {
    const service = new ContentPackageService({ writeImmutableManifest: async () => {}, activate: async () => { activated = true; }, readCurrent: async () => null }, new LocalFilesystemContentPackageStorage(root));
    await assert.rejects(service.publish(value.manifest, Buffer.from("bad")), /bytes_invalid/u);
    assert.equal(activated, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("GCS descriptor pins metadata generation, refuses transformed bytes, unavailable signer and immutable conflict", async () => {
  const { gcsPackageFixture } = await import("./fixtures/gcsPackageFixture.js");
  const gcs = gcsPackageFixture(), value = fixture();
  const service = new ContentPackageService({ writeImmutableManifest: async () => {}, activate: async () => {}, readCurrent: async () => value.manifest }, gcs.storage);
  await service.publish(value.manifest, value.compressed);
  const descriptor = await service.describeCurrent("sample-track", "unit-test");
  assert.equal(descriptor?.object.path, value.manifest.packagePath);
  assert.equal(new URL(descriptor!.downloadUrl).searchParams.get("generation"), descriptor?.object.generation);
  assert.ok(Date.parse(descriptor!.expiresAt) > Date.now() && Date.parse(descriptor!.expiresAt) <= Date.now() + 60000);
  const row = gcs.metadata.get(value.manifest.packagePath)!;
  for (const patch of [{ contentEncoding: "gzip" }, { contentType: "text/plain" }, { generation: "0" }, { bucket: "wrong" }, { name: "wrong" }]) {
    const before = { ...row }; Object.assign(row, patch);
    await assert.rejects(service.describeCurrent("sample-track", "unit-test"), /unavailable/u);
    for (const key of Object.keys(row)) delete row[key]; Object.assign(row, before);
  }
  gcs.setSignerUnavailable(true);
  await assert.rejects(service.describeCurrent("sample-track", "unit-test"), /unavailable/u);
  gcs.setSignerUnavailable(false);
  await gcs.storage.writeImmutable(value.manifest.packagePath, value.compressed);
  await assert.rejects(gcs.storage.writeImmutable(value.manifest.packagePath, Buffer.from("wrong")), /immutable_conflict/u);
  assert.equal((gcs.calls.find((call) => call.operation === "save")!.options as { preconditionOpts: { ifGenerationMatch: number } }).preconditionOpts.ifGenerationMatch, 0);
});

test("real installed GCS SDK signs the generation query and bounded signed expiry locally (no provider proof)", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { initializeApp, cert, deleteApp } = await import("firebase-admin/app");
  const { getStorage } = await import("firebase-admin/storage");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const app = initializeApp({ credential: cert({ projectId: "demo-local-signing", clientEmail: "local@demo-local-signing.iam.gserviceaccount.com", privateKey }) }, "content-package-local-signing");
  try {
    const { GcsContentPackageStorage } = await import("../src/infrastructure/content/gcsContentPackageStorage.js");
    const value = fixture();
    const bucket = getStorage(app).bucket("patternly-local-contract");
    const file = bucket.file(value.manifest.packagePath);
    // Only metadata is modeled. Signing below is the installed SDK, no network call/key file.
    const storage = new GcsContentPackageStorage({ name: bucket.name, file: () => ({
      getMetadata: async () => [{ bucket: bucket.name, name: value.manifest.packagePath, generation: "12345678901234567", size: String(value.compressed.length), contentType: "application/gzip" }],
      getSignedUrl: file.getSignedUrl.bind(file),
    }) } as never);
    const descriptor = await storage.describe(value.manifest);
    const parsed = new URL(descriptor.downloadUrl);
    assert.equal(parsed.hostname, "storage.googleapis.com");
    assert.equal(parsed.searchParams.get("generation"), "12345678901234567");
    const seconds = Number(parsed.searchParams.get("X-Goog-Expires"));
    assert.ok(seconds >= 1 && seconds <= 60);
    assert.equal(parsed.searchParams.get("X-Goog-Algorithm"), "GOOG4-RSA-SHA256");
    const signedAt = parsed.searchParams.get("X-Goog-Date")!;
    const issued = Date.parse(`${signedAt.slice(0,4)}-${signedAt.slice(4,6)}-${signedAt.slice(6,8)}T${signedAt.slice(9,11)}:${signedAt.slice(11,13)}:${signedAt.slice(13,15)}Z`);
    assert.equal(Date.parse(descriptor.expiresAt), issued + seconds * 1000);
    assert.ok(Date.parse(descriptor.expiresAt) > Date.now() && Date.parse(descriptor.expiresAt) <= Date.now() + 60_000);
  } finally { await deleteApp(app); }
});


test("publication refuses an existing object with matching bytes but unusable HTTP metadata before pointer activation", async () => {
  const { gcsPackageFixture } = await import("./fixtures/gcsPackageFixture.js");
  for (const patch of [{ contentEncoding: "gzip" }, { contentType: "text/plain" }, { bucket: "wrong-bucket" }, { name: "wrong-object" }]) {
    const gcs = gcsPackageFixture(), value = fixture(), events: string[] = [];
    await gcs.storage.writeImmutable(value.manifest.packagePath, value.compressed);
    Object.assign(gcs.metadata.get(value.manifest.packagePath)!, patch);
    const service = new ContentPackageService({ writeImmutableManifest: async () => { events.push("manifest"); }, activate: async () => { events.push("pointer"); }, readCurrent: async () => null }, gcs.storage);
    await assert.rejects(service.publish(value.manifest, value.compressed), /object_invalid/u);
    assert.deepEqual(events, []);
  }
});
