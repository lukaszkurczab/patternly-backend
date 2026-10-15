import type { getStorage } from "firebase-admin/storage";
import { CONTENT_PACKAGE_LIMITS, type ContentPackageStorage, type ContentNodePackageManifest, type ContentPackageDownloadDescriptor } from "../../modules/content/packages.js";

type Bucket = ReturnType<ReturnType<typeof getStorage>["bucket"]>;
const GENERATION = /^[1-9][0-9]{0,30}$/u;

/** The only deployed byte provider. Local filesystem storage remains producer/test tooling. */
export class GcsContentPackageStorage implements ContentPackageStorage {
  constructor(private readonly bucket: Bucket) {}

  async writeImmutable(packagePath: string, bytes: Buffer): Promise<void> {
    if (bytes.length > CONTENT_PACKAGE_LIMITS.compressedBytes) throw new Error("content_package_bytes_invalid");
    try {
      await this.bucket.file(packagePath).save(bytes, {
        resumable: false, validation: "crc32c", preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { contentType: "application/gzip", cacheControl: "private, no-store" },
      });
    } catch (error) {
      if ((error as { code?: unknown })?.code !== 412) throw new Error("content_package_write_unavailable");
      if (!(await this.read(packagePath)).equals(bytes)) throw new Error("content_package_immutable_conflict");
    }
  }

  async read(packagePath: string): Promise<Buffer> {
    const file = this.bucket.file(packagePath);
    const [metadata] = await file.getMetadata();
    if (metadata.bucket !== this.bucket.name || metadata.name !== packagePath || metadata.contentType !== "application/gzip" || metadata.contentEncoding
      || typeof metadata.generation !== "string" || !GENERATION.test(metadata.generation)
      || !Number.isSafeInteger(Number(metadata.size)) || Number(metadata.size) < 1 || Number(metadata.size) > CONTENT_PACKAGE_LIMITS.compressedBytes) throw new Error("content_package_object_invalid");
    const [bytes] = await this.bucket.file(packagePath, { generation: String(metadata.generation) }).download({ validation: "crc32c", decompress: false });
    if (bytes.length !== Number(metadata.size)) throw new Error("content_package_bytes_invalid");
    return bytes;
  }

  async describe(manifest: ContentNodePackageManifest): Promise<ContentPackageDownloadDescriptor> {
    try {
      const [metadata] = await this.bucket.file(manifest.packagePath).getMetadata();
      const generation = metadata.generation;
      if (metadata.bucket !== this.bucket.name || metadata.name !== manifest.packagePath
        || Number(metadata.size) !== manifest.compressedSizeBytes || metadata.contentType !== "application/gzip"
        || metadata.contentEncoding || typeof generation !== "string" || !GENERATION.test(generation)) throw new Error("content_package_object_invalid");
      // The SDK may cross a second while signing; derive expiry from its signed fields.
      const expires = Math.floor(Date.now() / 1000) * 1000 + 60_000;
      const [downloadUrl] = await this.bucket.file(manifest.packagePath).getSignedUrl({
        version: "v4", action: "read", expires, queryParams: { generation },
      });
      const signed = new URL(downloadUrl);
      const date = signed.searchParams.get("X-Goog-Date")?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u);
      const issued = date ? Date.parse(`${date[1]}-${date[2]}-${date[3]}T${date[4]}:${date[5]}:${date[6]}Z`) : NaN;
      const seconds = Number(signed.searchParams.get("X-Goog-Expires"));
      const signedExpiry = issued + seconds * 1000;
      if (signed.hostname !== "storage.googleapis.com" || signed.protocol !== "https:"
        || signed.searchParams.get("generation") !== generation || !Number.isInteger(seconds) || seconds < 1 || seconds > 60
        || !Number.isFinite(signedExpiry) || signedExpiry <= Date.now() || signedExpiry > Date.now() + 60_000) throw new Error("content_package_url_invalid");
      return Object.freeze({ schemaVersion: "patternly-content-download-v1", manifest,
        object: Object.freeze({ bucket: this.bucket.name, path: manifest.packagePath, generation }),
        downloadUrl, expiresAt: new Date(signedExpiry).toISOString() });
    } catch { throw new Error("content_package_unavailable"); }
  }
}
