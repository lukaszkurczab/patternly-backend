import { z } from "zod";

export const ADMIN_CONTENT_RELEASE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  FIREBASE_PROJECT_ID: z.string().regex(/^[a-z0-9-]+$/u).optional(),
  FIREBASE_AUTH_ISSUER: z.string().url().optional(),
  ADMINISTRATOR_EMAIL: z.string().email().optional(),
  ADMIN_WEB_ORIGIN: z.string().optional(),
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
  PUBLIC_PRIVACY_ORIGIN: z.string().url().optional(),
  REVENUECAT_API_BASE_URL: z.string().url().default("https://api.revenuecat.com"),
  REVENUECAT_WEBHOOK_SECRET: z.string().min(1).optional(),
  REVENUECAT_APP_ID: z.string().min(1).optional(),
  REVENUECAT_ENTITLEMENT_ID: z.string().min(1).optional(),
  REVENUECAT_PRODUCT_ID: z.string().min(1).optional(),
  REVENUECAT_WEBHOOK_ENVIRONMENT: z.enum(["PRODUCTION", "SANDBOX"]).optional(),
  CONTENT_CATALOG_ORIGIN: z.string().url().optional(),
  ADMIN_CONTENT_ROOT: z.string().min(1).optional(),
  ADMIN_CONTENT_RELEASE_ID: z.string().regex(ADMIN_CONTENT_RELEASE_ID_PATTERN).optional(),
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
  publicPrivacyOrigin: string | undefined;
  revenueCatApiBaseUrl: string;
  revenueCatWebhookSecret: string | undefined;
  revenueCatAppId: string | undefined;
  revenueCatEntitlementId: string | undefined;
  revenueCatProductId: string | undefined;
  revenueCatWebhookEnvironment: "PRODUCTION" | "SANDBOX" | undefined;
  contentCatalogOrigin: string | undefined;
  adminContentRoot: string | undefined;
  adminContentReleaseId: string | undefined;
}>;

export function loadEnvironment(source: NodeJS.ProcessEnv): Environment {
  const parsed = environmentSchema.safeParse(source);
  if (!parsed.success) throw new Error(`invalid_environment:${parsed.error.issues.map((issue) => issue.path.join(".")).join(",")}`);
  const value = parsed.data;
  if (value.NODE_ENV === "production") {
    if (!value.FIREBASE_PROJECT_ID || !value.FIREBASE_AUTH_ISSUER) throw new Error("production_firebase_config_required");
    if (!value.ADMINISTRATOR_EMAIL) throw new Error("production_administrator_email_required");
    if (!value.ADMIN_WEB_ORIGIN) throw new Error("production_admin_web_origin_required");
    if (!value.PUBLIC_PRIVACY_ORIGIN) throw new Error("production_public_privacy_origin_required");
    if (!smtpConfiguration(value)) throw new Error("production_smtp_config_required");
    if (!value.REVENUECAT_WEBHOOK_SECRET || !value.REVENUECAT_APP_ID || !value.REVENUECAT_ENTITLEMENT_ID || !value.REVENUECAT_PRODUCT_ID || !value.REVENUECAT_WEBHOOK_ENVIRONMENT) throw new Error("production_revenuecat_config_required");
  }
  const adminWebOrigin = parseAdminWebOrigin(value.ADMIN_WEB_ORIGIN, value.NODE_ENV);
  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    host: value.HOST,
    logLevel: value.LOG_LEVEL,
    firebaseProjectId: value.FIREBASE_PROJECT_ID,
    firebaseAuthIssuer: value.FIREBASE_AUTH_ISSUER,
    administratorEmail: value.ADMINISTRATOR_EMAIL?.toLowerCase(),
    adminWebOrigin,
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
    publicPrivacyOrigin: parseWebOrigin(value.PUBLIC_PRIVACY_ORIGIN, value.NODE_ENV, "invalid_public_privacy_origin"),
    revenueCatApiBaseUrl: value.REVENUECAT_API_BASE_URL,
    revenueCatWebhookSecret: value.REVENUECAT_WEBHOOK_SECRET,
    revenueCatAppId: value.REVENUECAT_APP_ID,
    revenueCatEntitlementId: value.REVENUECAT_ENTITLEMENT_ID,
    revenueCatProductId: value.REVENUECAT_PRODUCT_ID,
    revenueCatWebhookEnvironment: value.REVENUECAT_WEBHOOK_ENVIRONMENT,
    contentCatalogOrigin: value.CONTENT_CATALOG_ORIGIN,
    adminContentRoot: value.ADMIN_CONTENT_ROOT,
    adminContentReleaseId: value.ADMIN_CONTENT_RELEASE_ID,
  });
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

function parseAdminWebOrigin(value: string | undefined, nodeEnv: Environment["nodeEnv"]): string | undefined {
  return parseWebOrigin(value, nodeEnv, "invalid_admin_web_origin");
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
