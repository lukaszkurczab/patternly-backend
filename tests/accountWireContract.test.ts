import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("backend vendors the canonical app wire guard without drift", () => {
  const canonical = readFileSync(new URL("../../patternly/src/domain/account/accountWireState.ts", import.meta.url), "utf8");
  assert.equal(readFileSync(new URL("../src/modules/progress/accountWireState.ts", import.meta.url), "utf8"), canonical);
});
