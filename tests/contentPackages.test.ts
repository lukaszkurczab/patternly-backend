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
    assert.deepEqual((await service.readCurrent("sample-track", "unit-test"))?.bytes, value.compressed);
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
