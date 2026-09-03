import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) {
  console.error("Lokalny backend wymaga Node.js 22.12+. Wybierz aktualny zainstalowany Node przed uruchomieniem npm run dev:admin.");
  process.exit(1);
}
const { initializeApp, deleteApp } = await import("firebase-admin/app");
const { getAuth } = await import("firebase-admin/auth");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const local = resolve(root, ".local/admin");
const data = resolve(local, "data");
const project = "demo-patternly-admin";
const authHost = "127.0.0.1:29199";
const firestoreHost = "127.0.0.1:28181";
const webOrigin = "http://127.0.0.1:25173";
const apiOrigin = "http://127.0.0.1:28080";
const credentialsPath = resolve(local, "credentials.json");
const children = [];
let stopping = false;
let app;
let release;
const stopped = new Promise((done) => { release = done; });
function requestStop(code = 0, error) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  if (error) console.error(error.message);
  release();
}
process.on("SIGINT", () => requestStop());
process.on("SIGTERM", () => requestStop());
process.on("SIGHUP", () => requestStop());
const ensureRunning = () => { if (stopping) throw new Error("local_admin_start_cancelled"); };

async function assertFree(port) {
  await new Promise((done, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Port ${port} jest zajęty. Nie zatrzymano istniejącego procesu.`)));
    server.listen(port, "127.0.0.1", () => server.close(done));
  });
}
async function waitFor(url, ready = (response) => response.ok) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    ensureRunning();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (ready(response)) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`Nie uruchomiono lokalnej usługi: ${url}`);
}
function start(name, command, args, options) {
  ensureRunning();
  const child = spawn(command, args, { stdio: "inherit", detached: process.platform !== "win32", ...options });
  children.push({ name, child });
  child.once("error", (error) => requestStop(1, error));
  child.once("exit", (code, signal) => {
    if (!stopping) requestStop(1, new Error(`${name} zakończył się nieoczekiwanie (${code ?? signal}).`));
  });
  return child;
}
async function stopChild({ name, child }) {
  if (child.exitCode !== null || child.signalCode || !child.pid) return;
  await new Promise((done) => {
    const timer = setTimeout(() => {
      console.error(`${name}: przekroczono czas zamykania; dane emulatorów mogą wymagać sprawdzenia.`);
      process.exitCode = 1;
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    }, name === "Firebase" ? 30000 : 5000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (name === "Firebase" && code !== 0) {
        console.error("Firebase nie potwierdził poprawnego zakończenia eksportu.");
        process.exitCode = 1;
      }
      done();
    });
    child.kill(name === "Firebase" ? "SIGINT" : "SIGTERM");
  });
}
function javaEnvironment() {
  const env = { ...process.env };
  const major = () => {
    const result = spawnSync("java", ["-version"], { env, encoding: "utf8" });
    return Number(`${result.stderr || ""}${result.stdout || ""}`.match(/version "(\d+)/)?.[1] || 0);
  };
  if (major() < 21 && process.platform === "darwin") {
    const result = spawnSync("/usr/libexec/java_home", ["-v", "21+"], { encoding: "utf8" });
    if (result.status === 0) {
      env.JAVA_HOME = result.stdout.trim();
      env.PATH = `${env.JAVA_HOME}/bin:${env.PATH}`;
    }
  }
  if (major() < 21) throw new Error("Emulatory wymagają Java 21+. Ustaw JAVA_HOME i PATH na zainstalowany JDK.");
  return env;
}
async function credentials(hasData) {
  let value;
  try { value = JSON.parse(await readFile(credentialsPath, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (hasData) throw new Error(`Zachowano dane emulatorów, ale brakuje ${credentialsPath}. Przywróć plik konta; nie zmieniono hasła.`);
    value = { email: "admin@local.patternly.test", password: randomBytes(24).toString("base64url") };
    await writeFile(credentialsPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }
  if (value.email !== "admin@local.patternly.test" || typeof value.password !== "string" || value.password.length < 20) {
    throw new Error(`Niepoprawny plik lokalnego konta: ${credentialsPath}. Nie został nadpisany.`);
  }
  await chmod(credentialsPath, 0o600);
  return value;
}

try {
  const emulatorEnvironment = javaEnvironment();
  await Promise.all([29199, 28181, 24410, 24510, 9152, 28080, 25173].map(assertFree));
  await mkdir(local, { recursive: true, mode: 0o700 });
  await chmod(local, 0o700);
  let hasData = false;
  try { await access(data); hasData = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (hasData) {
    try { await access(resolve(data, "firebase-export-metadata.json")); }
    catch { throw new Error(`Niekompletny eksport w ${data}. Start przerwany bez nadpisywania danych.`); }
  }
  const admin = await credentials(hasData);
  start("Firebase", "firebase", ["emulators:start", "--config", "firebase.admin-local.json", "--project", project,
    "--only", "auth,firestore", ...(hasData ? ["--import", data] : []), "--export-on-exit", data], { cwd: root, env: emulatorEnvironment });
  await waitFor(`http://${authHost}/`);
  await waitFor(`http://${firestoreHost}/`, (response) => response.status < 500);
  ensureRunning();
  // Provision only this launcher's emulator account; never use ambient cloud credentials.
  process.env.FIREBASE_AUTH_EMULATOR_HOST = authHost;
  process.env.FIRESTORE_EMULATOR_HOST = firestoreHost;
  app = initializeApp({ projectId: project }, "local-admin-launcher");
  const auth = getAuth(app);
  try {
    const existing = await auth.getUserByEmail(admin.email);
    if (!existing.emailVerified || existing.disabled) {
      await auth.updateUser(existing.uid, { emailVerified: true, disabled: false });
    }
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
    ensureRunning();
    await auth.createUser({ email: admin.email, password: admin.password, emailVerified: true });
  }
  const environment = { ...process.env, NODE_ENV: "development", HOST: "127.0.0.1", PORT: "28080", LOG_LEVEL: "info",
    FIREBASE_PROJECT_ID: project, FIREBASE_AUTH_ISSUER: `https://securetoken.google.com/${project}`,
    FIREBASE_AUTH_EMULATOR_HOST: authHost, FIRESTORE_EMULATOR_HOST: firestoreHost,
    ADMINISTRATOR_EMAIL: admin.email, ADMIN_WEB_ORIGIN: webOrigin,
    REPORT_RATE_LIMIT_HASH_SECRET: "local-admin-report-rate-limit-secret-0123456789" };
  start("API", process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: root, env: environment });
  await waitFor(`${apiOrigin}/ready`);
  start("Web", process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "25173", "--strictPort"], {
    cwd: resolve(root, "../patternly-web"), env: { ...environment, VITE_ADMIN_FIREBASE_API_KEY: "local-admin-key",
      VITE_ADMIN_FIREBASE_AUTH_DOMAIN: "localhost", VITE_ADMIN_FIREBASE_PROJECT_ID: project,
      VITE_ADMIN_FIREBASE_APP_ID: "local-admin", VITE_ADMIN_API_ORIGIN: apiOrigin,
      VITE_ADMIN_AUTH_EMULATOR_ORIGIN: `http://${authHost}` },
  });
  await waitFor(`${webOrigin}/admin`);
  console.log(`\nPanel: ${webOrigin}/admin\nKonto lokalne: ${credentialsPath}\nCtrl+C zatrzymuje usługi i zapisuje dane emulatorów.\n`);
  await stopped;
} catch (error) {
  if (!stopping) requestStop(1, error);
} finally {
  stopping = true;
  for (const child of children.reverse()) await stopChild(child);
  if (app) await deleteApp(app);
}
