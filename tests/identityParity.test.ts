import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalJson, canonicalJsonBytes } from "../src/infrastructure/identity/canonicalJson.js";
import { recordFingerprintPayload } from "../src/infrastructure/identity/recordFingerprint.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";

/**
 * Read-only check of the backend copies of the shared identity profiles against
 * the app's parity contract (patternly/integration/contracts/identity-parity,
 * generated from the app's TS oracle). The backend never writes that file.
 */
type Vector = {
  id: string; profile: string; nativeApplicable: boolean; input: { json?: string };
  expect: { ok: true; output?: string; utf8ByteLength?: number; payload?: string; fingerprint?: string } | { ok: false; error: { name: string; message: string; code: string } };
};
const file = JSON.parse(readFileSync(new URL("../../patternly/integration/contracts/identity-parity/vectors.v1.json", import.meta.url), "utf8")) as { schema: string; vectors: Vector[] };
// JS-only vectors need values JSON cannot express; they are the app oracle's own regression set.
const jsonVectors = (profile: string) => file.vectors.filter((v) => v.profile === profile && v.input.json !== undefined);

// With the u flag a surrogate class matches only unpaired surrogates (a pair is one code point).
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

function outcome<T>(fn: () => T): { value?: T; error?: Error } {
  try { return { value: fn() }; } catch (error) { return { error: error as Error }; }
}

test("backend canonicalJson matches the app canonicalJsonV1 vectors", () => {
  assert.equal(file.schema, "patternly:identity-parity-vectors:v1");
  const vectors = jsonVectors("canonicalJsonV1");
  assert.ok(vectors.length > 100);
  for (const vector of vectors) {
    const result = outcome(() => { const value = JSON.parse(vector.input.json!); return { output: canonicalJson(value), bytes: canonicalJsonBytes(value) }; });
    if (vector.expect.ok) {
      assert.equal(result.error, undefined, `${vector.id}: ${String(result.error)}`);
      assert.equal(result.value!.output, vector.expect.output, vector.id);
      assert.equal(result.value!.bytes, vector.expect.utf8ByteLength, vector.id);
    } else {
      assert.ok(result.error instanceof TypeError, vector.id);
      assert.equal(result.error.message, vector.expect.error.code, vector.id);
    }
  }
});

test("backend record fingerprints match the app vectors byte for byte", () => {
  const vectors = jsonVectors("recordFingerprintPayload");
  assert.ok(vectors.length > 100);
  for (const vector of vectors) {
    const record = JSON.parse(vector.input.json!);
    const result = outcome(() => ({ payload: recordFingerprintPayload(record), fingerprint: createMergeRecordFingerprint(record) }));
    if (!vector.expect.ok) {
      assert.ok(result.error instanceof TypeError, vector.id);
      assert.equal(result.error.message, vector.expect.error.code, vector.id);
      continue;
    }
    assert.equal(result.error, undefined, `${vector.id}: ${String(result.error)}`);
    assert.equal(result.value!.payload, vector.expect.payload, vector.id);
    // JSON.stringify escapes unpaired surrogates, so the payload is well-formed and
    // Node crypto (which would replace them with U+FFFD) hashes the same bytes as the app.
    assert.ok(!UNPAIRED_SURROGATE.test(vector.expect.payload!), vector.id);
    assert.equal(result.value!.fingerprint, vector.expect.fingerprint, vector.id);
  }
});
