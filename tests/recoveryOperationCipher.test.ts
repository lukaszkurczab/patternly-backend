import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRecoveryOperationCipherKeyRing,
  RecoveryOperationCipher,
  type RecoveryOperationCipherContext,
} from "../src/modules/account-lifecycle/recoveryOperationCipher.js";

const key = (byte: number) => Buffer.alloc(32, byte).toString("base64");
const context: RecoveryOperationCipherContext = Object.freeze({
  generation: 7,
  kind: "recovery",
  operationId: "123e4567-e89b-42d3-a456-426614174000",
  userId: "user-123",
});
const activeRing = () => new RecoveryOperationCipher([{ keyBase64: key(1), status: "active", version: "v1" }]);

test("recovery operation cipher round-trips plaintext and generates a fresh 96-bit IV", () => {
  const cipher = activeRing();
  const first = cipher.encrypt("sensitive recovery operation", context);
  const second = cipher.encrypt("sensitive recovery operation", context);
  assert.equal(cipher.decrypt(first, context), "sensitive recovery operation");
  assert.notEqual(first.iv, second.iv);
  assert.equal(Buffer.from(first.iv, "base64").length, 12);
  assert.equal(Buffer.from(first.tag, "base64").length, 16);
  assert.equal(first.version, 1);
  assert.equal(first.keyVersion, "v1");
  assert.ok(Object.isFrozen(first));
});

test("recovery operation cipher authenticates every operation identity field and key version", () => {
  const cipher = new RecoveryOperationCipher([
    { keyBase64: key(2), status: "active", version: "v2" },
    { keyBase64: key(1), status: "decrypt_only", version: "v1" },
  ]);
  const envelope = cipher.encrypt("value", context);
  const mismatches: RecoveryOperationCipherContext[] = [
    { ...context, userId: "another-user" },
    { ...context, operationId: "123e4567-e89b-42d3-a456-426614174001" },
    { ...context, kind: "reissue" },
    { ...context, generation: 8 },
  ];
  for (const mismatch of mismatches) assert.throws(() => cipher.decrypt(envelope, mismatch), { message: "recovery_operation_decryption_failed" });
  assert.throws(() => cipher.decrypt({ ...envelope, keyVersion: "v1" }, context), { message: "recovery_operation_decryption_failed" });
  assert.throws(() => cipher.decrypt({ ...envelope, version: 2 }, context), { message: "invalid_recovery_operation_envelope" });
});

test("recovery operation cipher rejects ciphertext, tag, and authenticated-envelope tampering", () => {
  const cipher = activeRing();
  const envelope = cipher.encrypt("private", context);
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  ciphertext[0] = ciphertext[0]! ^ 1;
  const tag = Buffer.from(envelope.tag, "base64");
  tag[0] = tag[0]! ^ 1;
  for (const tampered of [
    { ...envelope, ciphertext: ciphertext.toString("base64") },
    { ...envelope, tag: tag.toString("base64") },
    { ...envelope, extra: "unbound" },
    { ...envelope, iv: Buffer.alloc(12, 2).toString("base64") },
  ]) assert.throws(() => cipher.decrypt(tampered, context), { message: /^(?:invalid_recovery_operation_envelope|recovery_operation_decryption_failed)$/u });
});

test("versioned keyring rejects malformed, weak, duplicate, and reused key material", () => {
  const malformed = [
    "not-json",
    JSON.stringify({ version: 2, keys: [{ keyBase64: key(1), status: "active", version: "v1" }] }),
    JSON.stringify({ version: 1, keys: [{ keyBase64: key(1), status: "active", version: "v1" }, { keyBase64: key(2), status: "active", version: "v2" }] }),
    JSON.stringify({ version: 1, keys: [{ keyBase64: key(1), status: "active", version: "v1" }, { keyBase64: key(2), status: "decrypt_only", version: "v1" }] }),
    JSON.stringify({ version: 1, keys: [{ keyBase64: Buffer.alloc(31, 1).toString("base64"), status: "active", version: "v1" }] }),
    JSON.stringify({ version: 1, keys: [{ keyBase64: `${key(1)}=`, status: "active", version: "v1" }] }),
    JSON.stringify({ version: 1, keys: [{ keyBase64: key(1), status: "active", version: "v1" }, { keyBase64: key(1), status: "decrypt_only", version: "v0" }] }),
    JSON.stringify({ version: 1, keys: [{ keyBase64: key(1), status: "unknown", version: "v1" }] }),
    JSON.stringify({ version: 1, keys: [{ keyBase64: key(1), status: "active", version: "v1", extra: true }] }),
  ];
  for (const value of malformed) assert.throws(() => parseRecoveryOperationCipherKeyRing(value), { message: "invalid_recovery_operation_keyring" });
});

test("recovery operation cipher retains old decrypt keys during explicit key rotation", () => {
  const oldCipher = new RecoveryOperationCipher([{ keyBase64: key(4), status: "active", version: "v1" }]);
  const envelope = oldCipher.encrypt("rotation-safe", context);
  const rotated = parseRecoveryOperationCipherKeyRing(JSON.stringify({
    keys: [
      { keyBase64: key(5), status: "active", version: "v2" },
      { keyBase64: key(4), status: "decrypt_only", version: "v1" },
    ],
    version: 1,
  }));
  assert.equal(rotated.decrypt(envelope, context), "rotation-safe");
  assert.equal(rotated.encrypt("new-value", context).keyVersion, "v2");
  assert.throws(() => new RecoveryOperationCipher([{ keyBase64: key(5), status: "active", version: "v2" }]).decrypt(envelope, context), { message: "recovery_operation_key_unavailable" });
});

test("operation context and unknown key versions fail with neutral codes", () => {
  const cipher = activeRing();
  assert.throws(() => cipher.encrypt("value", { ...context, generation: 0 }), { message: "invalid_recovery_operation_context" });
  assert.throws(() => cipher.encrypt("value", { ...context, operationId: "not-a-uuid" }), { message: "invalid_recovery_operation_context" });
  const envelope = cipher.encrypt("value", context);
  assert.throws(() => cipher.decrypt({ ...envelope, keyVersion: "v9" }, context), { message: "recovery_operation_key_unavailable" });
  assert.throws(() => cipher.decrypt({ ...envelope, ciphertext: "%%%=" }, context), { message: "invalid_recovery_operation_envelope" });
});
