import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FirestoreAdminStore } from "../src/modules/admin/store.js";

const releaseId = "release-001";
const sourceRepositoryCommit = "a".repeat(40);
const artifact = (overrides: Record<string, unknown> = {}) => {
  const trackId = typeof overrides.trackId === "string" ? overrides.trackId : "track-001";
  const item = { id: "item-001", prompt: "What preserves the invariant?", interaction: { type: "choice", options: [{ id: "a", text: "Preserve the boundary" }], acceptedOptionIds: ["a"] }, feedback: { explanation: "Keep the boundary." }, taxonomy: { node: "invariants" }, constraints: { time: "O(n)" }, scoringContract: { kind: "exact" } };
  const artifactBytes = `${JSON.stringify({ envelopeVersion: 1, schemaVersion: "published-bank-v1", contentVersion: "v1", taxonomyVersion: "t1", bank: { trackId, familyId: "coding_interview", items: [item] } })}\n`;
  return { trackId, familyId: "coding_interview", contentVersion: "v1", taxonomyVersion: "t1", schemaVersion: "published-bank-v1", checksumSha256: createHash("sha256").update(artifactBytes, "utf8").digest("hex"), sourceRepositoryCommit, declaredModes: [], artifactBytes, ...overrides };
};

const manifest = (overrides: Record<string, unknown> = {}) => ({ envelopeVersion: 1, releaseId, sourceRepositoryCommit, ...overrides });

async function fixture(value: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patternly-admin-artifacts-"));
  await mkdir(join(root, "releases", releaseId), { recursive: true });
  await writeFile(join(root, "releases", releaseId, "release.json"), JSON.stringify(value));
  return root;
}

function instrumentCatalogLoader(store: FirestoreAdminStore, rejectFirst = false): Readonly<{ readonly calls: () => number; restore: () => void }> {
  const internal = store as unknown as { loadPublishedCatalog: () => Promise<unknown> };
  const original = internal.loadPublishedCatalog;
  let calls = 0;
  internal.loadPublishedCatalog = () => {
    calls += 1;
    if (rejectFirst && calls === 1) return Promise.reject(new Error("forced_catalog_load_failure"));
    return original.call(store);
  };
  return Object.freeze({ calls: () => calls, restore: () => { internal.loadPublishedCatalog = original; } });
}

