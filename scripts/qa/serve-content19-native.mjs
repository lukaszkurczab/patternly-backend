import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createEmulatorContext, createRegisteredAuthUser, clearFirestore, TEST_APP_CHECK_TOKEN } from "../../tests/support.ts";
import { ContentPackageService, FirestoreContentPackagePointerStore } from "../../src/modules/content/packages.ts";
import { gcsPackageFixture } from "../../tests/fixtures/gcsPackageFixture.ts";
if (process.env.FIREBASE_PROJECT_ID !== "demo-patternly-content19" || process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:18119") throw Error("native_fixture_isolation_required");
const metadata = JSON.parse(await readFile(resolve("../patternly/src/content/generated/premium-node-offer.json"), "utf8"));
const configuredOffer = metadata.offer;
const packageRoot = resolve(process.env.PATTERNLY_CONTENT_PACKAGE_ROOT ?? "../patternly-content/dist", "premium-nodes", configuredOffer.trackId, configuredOffer.nodeId, "current");
let manifest;
try { manifest = JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8")); }
catch (error) {
  if (error?.code === "ENOENT") throw new Error(`premium_package_missing: run (cd ../patternly-content && npm run content:build-premium-node -- --track ${configuredOffer.trackId} --node ${configuredOffer.nodeId})`, { cause: error });
  throw error;
}
if (manifest.trackId !== configuredOffer.trackId || manifest.nodeId !== configuredOffer.nodeId) throw new Error("premium_package_identity_mismatch");
const bytes = await readFile(join(packageRoot, "package.gzip"));
// Probe the current generated package with a local runtime identity projection;
// the APP offer file remains unchanged and is not treated as an applied release.
const offer = { ...configuredOffer, contentVersion: manifest.contentVersion, artifactSha256: manifest.artifactSha256 };
let allowed = true;
const gcs = gcsPackageFixture();
const context = createEmulatorContext({ revenueCatEntitlementReader: { read: async () => ({ entitlement: "premium", productId: "monthly", state: allowed ? "active" : "expired", providerExpiresAt: "2099-01-01T00:00:00.000Z", providerGraceExpiresAt: null, providerObservedAt: new Date().toISOString() }) }, createContentPackages: (db) => new ContentPackageService(new FirestoreContentPackagePointerStore(db), gcs.storage) });
await clearFirestore();
const auth = await createRegisteredAuthUser(context);
await new ContentPackageService(new FirestoreContentPackagePointerStore(context.db), gcs.storage).publish(manifest, bytes);
const server = createServer(async (request, reply) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1:29119");
    reply.setHeader("cache-control", "no-store");
    if (url.pathname === "/probe") { reply.setHeader("content-type", "application/octet-stream"); reply.end(Buffer.from([1,2,3])); return; }
    if (url.pathname === "/fixture/config") { reply.setHeader("content-type", "application/json"); reply.end(JSON.stringify({ idToken: auth.idToken, appCheckToken: TEST_APP_CHECK_TOKEN, manifest })); return; }
    if (url.pathname === "/fixture/access" && request.method === "POST") { allowed = url.searchParams.get("allowed") !== "false"; reply.end("ok"); return; }
    if (url.pathname === "/fixture/object") {
      const value = Buffer.from(bytes); if (url.searchParams.get("mode") === "hash") value[value.length - 1] ^= 1;
      reply.setHeader("content-type", "application/gzip"); reply.setHeader("content-length", String(value.length)); reply.end(value); return;
    }
    if (url.pathname === `/v1/content/packages/${offer.trackId}/${offer.nodeId}`) {
      const result = await context.app.inject({ method: "GET", url: url.pathname, headers: request.headers });
      reply.writeHead(result.statusCode, result.headers); reply.end(result.rawPayload); return;
    }
    reply.writeHead(404); reply.end("not_found");
  } catch { reply.writeHead(503); reply.end("fixture_unavailable"); }
});
await new Promise((accept, reject) => { server.once("error", reject); server.listen(29119, "127.0.0.1", accept); });
console.log("CONTENT19_NATIVE_FIXTURE_READY port=29119; modeled GCS, isolated Auth/Firestore, current-source-package");
await new Promise((accept) => { process.once("SIGTERM", accept); process.once("SIGINT", accept); });
await new Promise((accept) => server.close(accept)); await context.close();
