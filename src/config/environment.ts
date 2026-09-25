import { z } from "zod";
import { parseOperatorAllowlist, type OperatorAllowlistEntry } from "../modules/operator-access/contracts.js";

export const ADMIN_CONTENT_RELEASE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  FIREBASE_PROJECT_ID: z.string().regex(/^[a-z0-9-]+$/u).optional(),
  FIREBASE_AUTH_ISSUER: z.string().url().optional(),
  FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
  FIRESTORE_EMULATOR_HOST: z.string().optional(),
  ADMINISTRATOR_EMAIL: z.string().email().optional(),
  ADMIN_WEB_ORIGIN: z.string().optional(),
  OPERATOR_OIDC_ISSUER: z.string().url().optional(),
  OPERATOR_OIDC_AUDIENCE: z.string().trim().min(1).max(512).optional(),
  OPERATOR_OIDC_JWKS_URL: z.string().url().optional(),
  OPERATOR_ALLOWLIST_JSON: z.string().min(1).optional(),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().refine((value) => value === 465 || value === 587).optional(),
  SMTP_USERNAME: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  SMTP_FROM_EMAIL: z.string().email().optional(),
  SMTP_FROM_NAME: z.string().trim().min(1).max(128).optional(),
  SMTP_REPLY_TO: z.string().email().optional(),
  REPORT_RATE_LIMIT_HASH_SECRET: z.string().min(32),
  DELETION_PSEUDONYM_KEYS_JSON: z.string().min(1),
  REPORT_RATE_LIMIT_MAX: z.coerce.number().int().positive().max(100).default(5),
  REPORT_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().max(86_400).default(3_600),
  ACCOUNT_DATA_EXPORT_RATE_LIMIT_MAX: z.coerce.number().int().positive().max(100).default(3),
  ACCOUNT_DATA_EXPORT_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().max(86_400).default(3_600),
  ACCOUNT_DATA_EXPORT_MAX_SERIALIZED_BYTES: z.coerce.number().int().positive().max(50 * 1024 * 1024).default(5 * 1024 * 1024),
  PRIVACY_RESPONSE_KEY_BASE64: z.string().min(1),
  PRIVACY_AUDIT_HMAC_SECRET: z.string().min(32),
  REVENUECAT_API_BASE_URL: z.string().url().default("https://api.revenuecat.com"),
  REVENUECAT_READ_API_KEY: z.string().min(1).optional(),
  REVENUECAT_WEBHOOK_SECRET: z.string().min(1).optional(),
  REVENUECAT_APP_ID: z.string().min(1).optional(),
  REVENUECAT_ENTITLEMENT_ID: z.string().min(1).optional(),
  REVENUECAT_PRODUCT_ID: z.string().min(1).optional(),
  REVENUECAT_WEBHOOK_ENVIRONMENT: z.enum(["PRODUCTION", "SANDBOX"]).optional(),
  CONTENT_CATALOG_ORIGIN: z.string().url().optional(),
  ADMIN_CONTENT_ROOT: z.string().min(1).optional(),
  ADMIN_CONTENT_RELEASE_ID: z.string().regex(ADMIN_CONTENT_RELEASE_ID_PATTERN).optional(),
  CONTENT_PACKAGE_LOCAL_ROOT: z.string().min(1).optional(),
});

export type Environment = Readonly<{
  nodeEnv: "development" | "test" | "production";
  port: number;
  host: string;
  logLevel: string;
  firebaseProjectId: string | undefined;
  firebaseAuthIssuer: string | undefined;
  administratorEmail: string | undefined;
  adminWebOrigin: string | undefined;
  operatorAccess: Readonly<{
    issuer: string;
    audience: string;
    jwksUrl: string;
    operators: readonly OperatorAllowlistEntry[];
  }> | null;
  smtp: Readonly<{ host: string; port: 465 | 587; username: string; password: string; fromEmail: string; fromName: string; replyTo: string | undefined }> | null;
  reportRateLimitHashSecret: string;
  deletionPseudonymKeysJson: string;
  reportRateLimitMax: number;
  reportRateLimitWindowSeconds: number;
  accountDataExportRateLimitMax: number;
  accountDataExportRateLimitWindowSeconds: number;
  accountDataExportMaxSerializedBytes: number;
  privacyResponseKeyBase64: string;
  privacyAuditHmacSecret: string;
  revenueCatApiBaseUrl: string;
  revenueCatReadApiKey: string | undefined;
  revenueCatWebhookSecret: string | undefined;
  revenueCatAppId: string | undefined;
  revenueCatEntitlementId: string | undefined;
  revenueCatProductId: string | undefined;
  revenueCatWebhookEnvironment: "PRODUCTION" | "SANDBOX" | undefined;
  contentCatalogOrigin: string | undefined;
  adminContentRoot: string | undefined;
  adminContentReleaseId: string | undefined;
  contentPackageLocalRoot: string | undefined;
}>;

