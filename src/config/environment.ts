import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  FIREBASE_PROJECT_ID: z.string().regex(/^[a-z0-9-]+$/u).optional(),
  FIREBASE_AUTH_ISSUER: z.string().url().optional(),
  ADMINISTRATOR_EMAIL: z.string().email().optional(),
  ADMIN_WEB_ORIGIN: z.string().url().optional(),
  PUBLIC_DELETION_ORIGIN: z.string().url().optional(),
  REPORT_RATE_LIMIT_HASH_SECRET: z.string().min(32),
  REPORT_RATE_LIMIT_MAX: z.coerce.number().int().positive().max(100).default(5),
  REPORT_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().max(86_400).default(3_600),
  REVENUECAT_API_BASE_URL: z.string().url().default("https://api.revenuecat.com"),
  CONTENT_CATALOG_ORIGIN: z.string().url().optional(),
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
  publicDeletionOrigin: string | undefined;
  reportRateLimitHashSecret: string;
  reportRateLimitMax: number;
  reportRateLimitWindowSeconds: number;
  revenueCatApiBaseUrl: string;
  contentCatalogOrigin: string | undefined;
}>;

export function loadEnvironment(source: NodeJS.ProcessEnv): Environment {
  const parsed = environmentSchema.safeParse(source);
  if (!parsed.success) throw new Error(`invalid_environment:${parsed.error.issues.map((issue) => issue.path.join(".")).join(",")}`);
  const value = parsed.data;
  if (value.NODE_ENV === "production") {
    if (!value.FIREBASE_PROJECT_ID || !value.FIREBASE_AUTH_ISSUER) throw new Error("production_firebase_config_required");
    if (!value.ADMINISTRATOR_EMAIL) throw new Error("production_administrator_email_required");
  }
  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    host: value.HOST,
    logLevel: value.LOG_LEVEL,
    firebaseProjectId: value.FIREBASE_PROJECT_ID,
    firebaseAuthIssuer: value.FIREBASE_AUTH_ISSUER,
    administratorEmail: value.ADMINISTRATOR_EMAIL?.toLowerCase(),
    adminWebOrigin: value.ADMIN_WEB_ORIGIN,
    publicDeletionOrigin: value.PUBLIC_DELETION_ORIGIN,
    reportRateLimitHashSecret: value.REPORT_RATE_LIMIT_HASH_SECRET,
    reportRateLimitMax: value.REPORT_RATE_LIMIT_MAX,
    reportRateLimitWindowSeconds: value.REPORT_RATE_LIMIT_WINDOW_SECONDS,
    revenueCatApiBaseUrl: value.REVENUECAT_API_BASE_URL,
    contentCatalogOrigin: value.CONTENT_CATALOG_ORIGIN,
  });
}
