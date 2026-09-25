import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { Firestore } from "firebase-admin/firestore";
import { canonicalJson } from "../../infrastructure/identity/canonicalJson.js";

export const CONTENT_PACKAGE_SCHEMA = "patternly-content-node-package-v1" as const;
export const CONTENT_PACKAGE_LIMITS = Object.freeze({ compressedBytes: 2 * 1024 * 1024, artifactBytes: 8 * 1024 * 1024 });
const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export type ContentNodePackageManifest = Readonly<{
  schemaVersion: typeof CONTENT_PACKAGE_SCHEMA;
  trackId: string;
  nodeId: string;
  contentVersion: string;
  artifactSha256: string;
  packageSha256: string;
  contentReleaseId: string;
  minimumAppVersion: string;
  packageFormat: "gzip";
  compressedSizeBytes: number;
  artifactSizeBytes: number;
  packagePath: string;
}>;

export function contentNodePackagePath(trackId: string, nodeId: string, packageSha256: string): string {
  if (!isPackageId(trackId) || !isPackageId(nodeId) || !SHA256.test(packageSha256)) throw new Error("content_package_identity_invalid");
  return `packages/${trackId}/${nodeId}/${packageSha256}.gzip`;
}

function manifestDocumentId(manifest: ContentNodePackageManifest): string {
  return createHash("sha256").update(canonicalJson({ trackId: manifest.trackId, nodeId: manifest.nodeId, packageSha256: manifest.packageSha256 }), "utf8").digest("hex");
}

export function isPackageId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export function validateContentNodePackageManifest(value: unknown): ContentNodePackageManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("content_package_manifest_invalid");
  const row = value as Record<string, unknown>;
  const keys = ["schemaVersion", "trackId", "nodeId", "contentVersion", "artifactSha256", "packageSha256", "contentReleaseId", "minimumAppVersion", "packageFormat", "compressedSizeBytes", "artifactSizeBytes", "packagePath"];
  if (Object.keys(row).sort().join("\0") !== [...keys].sort().join("\0")
    || row.schemaVersion !== CONTENT_PACKAGE_SCHEMA || !isPackageId(row.trackId) || !isPackageId(row.nodeId)
    || !isPackageId(row.contentVersion) || !isPackageId(row.contentReleaseId)
    || typeof row.minimumAppVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(row.minimumAppVersion)
    || row.packageFormat !== "gzip" || typeof row.artifactSha256 !== "string" || !SHA256.test(row.artifactSha256)
    || typeof row.packageSha256 !== "string" || !SHA256.test(row.packageSha256)
    || !Number.isSafeInteger(row.compressedSizeBytes) || Number(row.compressedSizeBytes) < 1 || Number(row.compressedSizeBytes) > CONTENT_PACKAGE_LIMITS.compressedBytes
    || !Number.isSafeInteger(row.artifactSizeBytes) || Number(row.artifactSizeBytes) < 1 || Number(row.artifactSizeBytes) > CONTENT_PACKAGE_LIMITS.artifactBytes
    || row.packagePath !== contentNodePackagePath(row.trackId, row.nodeId, row.packageSha256)) throw new Error("content_package_manifest_invalid");
  return Object.freeze(row as unknown as ContentNodePackageManifest);
}

export function verifyContentNodePackage(manifestInput: unknown, compressed: Buffer): ContentNodePackageManifest {
  const manifest = validateContentNodePackageManifest(manifestInput);
  if (compressed.length !== manifest.compressedSizeBytes || sha256(compressed) !== manifest.packageSha256) throw new Error("content_package_bytes_invalid");
  let artifact: Buffer;
  try { artifact = gunzipSync(compressed, { maxOutputLength: CONTENT_PACKAGE_LIMITS.artifactBytes }); }
  catch { throw new Error("content_package_gzip_invalid"); }
  if (artifact.length !== manifest.artifactSizeBytes || sha256(artifact) !== manifest.artifactSha256) throw new Error("content_package_artifact_invalid");
  return manifest;
}

function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

export interface ContentPackagePointerStore {
  writeImmutableManifest(manifest: ContentNodePackageManifest): Promise<void>;
  activate(manifest: ContentNodePackageManifest): Promise<void>;
  readCurrent(trackId: string, nodeId: string): Promise<ContentNodePackageManifest | null>;
}

export interface ContentPackageStorage {
  writeImmutable(packagePath: string, bytes: Buffer): Promise<void>;
  read(packagePath: string): Promise<Buffer>;
}

export class LocalFilesystemContentPackageStorage implements ContentPackageStorage {
  public constructor(private readonly configuredRoot: string) {
    if (!path.isAbsolute(configuredRoot)) throw new Error("content_package_root_must_be_absolute");
  }

