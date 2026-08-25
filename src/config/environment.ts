import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().url().optional(),
  FIREBASE_PROJECT_ID: z.string().regex(/^[a-z0-9-]+$/u).optional(),
  FIREBASE_AUTH_ISSUER: z.string().url().optional(),
  ADMINISTRATOR_EMAIL: z.string().email().optional(),
  REVENUECAT_API_BASE_URL: z.string().url().default("https://api.revenuecat.com"),
  REVENUECAT_SECRET_NAME: z.string().min(1).optional(),
  CONTENT_CATALOG_ORIGIN: z.string().url().optional(),
});

export type Environment = Readonly<{
  nodeEnv: "development" | "test" | "production";
  port: number;
  host: string;
  logLevel: string;
  databaseUrl: string | undefined;
  firebaseProjectId: string | undefined;
  firebaseAuthIssuer: string | undefined;
  administratorEmail: string | undefined;
  revenueCatApiBaseUrl: string;
  revenueCatSecretName: string | undefined;
  contentCatalogOrigin: string | undefined;
}>;

export function loadEnvironment(source: NodeJS.ProcessEnv): Environment {
  const parsed = environmentSchema.safeParse(source);
  if (!parsed.success) throw new Error(`invalid_environment:${parsed.error.issues.map((issue) => issue.path.join(".")).join(",")}`);
  const value = parsed.data;
  if (value.NODE_ENV === "production") {
    if (!value.DATABASE_URL) throw new Error("production_database_url_required");
    if (!value.FIREBASE_PROJECT_ID || !value.FIREBASE_AUTH_ISSUER) throw new Error("production_firebase_config_required");
    if (!value.ADMINISTRATOR_EMAIL) throw new Error("production_administrator_email_required");
    if (!value.REVENUECAT_SECRET_NAME) throw new Error("production_revenuecat_secret_required");
  }
  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    host: value.HOST,
    logLevel: value.LOG_LEVEL,
    databaseUrl: value.DATABASE_URL,
    firebaseProjectId: value.FIREBASE_PROJECT_ID,
    firebaseAuthIssuer: value.FIREBASE_AUTH_ISSUER,
    administratorEmail: value.ADMINISTRATOR_EMAIL?.toLowerCase(),
    revenueCatApiBaseUrl: value.REVENUECAT_API_BASE_URL,
    revenueCatSecretName: value.REVENUECAT_SECRET_NAME,
    contentCatalogOrigin: value.CONTENT_CATALOG_ORIGIN,
  });
}
