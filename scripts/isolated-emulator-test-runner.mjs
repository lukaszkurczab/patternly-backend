import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORTS = Object.freeze({ auth: 19119, firestore: 18119, hub: 4419, logging: 4519 });

export function validateIsolatedEmulatorConfiguration(config, projectId) {
  if (!/^demo-[a-z0-9-]+$/u.test(projectId)) throw new Error("isolated_test_demo_project_required");
  if (config?.emulators?.ui?.enabled !== false || config.emulators.singleProjectMode !== false) throw new Error("isolated_test_unsafe_emulator_configuration");
  for (const [name, port] of Object.entries(PORTS)) {
    const endpoint = config.emulators[name];
    if (endpoint?.host !== "127.0.0.1" || endpoint.port !== port) throw new Error("isolated_test_unsafe_port_configuration");
  }
}

export async function runIsolatedEmulatorTests({ backendRoot, projectId, command, environment = {} }) {
  const config = JSON.parse(await readFile(join(backendRoot, "config/firebase.isolated-tests.json"), "utf8"));
  validateIsolatedEmulatorConfiguration(config, projectId);
  for (const port of Object.values(PORTS)) {
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
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:19119",
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:18119",
    };
    console.log(`Isolated emulator gate: ${projectId} Auth19119/Firestore18119`);
    return await new Promise((accept, reject) => {
      const child = spawn(process.env.FIREBASE_CLI ?? "firebase", ["emulators:exec", "--config", configPath, "--project", projectId, "--only", "auth,firestore", command], { cwd: backendRoot, env, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code, signal) => accept(code ?? (signal ? 1 : 0)));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
