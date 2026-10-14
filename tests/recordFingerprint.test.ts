import assert from "node:assert/strict";
import test from "node:test";
import { recordFingerprintPayload, RECORD_FINGERPRINT_PROFILE } from "../src/infrastructure/identity/recordFingerprint.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { canonicalJson } from "../src/infrastructure/identity/canonicalJson.js";

const record = { recordId: "result", recordType: "training_session_result" as const, trackId: "backend-system-design-interview", state: { answer: "Cafe\u0301", number: 1e21 } };

test("record fingerprints preserve exact Unicode and use a separate profile from envelopes", () => {
  assert.equal(RECORD_FINGERPRINT_PROFILE, "record-fingerprint-json-utf8-v1");
  assert.equal(recordFingerprintPayload(record), '{"recordId":"result","recordType":"training_session_result","state":{"answer":"Café","number":1e+21},"trackId":"backend-system-design-interview"}');
  assert.notEqual(recordFingerprintPayload(record), canonicalJson(record));
  assert.notEqual(createMergeRecordFingerprint(record), createMergeRecordFingerprint({ ...record, state: { ...record.state, answer: "Café" } }));
});

test("unsupported values and colliding NFC keys fail explicitly", () => {
  const sparse = new Array(1);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const value of [undefined, NaN, Infinity, 1n, Symbol("x"), () => 1, new Date(), sparse, cycle, { "é": 1, "e\u0301": 2 }]) {
    assert.throws(() => recordFingerprintPayload({ ...record, state: { nested: value } }), TypeError);
  }
});
