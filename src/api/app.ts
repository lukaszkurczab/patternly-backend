import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Environment } from "../config/environment.js";
import type { FirestoreRuntime } from "../infrastructure/firestore/client.js";
import type { IdentityTokenVerifier } from "../infrastructure/firebase/verifier.js";
import type { AppCheckTokenVerifier } from "../infrastructure/firebase/appCheckVerifier.js";
import { OPENAPI_DOCUMENT } from "./openapi.js";
import { authenticateRequest } from "../modules/auth/request.js";
import type { BackendStores } from "../infrastructure/firestore/stores.js";
import { syncRequestSchema } from "../modules/progress/contracts.js";
import { createContentReportSchema } from "../modules/content-reports/contracts.js";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
    userId: string | undefined;
    authenticatedEmail: string | undefined;
  }
}

export type ApplicationDependencies = Readonly<{
  environment: Environment;
  firestore: FirestoreRuntime | null;
  verifier: IdentityTokenVerifier | null;
  appCheckVerifier: AppCheckTokenVerifier | null;
  stores: BackendStores | null;
}>;

const authErrorStatus = (error: unknown): number => {
  const message = error instanceof Error ? error.message : "";
  if (message === "authentication_not_configured") return 503;
  if (message === "firestore_not_ready") return 503;
  if (message === "authentication_required" || message === "account_deleted" || message.startsWith("firebase_")) return 401;
  return 500;
};

const errorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "internal_error";
  if (message === "version_conflict") return "version_conflict";
  if (message === "firestore_not_ready") return "firestore_not_ready";
  if (message === "authentication_required") return "authentication_required";
  if (message === "account_deleted") return "account_deleted";
  if (message === "app_check_required") return "app_check_required";
  if (message === "app_check_invalid") return "app_check_invalid";
  return "internal_error";
};

function requireStores(dependencies: ApplicationDependencies): BackendStores {
  if (!dependencies.stores) throw new Error("firestore_not_ready");
  return dependencies.stores;
}

async function protectOptional(request: FastifyRequest, reply: FastifyReply, dependencies: ApplicationDependencies): Promise<void> {
  if (request.headers.authorization === undefined) return;
  await protect(request, reply, dependencies);
}

async function protectWithAppCheckAndOptionalAuth(request: FastifyRequest, reply: FastifyReply, dependencies: ApplicationDependencies): Promise<void> {
  try {
    if (!dependencies.appCheckVerifier) throw new Error("app_check_not_configured");
    const header = request.headers["x-firebase-appcheck"];
    if (typeof header !== "string" || header.length === 0) throw new Error("app_check_required");
    await dependencies.appCheckVerifier.verify(header);
    await protectOptional(request, reply, dependencies);
  } catch (error) {
    const message = error instanceof Error ? error.message : "app_check_invalid";
    const status = message === "app_check_not_configured" ? 503 : 401;
    reply.code(status).send({ error: { code: status === 503 ? "app_check_not_configured" : message === "app_check_required" ? "app_check_required" : "app_check_invalid" } });
  }
}

async function protect(request: FastifyRequest, reply: FastifyReply, dependencies: ApplicationDependencies): Promise<void> {
  try {
    const stores = requireStores(dependencies);
    const authenticated = await authenticateRequest(request, dependencies.verifier, stores.users);
    request.userId = authenticated.userId;
    request.authenticatedEmail = authenticated.identity.email;
  } catch (error) {
    const status = authErrorStatus(error);
    reply.code(status).send({ error: { code: status === 401 ? "authentication_required" : errorCode(error) } });
  }
}

function requireAdministrator(request: FastifyRequest, reply: FastifyReply, dependencies: ApplicationDependencies): boolean {
  const administratorEmail = dependencies.environment.administratorEmail;
  if (!administratorEmail || request.authenticatedEmail?.toLowerCase() !== administratorEmail) {
    reply.code(403).send({ error: { code: "administrator_required" } });
    return false;
  }
  return true;
}

export function buildApplication(dependencies: ApplicationDependencies): FastifyInstance {
  const app = Fastify({ logger: { level: dependencies.environment.logLevel as "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent" } });
  app.decorateRequest("correlationId", "");
  app.decorateRequest("userId", undefined);
  app.decorateRequest("authenticatedEmail", undefined);
  app.addHook("onRequest", async (request, reply) => {
    const supplied = request.headers["x-correlation-id"];
    const correlationId = typeof supplied === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(supplied) ? supplied : request.id;
    request.correlationId = correlationId;
    reply.header("x-correlation-id", correlationId);
  });
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, correlationId: request.correlationId }, "request_failed");
    if (reply.sent) return;
    reply.code(500).send({ error: { code: "internal_error", correlationId: request.correlationId } });
  });

  app.get("/health", async () => ({ status: "ok", service: "patternly-backend" }));
  app.get("/ready", async (_request, reply) => {
    let firestore = false;
    if (dependencies.firestore) {
      try { firestore = await dependencies.firestore.ping(); } catch { firestore = false; }
    }
    const authentication = dependencies.verifier !== null && dependencies.appCheckVerifier !== null;
    const ready = firestore && authentication;
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", checks: { database: firestore, authentication } });
  });
  app.get("/openapi.json", async () => OPENAPI_DOCUMENT);

  app.get("/v1/me", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const profile = await requireStores(dependencies).users.readProfile(request.userId!);
    if (!profile) return reply.code(404).send({ error: { code: "user_not_found" } });
    return { user: profile };
  });

  app.get("/v1/entitlements", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request) => ({ entitlements: await requireStores(dependencies).entitlements.read(request.userId!) }));

  app.get("/v1/progress", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request) => ({ records: await requireStores(dependencies).progress.read(request.userId!) }));

  app.post("/v1/progress/sync", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const parsed = syncRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request", issues: parsed.error.issues.map((issue) => issue.path.join(".")) } });
    const result = await requireStores(dependencies).progress.applyBatch(request.userId!, parsed.data.deviceId, parsed.data.mutations);
    if (result.conflicts.length > 0) return reply.code(409).send(result);
    return reply.code(200).send(result);
  });

  app.get("/v1/tracks", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request) => ({ tracks: await requireStores(dependencies).tracks.readAccess(request.userId!) }));
  app.get("/v1/content/versions", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async () => ({ versions: await requireStores(dependencies).content.readCurrent() }));
  app.post("/v1/content/reports", { preHandler: (request, reply) => protectWithAppCheckAndOptionalAuth(request, reply, dependencies) }, async (request, reply) => {
    const parsed = createContentReportSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request", issues: parsed.error.issues.map((issue) => issue.path.join(".")) } });
    try {
      const result = await requireStores(dependencies).contentReports.create(request.userId, parsed.data, { rateLimitKey: request.ip });
      return reply.code(result.duplicate ? 200 : 201).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error";
      if (message === "report_rate_limited") return reply.code(429).send({ error: { code: "report_rate_limited" } });
      if (message === "account_link_requires_authentication") return reply.code(401).send({ error: { code: "authentication_required" } });
      throw error;
    }
  });
  app.get("/v1/admin/content-reports", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    if (!requireAdministrator(request, reply, dependencies)) return;
    return { reports: await requireStores(dependencies).contentReports.listOpen() };
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: "not_found" } }));
  return app;
}
