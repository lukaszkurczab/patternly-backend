import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_PORTS = Object.freeze({ auth: 19119, firestore: 18119, hub: 4419, logging: 4519 });

export function resolveIsolatedEmulatorPorts(baseValue) {
  if (baseValue === undefined || baseValue === "") return DEFAULT_PORTS;
  if (typeof baseValue !== "string" || !/^\d{4,5}$/u.test(baseValue)) throw new Error("isolated_test_unsafe_port_configuration");
  const base = Number(baseValue);
  if (!Number.isSafeInteger(base) || base < 10000 || base > 65532) throw new Error("isolated_test_unsafe_port_configuration");
  return Object.freeze({ auth: base, firestore: base + 1, hub: base + 2, logging: base + 3 });
}

export function validateIsolatedEmulatorConfiguration(config, projectId, ports = resolveIsolatedEmulatorPorts()) {
  if (!/^demo-[a-z0-9-]+$/u.test(projectId)) throw new Error("isolated_test_demo_project_required");
  if (config?.emulators?.ui?.enabled !== false || config.emulators.singleProjectMode !== false) throw new Error("isolated_test_unsafe_emulator_configuration");
  for (const [name, port] of Object.entries(ports)) {
    const endpoint = config.emulators[name];
    if (endpoint?.host !== "127.0.0.1" || endpoint.port !== port) throw new Error("isolated_test_unsafe_port_configuration");
  }
}

export function validateIsolatedEmulatorRuntime(environment, projectId, ports = resolveIsolatedEmulatorPorts(environment.PATTERNLY_ISOLATED_TEST_PORT_BASE)) {
  if (!/^demo-[a-z0-9-]+$/u.test(projectId) || environment.FIREBASE_PROJECT_ID !== projectId) throw new Error("isolated_test_demo_project_required");
  if (environment.FIREBASE_AUTH_EMULATOR_HOST !== `127.0.0.1:${ports.auth}`
    || environment.FIRESTORE_EMULATOR_HOST !== `127.0.0.1:${ports.firestore}`) throw new Error("isolated_test_unsafe_port_configuration");
}

export async function runIsolatedEmulatorTests({ backendRoot, projectId, command, environment = {}, timeoutMs }) {
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000 || process.platform === "win32")) throw new Error("isolated_test_invalid_deadline");
  const ports = resolveIsolatedEmulatorPorts(environment.PATTERNLY_ISOLATED_TEST_PORT_BASE ?? process.env.PATTERNLY_ISOLATED_TEST_PORT_BASE);
  const config = JSON.parse(await readFile(join(backendRoot, "config/firebase.isolated-tests.json"), "utf8"));
  for (const [name, port] of Object.entries(ports)) config.emulators[name].port = port;
  validateIsolatedEmulatorConfiguration(config, projectId, ports);
  for (const port of Object.values(ports)) {
    await new Promise((accept, reject) => {
      const server = createServer();
      server.once("error", () => reject(new Error(`isolated_test_port_busy:${port}`)));
      server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : accept()));
    });
  }
  const directory = await mkdtemp(join(tmpdir(), "patternly-isolated-gate-"));
  try {
    config.firestore = { rules: join(backendRoot, "firestore.rules"), indexes: join(backendRoot, "firestore.indexes.json") };
    const configPath = join(directory, "firebase.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const env = {
      ...process.env, ...environment,
      XDG_CONFIG_HOME: join(directory, "cli-config"), NO_UPDATE_NOTIFIER: "1",
      FIREBASE_PROJECT_ID: projectId, GOOGLE_CLOUD_PROJECT: projectId, GCLOUD_PROJECT: projectId,
      FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${ports.auth}`,
      FIRESTORE_EMULATOR_HOST: `127.0.0.1:${ports.firestore}`,
    };
    console.log(`Isolated emulator gate: ${projectId} Auth${ports.auth}/Firestore${ports.firestore}`);
    return await new Promise((accept, reject) => {
      // A bounded POSIX run owns its process group, including emulator children.
      const child = spawn(process.env.FIREBASE_CLI ?? "firebase", ["emulators:exec", "--config", configPath, "--project", projectId, "--only", "auth,firestore", command], { cwd: backendRoot, env, stdio: "inherit", detached: timeoutMs !== undefined });
      let expired = false;
      let killTimer;
      const signalGroup = (signal) => { try { if (child.pid) process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } };
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        expired = true;
        console.error("isolated_test_deadline_exceeded");
        signalGroup("SIGTERM");
        // Keep the group cleanup alive even if the CLI exits before Java.
        killTimer = setTimeout(() => { signalGroup("SIGKILL"); accept(124); }, 5_000);
      }, timeoutMs);
      child.once("error", (error) => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (!expired) accept(code ?? (signal ? 1 : 0));
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
