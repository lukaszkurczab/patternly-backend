import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rename, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ContentPackageService, FirestoreContentPackagePointerStore } from "../../src/modules/content/packages.ts";
import { gcsPackageFixture } from "../../tests/fixtures/gcsPackageFixture.ts";
import { clearFirestore, createEmulatorContext, createRegisteredAuthUser, TEST_APP_CHECK_TOKEN } from "../../tests/support.ts";

if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:18119" || process.env.FIREBASE_PROJECT_ID !== "demo-patternly-content19") throw new Error("content_client_isolated_emulator_required");
const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../patternly");
const load = createRequire(join(frontendRoot, "package.json"));
const { createPatternlyApiClient } = load(join(frontendRoot, "src/infrastructure/clients/PatternlyApiClientAdapter.ts"));
const { ContentPackageRuntimeOwner } = load(join(frontendRoot, "src/application/contentPackageRuntimeOwner.ts"));
const { installNodePackage, NodePackageError } = load(join(frontendRoot, "src/content/runtime/nodeContentPackage.ts"));
const { createNodePackageStore } = load(join(frontendRoot, "src/content/runtime/nodePackageStorage.ts"));
const { PREMIUM_NODE_OFFERS } = load(join(frontendRoot, "src/content/application/premiumNodeOffers.release.ts"));
const offer = PREMIUM_NODE_OFFERS[0];
const gcs = gcsPackageFixture();
let allowed = true, stage = "prepare";
const context = createEmulatorContext({ revenueCatEntitlementReader: { read: async () => ({ entitlement: "premium", productId: "monthly", state: allowed ? "active" : "expired", providerExpiresAt: "2099-01-01T00:00:00.000Z", providerGraceExpiresAt: null, providerObservedAt: new Date().toISOString() }) }, createContentPackages: (db) => new ContentPackageService(new FirestoreContentPackagePointerStore(db), gcs.storage) });
const root = await mkdtemp(join(tmpdir(), "patternly-content19-files-"));
try {
  await clearFirestore();
  const auth = await createRegisteredAuthUser(context);
  const packageRoot = resolve(frontendRoot, "../patternly-content/artifacts/premium-nodes", offer.trackId, offer.nodeId, offer.artifactSha256);
  const manifest = JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.artifactSha256, offer.artifactSha256);
  const compressed = await readFile(join(packageRoot, `${manifest.packageSha256}.gzip`));
  await new ContentPackageService(new FirestoreContentPackagePointerStore(context.db), gcs.storage).publish(manifest, compressed);
  let behavior = "normal", current = true, sequence = 0, activations = 0;
  const pointers = new Map(), calls = [];
  const files = {
    async write(path, bytes, overwrite = false) { const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: overwrite ? "w" : "wx" }); },
    async read(path) { try { return new Uint8Array(await readFile(join(root, path))); } catch (error) { if (error.code === "ENOENT") return null; throw error; } },
    async move(from, to) { await mkdir(dirname(join(root, to)), { recursive: true }); await rename(join(root, from), join(root, to)); },
    async remove(path) { await rm(join(root, path), { force: true }); },
    async list(prefix) { try { return (await readdir(join(root, prefix))).map((name) => `${prefix.replace(/\/$/u, "")}/${name}`); } catch (error) { if (error.code === "ENOENT") return []; throw error; } },
  };
  const assertCurrent = () => { if (!current) throw new NodePackageError("profile_changed"); };
  const makeStore = () => createNodePackageStore({ files, pointers: { getString: (key) => pointers.get(key), setString: (key, value) => pointers.set(key, value), remove: (key) => pointers.delete(key), getAllKeys: () => [...pointers.keys()] }, ids: { createId: () => `stage-${++sequence}` }, assertActivationAllowed: assertCurrent });
  const store = makeStore();
  const owner = new ContentPackageRuntimeOwner(() => "content19-profile", () => store.listActive(), (identity) => identity.artifactSha256 === offer.artifactSha256 ? offer : undefined, () => offer);
  const api = createPatternlyApiClient({ apiOrigin: "https://content19.test.invalid", getIdToken: async () => auth.idToken, getAppCheckToken: async () => TEST_APP_CHECK_TOKEN, fetchImplementation: async (url, init) => {
    const parsed = new URL(String(url)); calls.push(parsed.hostname);
    if (parsed.hostname === "content19.test.invalid") {
      const response = await context.app.inject({ method: "GET", url: parsed.pathname, headers: Object.fromEntries(new Headers(init.headers).entries()) });
      return new Response(response.body, { status: response.statusCode, headers: response.headers });
    }
    assert.equal(init.headers, undefined); assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error");
    if (behavior === "offline" || behavior === "interrupted") throw new Error(behavior);
    if (behavior === "profile") current = false;
    const bytes = Buffer.from(gcs.bytes.get(manifest.packagePath)); if (behavior === "hash") bytes[bytes.length - 1] ^= 1;
    return new Response(bytes, { headers: { "content-type": "application/gzip" } });
  } });
  const install = () => installNodePackage({ trackId: offer.trackId, nodeId: offer.nodeId, appVersion: "0.1.0", expectedContentVersion: offer.contentVersion, expectedArtifactSha256: offer.artifactSha256, hash: { sha256Bytes: async (bytes) => createHash("sha256").update(bytes).digest("hex") }, store, transport: { getNodePackage: (trackId, nodeId) => api.getContentPackage(trackId, nodeId, () => current) }, assertActivationAllowed: assertCurrent, activateRuntime: (record) => { activations++; owner.registerInstalledNodePackage(record, "content19-profile"); } });
  stage = "producer_route_client_verify_store_activate";
  const installed = await install();
  assert.deepEqual(await makeStore().getActive(offer.trackId, offer.nodeId), installed.identity);
  const resolved = await owner.resolveForPreparation({ trackId: offer.trackId, familyId: offer.familyId, modeId: offer.mode.modeId, nodeId: offer.nodeId });
  const prepared = await resolved.runtime.prepare({ trackId: offer.trackId, modeId: offer.mode.modeId, request: { sessionId: "content19-exact-session", requestedLength: 10, nodeId: offer.nodeId }, attempts: [], reviews: [], now: "2026-10-15T12:00:00.000Z" });
  assert.equal(prepared.session.itemOrder.length, 10);
  assert.equal(installed.payload.items.length, 123);
  assert.equal(prepared.session.contentVersion, offer.contentVersion); assert.equal(prepared.session.artifactSha256, offer.artifactSha256);
  assert.ok(prepared.session.itemOrder.every((item) => item.item.contentVersion === offer.contentVersion && item.item.artifactSha256 === offer.artifactSha256));
  const before = [...pointers.entries()];
  for (const [mode, code] of [["hash", "package_corrupt"], ["offline", "package_unavailable"], ["interrupted", "package_unavailable"], ["profile", "profile_changed"], ["access", "entitlement_required"]]) {
    stage = mode; behavior = mode; current = true; allowed = mode !== "access";
    await assert.rejects(install(), (error) => error instanceof NodePackageError && error.code === code);
    assert.deepEqual([...pointers.entries()], before); assert.equal(activations, 1);
  }
  current = true;
  const restarted = new ContentPackageRuntimeOwner(() => "content19-profile", () => makeStore().listActive(), () => offer, () => offer);
  const exact = await restarted.resolveExactArtifact({ trackId: offer.trackId, contentVersion: prepared.session.contentVersion, artifactSha256: prepared.session.artifactSha256 });
  assert.equal(exact.track.contentVersion, prepared.session.contentVersion);
  console.log(JSON.stringify({ result: "PASS", scope: "admitted whole-node producer123 questions -> real Auth/Firestore route -> production client/verifier/filesystem store/runtime -> exact session; modeled GCS, memory pointer, no native/provider acceptance", sessionItems: prepared.session.itemOrder.length, activations, negativeCases: 5, calls: calls.length }));
} catch (error) { throw new Error(`content_client_failed:${stage}`, { cause: error }); }
finally { await context.close(); await rm(root, { recursive: true, force: true }); }