  public async writeImmutable(packagePath: string, bytes: Buffer): Promise<void> {
    const target = this.resolveSafe(packagePath);
    await mkdir(path.dirname(target), { recursive: true });
    await this.assertParentContainment(target);
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    let alreadyExists = false;
    try { await link(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") { await unlink(temporary).catch(() => undefined); throw error; }
      alreadyExists = true;
    }
    await unlink(temporary).catch(() => undefined);
    if (!alreadyExists) return;
    const existing = await this.read(packagePath);
    if (!existing.equals(bytes)) throw new Error("content_package_immutable_conflict");
  }

  public async read(packagePath: string): Promise<Buffer> {
    const target = this.resolveSafe(packagePath);
    await this.assertParentContainment(target);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("content_package_file_invalid");
    return readFile(target);
  }

  private resolveSafe(packagePath: string): string {
    if (!packagePath.startsWith("packages/") || packagePath.includes("\\") || packagePath.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("content_package_path_invalid");
    const root = path.resolve(this.configuredRoot);
    const candidate = path.resolve(root, packagePath);
    if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error("content_package_path_invalid");
    return candidate;
  }

  private async assertParentContainment(candidate: string): Promise<void> {
    const rootReal = await realpath(path.resolve(this.configuredRoot));
    const parentReal = await realpath(path.dirname(candidate));
    if (!parentReal.startsWith(`${rootReal}${path.sep}`)) throw new Error("content_package_path_invalid");
  }
}

export class ContentPackageService {
  public constructor(private readonly pointers: ContentPackagePointerStore, private readonly storage: ContentPackageStorage) {}

  public async publish(manifestInput: unknown, compressed: Buffer): Promise<ContentNodePackageManifest> {
    const manifest = verifyContentNodePackage(manifestInput, compressed);
    await this.storage.writeImmutable(manifest.packagePath, compressed);
    const verified = await this.storage.read(manifest.packagePath);
    verifyContentNodePackage(manifest, verified);
    await this.pointers.writeImmutableManifest(manifest);
    await this.pointers.activate(manifest);
    return manifest;
  }

  public async readCurrent(trackId: string, nodeId: string): Promise<Readonly<{ manifest: ContentNodePackageManifest; bytes: Buffer }> | null> {
    const manifest = await this.pointers.readCurrent(trackId, nodeId);
    if (!manifest) return null;
    try {
      const bytes = await this.storage.read(manifest.packagePath);
      verifyContentNodePackage(manifest, bytes);
      return Object.freeze({ manifest, bytes });
    } catch { throw new Error("content_package_unavailable"); }
  }
}

export class FirestoreContentPackagePointerStore implements ContentPackagePointerStore {
  public constructor(private readonly db: Firestore) {}

  public async writeImmutableManifest(manifest: ContentNodePackageManifest): Promise<void> {
    const ref = this.db.collection("contentNodePackages").doc(manifestDocumentId(manifest));
    const snapshot = await ref.get();
    if (snapshot.exists) {
      if (canonicalJson(snapshot.data()) !== canonicalJson(manifest)) throw new Error("content_package_immutable_conflict");
      return;
    }
    await ref.create(manifest);
  }

  public async activate(manifest: ContentNodePackageManifest): Promise<void> {
    const ref = this.db.collection("contentNodePackagePointers").doc(`${manifest.trackId}:${manifest.nodeId}`);
    await this.db.runTransaction(async (transaction) => {
      const immutable = await transaction.get(this.db.collection("contentNodePackages").doc(manifestDocumentId(manifest)));
      if (!immutable.exists) throw new Error("content_package_manifest_missing");
      transaction.set(ref, { trackId: manifest.trackId, nodeId: manifest.nodeId, manifestId: manifestDocumentId(manifest) });
    });
  }

  public async readCurrent(trackId: string, nodeId: string): Promise<ContentNodePackageManifest | null> {
    const pointer = await this.db.collection("contentNodePackagePointers").doc(`${trackId}:${nodeId}`).get();
    if (!pointer.exists) return null;
    const row = pointer.data() as { manifestId?: unknown };
    if (typeof row.manifestId !== "string" || !SHA256.test(row.manifestId)) throw new Error("content_package_pointer_invalid");
    const manifest = await this.db.collection("contentNodePackages").doc(row.manifestId).get();
    if (!manifest.exists) throw new Error("content_package_manifest_missing");
    const result = validateContentNodePackageManifest(manifest.data());
    if (result.trackId !== trackId || result.nodeId !== nodeId) throw new Error("content_package_pointer_invalid");
    return result;
  }
}
