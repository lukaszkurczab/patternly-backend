import { writeFile } from "node:fs/promises";
import pg from "pg";

const { Client } = pg;
const authOrigin = process.env.PATTERNLY_FIREBASE_EMULATOR_ORIGIN ?? "http://127.0.0.1:9099";
const backendOrigin = process.env.PATTERNLY_BACKEND_ORIGIN ?? "http://127.0.0.1:8080";
const databaseUrl = process.env.DATABASE_URL;
const email = process.env.PATTERNLY_IOS_E2E_EMAIL ?? "ios-simulator@patternly.invalid";
const password = process.env.PATTERNLY_IOS_E2E_PASSWORD ?? "patternly-ios-e2e-password";
const envFile = process.env.PATTERNLY_E2E_ENV_FILE ?? "/private/tmp/patternly-ios-e2e.env";

if (!databaseUrl) throw new Error("DATABASE_URL is required for iOS simulator seed.");

const authenticate = async () => {
  const base = `${authOrigin}/identitytoolkit.googleapis.com/v1`;
  const body = JSON.stringify({ email, password, returnSecureToken: true });
  let response = await fetch(`${base}/accounts:signUp?key=patternly-ios-simulator`, { method: "POST", headers: { "content-type": "application/json" }, body });
  if (!response.ok) response = await fetch(`${base}/accounts:signInWithPassword?key=patternly-ios-simulator`, { method: "POST", headers: { "content-type": "application/json" }, body });
  if (!response.ok) throw new Error(`Firebase Auth Emulator did not issue a token: ${response.status}`);
  const payload = await response.json();
  if (typeof payload.idToken !== "string" || typeof payload.localId !== "string") throw new Error("Firebase Auth Emulator response is missing idToken or localId.");
  return payload.idToken;
};

const token = await authenticate();
const meResponse = await fetch(`${backendOrigin}/v1/me`, { headers: { authorization: `Bearer ${token}` } });
if (!meResponse.ok) throw new Error(`Backend user bootstrap failed: ${meResponse.status}`);
const me = await meResponse.json();
const userId = me?.user?.id;
if (typeof userId !== "string") throw new Error("Backend user bootstrap response is missing user id.");

const database = new Client({ connectionString: databaseUrl });
await database.connect();
try {
  await database.query(
    `INSERT INTO entitlements (user_id, entitlement, status, source)
     VALUES ($1, 'ios-simulator-e2e', 'active', 'ios-simulator-e2e')
     ON CONFLICT (user_id, entitlement) DO UPDATE SET status = EXCLUDED.status, source = EXCLUDED.source, updated_at = now()`,
    [userId],
  );
  await database.query(
    `INSERT INTO track_access (user_id, track_id, source, status)
     VALUES ($1, 'coding-interview-dsa-problem-solving', 'ios-simulator-e2e', 'active')
     ON CONFLICT (user_id, track_id) DO UPDATE SET source = EXCLUDED.source, status = EXCLUDED.status, updated_at = now()`,
    [userId],
  );
  await database.query(
    `INSERT INTO content_versions (track_id, version, checksum_sha256, package_uri, published_at, is_current)
     VALUES ('coding-interview-dsa-problem-solving', 'ios-simulator-e2e-v1', repeat('a', 64), 'http://127.0.0.1:8080/e2e/content/coding-interview-dsa-problem-solving', now(), true)
     ON CONFLICT (track_id, version) DO UPDATE SET is_current = EXCLUDED.is_current, updated_at = now()`,
  );
} finally {
  await database.end();
}

await writeFile(envFile, [
  "EXPO_PUBLIC_PATTERNLY_BACKEND_E2E=true",
  "EXPO_PUBLIC_PATTERNLY_API_ORIGIN=http://127.0.0.1:8080",
  `EXPO_PUBLIC_PATTERNLY_FIREBASE_AUTH_EMULATOR_ORIGIN=${authOrigin}`,
  `EXPO_PUBLIC_PATTERNLY_E2E_EMAIL=${email}`,
  `EXPO_PUBLIC_PATTERNLY_E2E_PASSWORD=${password}`,
  "",
].join("\n"), { encoding: "utf8", mode: 0o600 });

console.log(JSON.stringify({ email, envFile, userId }));
