import assert from "node:assert/strict";
import test from "node:test";
import { PseudonymKeyRing, parsePseudonymKeyRing } from "../src/infrastructure/security/pseudonymKeyRing.js";

const key = (byte: number) => Buffer.alloc(32, byte).toString("base64");

test("pseudonym key ring domain-separates identities and keeps old keys verify-only", () => {
  const ring = new PseudonymKeyRing([{ version: "v2", status: "active", keyBase64: key(2) }, { version: "v1", status: "verify_only", keyBase64: key(1) }]);
  const active = ring.active("firebase", "subject");
  assert.equal(active.keyVersion, "v2");
  assert.notEqual(active.subjectHmac, ring.active("apple", "subject").subjectHmac);
  const old = ring.candidates("firebase", "subject").find(({ keyVersion }) => keyVersion === "v1")!;
  assert.equal(ring.verify("firebase", "subject", old), true);
  assert.equal(ring.verify("firebase", "other", old), false);
  assert.equal(ring.candidates("firebase", "subject").length, 2);
});
test("pseudonym key ring fails closed for missing, duplicate, weak or multiple active keys", () => {
  for (const value of ["[]", "not-json", JSON.stringify([{ version: "v1", status: "active", keyBase64: "weak" }]), JSON.stringify([{ version: "v1", status: "active", keyBase64: key(1) }, { version: "v1", status: "verify_only", keyBase64: key(2) }]), JSON.stringify([{ version: "v1", status: "active", keyBase64: key(1) }, { version: "v2", status: "active", keyBase64: key(2) }])]) {
    assert.throws(() => parsePseudonymKeyRing(value), { message: "invalid_deletion_pseudonym_keyring" });
  }
});