export function loadEnvironment(source: NodeJS.ProcessEnv): Environment {
  const parsed = environmentSchema.safeParse(source);
  if (!parsed.success) throw new Error(`invalid_environment:${parsed.error.issues.map((issue) => issue.path.join(".")).join(",")}`);
  const value = parsed.data;
  if (value.NODE_ENV === "production") {
    if (!value.FIREBASE_PROJECT_ID || !value.FIREBASE_AUTH_ISSUER) throw new Error("production_firebase_config_required");
    if (value.FIREBASE_AUTH_EMULATOR_HOST !== undefined || value.FIRESTORE_EMULATOR_HOST !== undefined) {
      throw new Error("production_firebase_emulator_config_forbidden");
    }
    if (!smtpConfiguration(value)) throw new Error("production_smtp_config_required");
    if (!value.REVENUECAT_WEBHOOK_SECRET || !value.REVENUECAT_APP_ID || !value.REVENUECAT_ENTITLEMENT_ID || !value.REVENUECAT_PRODUCT_ID || !value.REVENUECAT_WEBHOOK_ENVIRONMENT) throw new Error("production_revenuecat_config_required");
    if (value.CONTENT_PACKAGE_LOCAL_ROOT !== undefined) throw new Error("production_local_content_package_storage_forbidden");
  }
  const adminWebOrigin = parseAdminWebOrigin(value);
  const operatorAccess = parseOperatorAccess(value);
  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    host: value.HOST,
    logLevel: value.LOG_LEVEL,
    firebaseProjectId: value.FIREBASE_PROJECT_ID,
    firebaseAuthIssuer: value.FIREBASE_AUTH_ISSUER,
    administratorEmail: value.ADMINISTRATOR_EMAIL?.toLowerCase(),
    adminWebOrigin,
    operatorAccess,
    smtp: smtpConfiguration(value),
    reportRateLimitHashSecret: value.REPORT_RATE_LIMIT_HASH_SECRET,
    deletionPseudonymKeysJson: value.DELETION_PSEUDONYM_KEYS_JSON,
    reportRateLimitMax: value.REPORT_RATE_LIMIT_MAX,
    reportRateLimitWindowSeconds: value.REPORT_RATE_LIMIT_WINDOW_SECONDS,
    accountDataExportRateLimitMax: value.ACCOUNT_DATA_EXPORT_RATE_LIMIT_MAX,
    accountDataExportRateLimitWindowSeconds: value.ACCOUNT_DATA_EXPORT_RATE_LIMIT_WINDOW_SECONDS,
    accountDataExportMaxSerializedBytes: value.ACCOUNT_DATA_EXPORT_MAX_SERIALIZED_BYTES,
    privacyResponseKeyBase64: value.PRIVACY_RESPONSE_KEY_BASE64,
    privacyAuditHmacSecret: value.PRIVACY_AUDIT_HMAC_SECRET,
    revenueCatApiBaseUrl: value.REVENUECAT_API_BASE_URL,
    revenueCatReadApiKey: value.REVENUECAT_READ_API_KEY,
    revenueCatWebhookSecret: value.REVENUECAT_WEBHOOK_SECRET,
    revenueCatAppId: value.REVENUECAT_APP_ID,
    revenueCatEntitlementId: value.REVENUECAT_ENTITLEMENT_ID,
    revenueCatProductId: value.REVENUECAT_PRODUCT_ID,
    revenueCatWebhookEnvironment: value.REVENUECAT_WEBHOOK_ENVIRONMENT,
    contentCatalogOrigin: value.CONTENT_CATALOG_ORIGIN,
    adminContentRoot: value.ADMIN_CONTENT_ROOT,
    adminContentReleaseId: value.ADMIN_CONTENT_RELEASE_ID,
    contentPackageLocalRoot: value.CONTENT_PACKAGE_LOCAL_ROOT,
  });
}

