import { GcsContentPackageStorage } from "../../src/infrastructure/content/gcsContentPackageStorage.js";

/** Contract model only; not evidence for Cloud Storage or IAM. */
export function gcsPackageFixture() {
  const bytes = new Map<string, Buffer>();
  const metadata = new Map<string, Record<string, unknown>>();
  const calls: Array<{ operation: string; path: string; options?: unknown }> = [];
  let signerUnavailable = false;
  const bucket = { name: "patternly-local-contract", file(path: string, options?: { generation?: string }) {
    return {
      async save(value: Buffer, config: { preconditionOpts: { ifGenerationMatch: number }; metadata: Record<string, unknown> }) {
        calls.push({ operation: "save", path, options: config });
        if (bytes.has(path)) throw { code: 412 };
        bytes.set(path, Buffer.from(value));
        metadata.set(path, { bucket: bucket.name, name: path, generation: "12345678901234567", size: String(value.length), ...config.metadata });
      },
      async getMetadata() { calls.push({ operation: "metadata", path }); const row = metadata.get(path); const value = bytes.get(path); if (!row || !value) throw new Error("missing"); return [{ ...row, size: String(value.length) }]; },
      async download(config: unknown) { calls.push({ operation: "download", path, options: { ...options, config } }); const value = bytes.get(path); if (!value) throw new Error("missing"); return [Buffer.from(value)]; },
      async getSignedUrl(config: { expires: number; queryParams: { generation: string } }) {
        calls.push({ operation: "sign", path, options: config });
        if (signerUnavailable) throw new Error("signer_unavailable");
        const issued = Math.floor(Date.now() / 1000) * 1000;
        const query = new URLSearchParams({ generation: config.queryParams.generation, "X-Goog-Algorithm": "GOOG4-RSA-SHA256", "X-Goog-Date": new Date(issued).toISOString().replace(/[-:]/gu, "").replace(".000", ""), "X-Goog-Expires": String((config.expires - issued) / 1000), "X-Goog-Signature": "fixture-only" });
        return [`https://storage.googleapis.com/${bucket.name}/${path}?${query}`];
      },
    };
  } };
  return { storage: new GcsContentPackageStorage(bucket as never), bytes, metadata, calls, setSignerUnavailable: (value: boolean) => { signerUnavailable = value; } };
}