test("a valid nonempty one-track release subset exposes complete question records", async () => {
  const root = await fixture({ manifest: manifest(), artifacts: [artifact()] });
  try {
    const store = new FirestoreAdminStore(null as never, root, releaseId);
    const result = await store.listQuestions({ page: 1, pageSize: 25 });
    assert.equal("unavailable" in result, false);
    if ("unavailable" in result) return;
    assert.equal(result.total, 1);
    assert.deepEqual(result.questions[0]?.constraints, { time: "O(n)" });
    assert.deepEqual(result.questions[0]?.scoringContract, { kind: "exact" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("malformed release manifests make the configured release unavailable", async () => {
  for (const invalidManifest of [{ releaseId }, manifest({ envelopeVersion: 2 }), manifest({ sourceRepositoryCommit: "a".repeat(39) })]) {
    const root = await fixture({ manifest: invalidManifest, artifacts: [artifact()] });
    try {
      const result = await new FirestoreAdminStore(null as never, root, releaseId).listQuestions({ page: 1, pageSize: 25 });
      assert.deepEqual(result, { unavailable: true, reason: "configured_release_invalid" });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("release artifacts must be nonempty, unique and bound to the manifest source commit", async () => {
  for (const value of [
    { manifest: manifest(), artifacts: [] },
    { manifest: manifest(), artifacts: [artifact({ sourceRepositoryCommit: "b".repeat(40) })] },
    { manifest: manifest(), artifacts: [artifact(), artifact()] },
  ]) {
    const root = await fixture(value);
    try {
      const result = await new FirestoreAdminStore(null as never, root, releaseId).listQuestions({ page: 1, pageSize: 25 });
      assert.deepEqual(result, { unavailable: true, reason: "configured_release_invalid" });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("corrupt checksums and malformed items make the complete configured release unavailable", async () => {
  for (const invalid of [artifact({ checksumSha256: "0".repeat(64) }), (() => { const value = artifact(); const envelope = JSON.parse(value.artifactBytes); envelope.bank.items = [{ id: "missing-prompt" }]; value.artifactBytes = `${JSON.stringify(envelope)}\n`; value.checksumSha256 = createHash("sha256").update(value.artifactBytes).digest("hex"); return value; })()]) {
    const root = await fixture({ manifest: manifest(), artifacts: [invalid] });
    try {
      const result = await new FirestoreAdminStore(null as never, root, releaseId).listQuestions({ page: 1, pageSize: 25 });
      assert.deepEqual(result, { unavailable: true, reason: "configured_release_invalid" });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("missing catalog configuration is explicit", async () => {
  const result = await new FirestoreAdminStore(null as never, undefined, undefined).listQuestions({ page: 1, pageSize: 25 });
  assert.deepEqual(result, { unavailable: true, reason: "canonical_package_inspection_not_configured" });
});

test("configured release paths cannot escape the canonical releases root", async () => {
  const root = await mkdtemp(join(tmpdir(), "patternly-admin-artifacts-"));
  const outside = await mkdtemp(join(tmpdir(), "patternly-admin-outside-"));
  try {
    await mkdir(join(root, "releases"), { recursive: true });
    await mkdir(join(outside, releaseId), { recursive: true });
    await writeFile(join(outside, releaseId, "release.json"), JSON.stringify({ manifest: manifest(), artifacts: [artifact()] }));
    await symlink(join(outside, releaseId), join(root, "releases", releaseId), "dir");
    const symlinkResult = await new FirestoreAdminStore(null as never, root, releaseId).listQuestions({ page: 1, pageSize: 25 });
    assert.deepEqual(symlinkResult, { unavailable: true, reason: "configured_release_invalid" });
    const traversalResult = await new FirestoreAdminStore(null as never, root, "..").listQuestions({ page: 1, pageSize: 25 });
    assert.deepEqual(traversalResult, { unavailable: true, reason: "configured_release_invalid" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("certification item shape is normalized for inspection while preserving its published fields", async () => {
  const item = { id: "cert-001", question: "Which control is required?", options: [{ id: "a", text: "A" }], correctOptionIds: ["a"], feedback: { explanation: "Because." }, domain: "security", examSignals: ["identity"], nodeId: "node-001", tags: ["iam"], type: "single_choice", itemFingerprint: "f".repeat(64) };
  const artifactBytes = `${JSON.stringify({ envelopeVersion: 1, schemaVersion: "published-bank-v1", contentVersion: "v1", taxonomyVersion: "t1", bank: { trackId: "cert-track", familyId: "certification", items: [item] } })}\n`;
  const certified = { trackId: "cert-track", familyId: "certification", contentVersion: "v1", taxonomyVersion: "t1", schemaVersion: "published-bank-v1", checksumSha256: createHash("sha256").update(artifactBytes).digest("hex"), sourceRepositoryCommit: "a".repeat(40), declaredModes: [], artifactBytes };
  const root = await fixture({ manifest: manifest(), artifacts: [certified] });
  try {
    const result = await new FirestoreAdminStore(null as never, root, releaseId).listQuestions({ page: 1, pageSize: 1 });
    assert.equal("unavailable" in result, false);
    if ("unavailable" in result) return;
    assert.equal(result.questions[0]?.prompt, item.question);
    assert.deepEqual(result.questions[0]?.interaction, { type: "choice", options: item.options, acceptedOptionIds: item.correctOptionIds });
    assert.deepEqual(result.questions[0]?.correctOptionIds, item.correctOptionIds);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("simultaneous catalog reads share one cold load and populate the cache", async () => {
  const root = await fixture({ manifest: manifest(), artifacts: [artifact()] });
  try {
    const store = new FirestoreAdminStore(null as never, root, releaseId);
    const loader = instrumentCatalogLoader(store);
    try {
      const requests = Array.from({ length: 8 }, () => store.listQuestions({ page: 1, pageSize: 25 }));
      const results = await Promise.all(requests);
      assert.equal(loader.calls(), 1);
      const cached = await store.listQuestions({ page: 1, pageSize: 25 });
      assert.equal(loader.calls(), 1);
      assert.equal("unavailable" in cached, false);
      results.forEach((result) => {
        assert.equal("unavailable" in result, false);
        if (!("unavailable" in result)) assert.equal(result.total, 1);
      });
    } finally { loader.restore(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a rejected cold load clears in-flight state before retrying", async () => {
  const root = await fixture({ manifest: manifest(), artifacts: [artifact()] });
  try {
    const store = new FirestoreAdminStore(null as never, root, releaseId);
    const loader = instrumentCatalogLoader(store, true);
    try {
      await assert.rejects(() => store.listQuestions({ page: 1, pageSize: 25 }), /forced_catalog_load_failure/u);
      const result = await store.listQuestions({ page: 1, pageSize: 25 });
      assert.equal("unavailable" in result, false);
      assert.equal(loader.calls(), 2);
    } finally { loader.restore(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("checksum-valid malformed answer options are rejected before rendering", async () => {
  for (const options of [[null], [{ id: "a", text: { invalid: true } }]]) {
    const value = artifact();
    const envelope = JSON.parse(value.artifactBytes);
    envelope.bank.items[0].interaction.options = options;
    value.artifactBytes = JSON.stringify(envelope);
    value.checksumSha256 = createHash("sha256").update(value.artifactBytes).digest("hex");
    const root = await fixture({ manifest: manifest(), artifacts: [value] });
    try {
      const result = await new FirestoreAdminStore(null as never, root, releaseId).listQuestions({ page: 1, pageSize: 25 });
      assert.deepEqual(result, { unavailable: true, reason: "configured_release_invalid" });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
