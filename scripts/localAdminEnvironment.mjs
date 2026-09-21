export const LOCAL_ADMIN_CONTRACT = Object.freeze({
  project: "demo-patternly-admin",
  authEmulatorHost: "127.0.0.1:29199",
  firestoreEmulatorHost: "127.0.0.1:28181",
  webOrigin: "http://127.0.0.1:25173",
  apiOrigin: "http://127.0.0.1:28080",
});

// This key is intentionally fixed and local-only. It is not a production secret.
export const LOCAL_ADMIN_DELETION_PSEUDONYM_KEYS_JSON = JSON.stringify([
  { version: "local-v1", status: "active", keyBase64: Buffer.alloc(32, 0x6c).toString("base64") },
]);

function assertLocalAdminBoundary(environment) {
  if (
    environment.NODE_ENV !== "development"
    || environment.HOST !== "127.0.0.1"
    || environment.FIREBASE_PROJECT_ID !== LOCAL_ADMIN_CONTRACT.project
    || environment.FIREBASE_AUTH_EMULATOR_HOST !== LOCAL_ADMIN_CONTRACT.authEmulatorHost
    || environment.FIRESTORE_EMULATOR_HOST !== LOCAL_ADMIN_CONTRACT.firestoreEmulatorHost
    || environment.ADMIN_WEB_ORIGIN !== LOCAL_ADMIN_CONTRACT.webOrigin
    || environment.PUBLIC_PRIVACY_ORIGIN !== LOCAL_ADMIN_CONTRACT.webOrigin
  ) throw new Error("local_admin_boundary_invalid");
}

export function buildLocalAdminEnvironment(source, values) {
  const environment = {
    ...source,
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: "28080",
    LOG_LEVEL: "info",
    FIREBASE_PROJECT_ID: LOCAL_ADMIN_CONTRACT.project,
    FIREBASE_AUTH_ISSUER: `https://securetoken.google.com/${LOCAL_ADMIN_CONTRACT.project}`,
    FIREBASE_AUTH_EMULATOR_HOST: LOCAL_ADMIN_CONTRACT.authEmulatorHost,
    FIRESTORE_EMULATOR_HOST: LOCAL_ADMIN_CONTRACT.firestoreEmulatorHost,
    ADMINISTRATOR_EMAIL: values.adminEmail,
    ADMIN_WEB_ORIGIN: LOCAL_ADMIN_CONTRACT.webOrigin,
    ADMIN_CONTENT_ROOT: values.adminContentRoot,
    ADMIN_CONTENT_RELEASE_ID: values.adminContentReleaseId,
    REPORT_RATE_LIMIT_HASH_SECRET: "local-admin-report-rate-limit-secret-0123456789",
    DELETION_PSEUDONYM_KEYS_JSON: LOCAL_ADMIN_DELETION_PSEUDONYM_KEYS_JSON,
    PRIVACY_RESPONSE_KEY_BASE64: Buffer.alloc(32, 11).toString("base64"),
    PRIVACY_AUDIT_HMAC_SECRET: "local-admin-privacy-audit-hmac-secret-0123456789",
    PUBLIC_PRIVACY_ORIGIN: LOCAL_ADMIN_CONTRACT.webOrigin,
  };
  assertLocalAdminBoundary(environment);
  return Object.freeze(environment);
}
