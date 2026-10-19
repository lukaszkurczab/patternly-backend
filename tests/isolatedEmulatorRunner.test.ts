import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveIsolatedEmulatorPorts, validateIsolatedEmulatorConfiguration, validateIsolatedEmulatorRuntime } from "../scripts/isolated-emulator-test-runner.mjs";

const projectId = "demo-patternly-b4-crash";
const runtime = (authPort = 19119, firestorePort = 18119, project = projectId) => ({
  FIREBASE_PROJECT_ID: project,
  FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${authPort}`,
  FIRESTORE_EMULATOR_HOST: `127.0.0.1:${firestorePort}`,
});

test("isolated runner and B4 runtime guards share default and explicit-base ports", async () => {
  const canonical = JSON.parse(await readFile(new URL("../config/firebase.isolated-tests.json", import.meta.url), "utf8"));
  const defaults = resolveIsolatedEmulatorPorts();
  assert.deepEqual(defaults, { auth: 19119, firestore: 18119, hub: 4419, logging: 4519 });
  assert.doesNotThrow(() => validateIsolatedEmulatorConfiguration(canonical, projectId, defaults));
  assert.doesNotThrow(() => validateIsolatedEmulatorRuntime(runtime(defaults.auth, defaults.firestore), projectId));

  const override = resolveIsolatedEmulatorPorts("29119");
  assert.deepEqual(override, { auth: 29119, firestore: 29120, hub: 29121, logging: 29122 });
  const overriddenConfig = structuredClone(canonical);
  for (const [name, port] of Object.entries(override)) overriddenConfig.emulators[name].port = port;
  assert.doesNotThrow(() => validateIsolatedEmulatorConfiguration(overriddenConfig, projectId, override));
  assert.doesNotThrow(() => validateIsolatedEmulatorRuntime({
    ...runtime(override.auth, override.firestore), PATTERNLY_ISOLATED_TEST_PORT_BASE: "29119",
  }, projectId));
});

test("B4 runtime guard rejects invalid base, mismatched ports, foreign project, and non-loopback before SDK setup", () => {
  for (const base of ["bad", "9999", "65533", "99999"]) {
    assert.throws(() => resolveIsolatedEmulatorPorts(base), /unsafe_port_configuration/u);
  }
  assert.deepEqual(resolveIsolatedEmulatorPorts("10000"), { auth: 10000, firestore: 10001, hub: 10002, logging: 10003 });
  assert.deepEqual(resolveIsolatedEmulatorPorts("65532"), { auth: 65532, firestore: 65533, hub: 65534, logging: 65535 });
  assert.throws(() => validateIsolatedEmulatorRuntime(runtime(19119, 19120), projectId), /unsafe_port_configuration/u);
  assert.throws(() => validateIsolatedEmulatorRuntime(runtime(19119, 18119, "patternly-app-sandbox"), "patternly-app-sandbox"), /demo_project_required/u);
  assert.throws(() => validateIsolatedEmulatorRuntime(runtime(19119, 18119, "demo-patternly-other"), projectId), /demo_project_required/u);
  assert.throws(() => validateIsolatedEmulatorRuntime({ ...runtime(), FIRESTORE_EMULATOR_HOST: "0.0.0.0:18119" }, projectId), /unsafe_port_configuration/u);
  assert.throws(() => validateIsolatedEmulatorRuntime({ ...runtime(), PATTERNLY_ISOLATED_TEST_PORT_BASE: "bad" }, projectId), /unsafe_port_configuration/u);
});

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