function parseOperatorAccess(value: z.infer<typeof environmentSchema>): Environment["operatorAccess"] {
  const fields = [value.OPERATOR_OIDC_ISSUER, value.OPERATOR_OIDC_AUDIENCE, value.OPERATOR_OIDC_JWKS_URL, value.OPERATOR_ALLOWLIST_JSON];
  if (fields.every((field) => field === undefined)) return null;
  if (fields.some((field) => field === undefined)) throw new Error("invalid_operator_oidc_config");
  const issuer = parsePinnedHttpsUrl(value.OPERATOR_OIDC_ISSUER!, "invalid_operator_oidc_issuer", true);
  const jwksUrl = parsePinnedHttpsUrl(value.OPERATOR_OIDC_JWKS_URL!, "invalid_operator_oidc_jwks_url", false);
  return Object.freeze({
    issuer,
    audience: value.OPERATOR_OIDC_AUDIENCE!,
    jwksUrl,
    operators: parseOperatorAllowlist(value.OPERATOR_ALLOWLIST_JSON!),
  });
}

function parsePinnedHttpsUrl(value: string, errorCode: string, allowPath: boolean): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(errorCode); }
  const hostname = parsed.hostname.toLowerCase();
  const isIpLiteral = /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(hostname) || hostname.includes(":");
  const unsafeHost = !hostname.includes(".") || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".lan") || hostname.endsWith(".home") || hostname.endsWith(".arpa") || isIpLiteral;
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || unsafeHost || (!allowPath && parsed.pathname === "/")) throw new Error(errorCode);
  return parsed.toString().replace(/\/$/u, "");
}

function smtpConfiguration(value: z.infer<typeof environmentSchema>): Environment["smtp"] {
  const fields = [value.SMTP_HOST, value.SMTP_PORT, value.SMTP_USERNAME, value.SMTP_PASSWORD, value.SMTP_FROM_EMAIL, value.SMTP_FROM_NAME];
  if (fields.every((field) => field === undefined) && value.SMTP_REPLY_TO === undefined) return null;
  if (fields.some((field) => field === undefined)) throw new Error("invalid_smtp_config");
  return Object.freeze({
    host: value.SMTP_HOST!,
    port: value.SMTP_PORT as 465 | 587,
    username: value.SMTP_USERNAME!,
    password: value.SMTP_PASSWORD!,
    fromEmail: value.SMTP_FROM_EMAIL!,
    fromName: value.SMTP_FROM_NAME!,
    replyTo: value.SMTP_REPLY_TO,
  });
}

function isLoopbackHost(value: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(value);
}

function isLoopbackEmulatorHost(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(`http://${value}`);
    return value === url.host && isLoopbackHost(url.hostname)
      && Number(url.port) >= 1 && Number(url.port) <= 65535;
  } catch {
    return false;
  }
}

function parseAdminWebOrigin(value: z.infer<typeof environmentSchema>): string | undefined {
  if (value.ADMIN_WEB_ORIGIN === undefined) return undefined;
  if (value.NODE_ENV === "production" || !isLoopbackHost(value.HOST)
    || !isLoopbackEmulatorHost(value.FIREBASE_AUTH_EMULATOR_HOST)
    || !isLoopbackEmulatorHost(value.FIRESTORE_EMULATOR_HOST)
    || (value.NODE_ENV === "development" && value.FIREBASE_PROJECT_ID !== "demo-patternly-admin")) {
    throw new Error("invalid_admin_web_origin");
  }
  const origin = parseWebOrigin(value.ADMIN_WEB_ORIGIN, value.NODE_ENV, "invalid_admin_web_origin");
  const parsed = new URL(origin!);
  if (parsed.protocol !== "http:" || !isLoopbackHost(parsed.hostname)) {
    throw new Error("invalid_admin_web_origin");
  }
  return origin;
}

function parseWebOrigin(value: string | undefined, nodeEnv: Environment["nodeEnv"], errorCode: string): string | undefined {
  if (value === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(errorCode);
  }
  const allowsHttp = nodeEnv !== "production" && parsed.protocol === "http:";
  if (value !== parsed.origin || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== "https:" && !allowsHttp)) throw new Error(errorCode);
  return parsed.origin;
}
