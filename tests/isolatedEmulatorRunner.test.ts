import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateIsolatedEmulatorConfiguration } from "../scripts/isolated-emulator-test-runner.mjs";

test("isolated gate accepts the canonical configuration and rejects shared projects or dangerous config drift", async () => {
  const canonical = JSON.parse(await readFile(new URL("../config/firebase.isolated-tests.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => validateIsolatedEmulatorConfiguration(canonical, "demo-patternly-ops-b2"));
  assert.throws(() => validateIsolatedEmulatorConfiguration(canonical, "patternly-app-sandbox"), /demo_project_required/u);
  for (const change of [
    (config: typeof canonical) => { config.emulators.auth.port = 19099; },
    (config: typeof canonical) => { config.emulators.firestore.port = 19119; },
    (config: typeof canonical) => { config.emulators.firestore.host = "0.0.0.0"; },
    (config: typeof canonical) => { config.emulators.ui.enabled = true; },
    (config: typeof canonical) => { config.emulators.singleProjectMode = true; },
  ]) {
    const drift = structuredClone(canonical);
    change(drift);
    assert.throws(() => validateIsolatedEmulatorConfiguration(drift, "demo-patternly-ops-b2"), /unsafe_/u);
  }
});
