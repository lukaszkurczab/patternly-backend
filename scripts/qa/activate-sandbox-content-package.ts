import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../../src/infrastructure/identity/canonicalJson.js";
import { verifyContentNodePackage } from "../../src/modules/content/packages.js";

// Explicit sandbox-only publisher: immutable creates, never overwrite a pointer.
// Credentials stay in memory and are passed to curl through stdin, never argv/logs.
const [mode, root] = process.argv.slice(2);
if (!["--check", "--activate"].includes(mode ?? "") || !root) throw new Error("usage: --check|--activate package-directory");
const project = "patternly-app-sandbox";
const gcloud = process.env.GCLOUD_BIN ?? "gcloud";
const input = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const manifest = verifyContentNodePackage(input, await readFile(path.join(root, `${input.packageSha256}.gzip`)));
const token = execFileSync(gcloud, ["auth", "print-access-token", "--project", project], { encoding: "utf8" }).trim();
const base = `projects/${project}/databases/(default)/documents`;
const id = createHash("sha256").update(canonicalJson({ trackId: manifest.trackId, nodeId: manifest.nodeId, packageSha256: manifest.packageSha256 })).digest("hex");
const docs = [
  { name: `${base}/contentNodePackages/${id}`, value: manifest },
  { name: `${base}/contentNodePackagePointers/${manifest.trackId}:${manifest.nodeId}`, value: { trackId: manifest.trackId, nodeId: manifest.nodeId, manifestId: id } },
];
function call(url: string, body?: unknown): { status: number; data: any } {
  const config = `header = ${JSON.stringify(`Authorization: Bearer ${token}`)}\nheader = "Content-Type: application/json"\n`
    + (body === undefined ? "" : `request = "POST"\ndata = ${JSON.stringify(JSON.stringify(body))}\n`);
  const output = execFileSync("/usr/bin/curl", ["--silent", "--show-error", "--config", "-", "--write-out", "\n%{http_code}", url], { input: config, encoding: "utf8" });
  const boundary = output.lastIndexOf("\n");
  return { status: Number(output.slice(boundary + 1)), data: JSON.parse(output.slice(0, boundary)) };
}
const fields = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "number" ? { integerValue: String(item) } : { stringValue: item }]));
const writes = [];
for (const doc of docs) {
  const result = call(`https://firestore.googleapis.com/v1/${doc.name}`);
  if (result.status === 404) writes.push({ update: { name: doc.name, fields: fields(doc.value) }, currentDocument: { exists: false } });
  else if (result.status !== 200 || canonicalJson(result.data.fields) !== canonicalJson(fields(doc.value))) throw new Error("sandbox_package_existing_document_conflict");
}
if (mode === "--activate" && writes.length) {
  const result = call(`https://firestore.googleapis.com/v1/${base}:commit`, { writes });
  if (result.status !== 200) throw new Error(`sandbox_package_commit_failed:${result.status}`);
}
console.log(JSON.stringify({ mode, project, trackId: manifest.trackId, nodeId: manifest.nodeId, artifactSha256: manifest.artifactSha256, packageSha256: manifest.packageSha256, manifestId: id, missingBefore: writes.length, result: mode === "--activate" ? "activated_or_exact_existing" : "preflight_pass" }));
