import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Environment } from "../config/environment.js";
import type { FirestoreRuntime } from "../infrastructure/firestore/client.js";
import type { IdentityTokenVerifier } from "../infrastructure/firebase/verifier.js";
import type { AppCheckTokenVerifier } from "../infrastructure/firebase/appCheckVerifier.js";
import { OPENAPI_DOCUMENT } from "./openapi.js";
import { authenticateRequest } from "../modules/auth/request.js";
import type { BackendStores } from "../infrastructure/firestore/stores.js";
import { syncRequestSchema } from "../modules/progress/contracts.js";
import { guestMergeConfirmationSchema, guestMergeSnapshotSchema } from "../modules/users/merge.js";
import { createContentReportSchema, transitionContentReportSchema } from "../modules/content-reports/contracts.js";
import { accountRecoveryCodeConsumeSchema, accountRecoveryCodeIssueSchema, accountSessionRevokeSchema, accountDeletionRequestSchema, publicDeletionConfirmSchema, publicDeletionRequestSchema, publicDeletionStatusSchema } from "../modules/account-lifecycle/contracts.js";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
    userId: string | undefined;
    authenticatedEmail: string | undefined;
    authenticatedEmailVerified: boolean | undefined;
    authTime: number | undefined;
  }
}

export type ApplicationDependencies = Readonly<{
  environment: Environment;
  firestore: FirestoreRuntime | null;
  verifier: IdentityTokenVerifier | null;
  appCheckVerifier: AppCheckTokenVerifier | null;
  stores: BackendStores | null;
  deletionEmailSender?: import("../modules/account-lifecycle/store.js").DeletionEmailSender | null;
}>;

const RECENT_AUTH_SECONDS = 300;

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
  if (message === "account_revision_conflict") return "account_revision_conflict";
  if (message === "merge_preview_mismatch") return "merge_preview_mismatch";
  if (message === "merge_resolution_incomplete") return "merge_resolution_incomplete";
  if (message === "merge_resolution_mismatch") return "merge_resolution_mismatch";
  if (message === "merge_conflict_requires_manual_resolution") return "merge_conflict_requires_manual_resolution";
  if (message === "active_session_adoption_blocked") return "active_session_adoption_blocked";
  if (message === "journal_recovery_required") return "journal_recovery_required";
  if (message === "mutation_id_reuse") return "mutation_id_reuse";
  if (message === "progress_fingerprint_mismatch") return "progress_fingerprint_mismatch";
  if (message === "firestore_not_ready") return "firestore_not_ready";
  if (message === "authentication_required") return "authentication_required";
  if (message === "recent_reauthentication_required") return "recent_reauthentication_required";
  if (message === "recovery_code_invalid") return "recovery_code_invalid";
  if (message === "recovery_code_used") return "recovery_code_used";
  if (message === "account_deleted") return "account_deleted";
  if (message === "deletion_email_unavailable") return "deletion_email_unavailable";
  if (message === "deletion_request_invalid") return "deletion_request_invalid";
  if (message === "remote_deletion_pending") return "remote_deletion_pending";
  if (message === "session_revocation_failed") return "session_revocation_failed";
  if (message === "session_revocation_operation_conflict") return "session_revocation_operation_conflict";
  if (message === "recovery_session_revocation_failed") return "recovery_session_revocation_failed";
  if (message === "app_check_required") return "app_check_required";
  if (message === "app_check_invalid") return "app_check_invalid";
  if (message === "content_report_not_found") return "content_report_not_found";
  if (message === "content_report_transition_invalid") return "content_report_transition_invalid";
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
    request.authenticatedEmailVerified = authenticated.identity.emailVerified;
    request.authTime = authenticated.authTime;
  } catch (error) {
    const status = authErrorStatus(error);
    reply.code(status).send({ error: { code: status === 401 ? "authentication_required" : errorCode(error) } });
  }
}

function requireRecentReauthentication(request: FastifyRequest, reply: FastifyReply): boolean {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const authTime = request.authTime;
  if (typeof authTime === "number" && nowSeconds - authTime <= RECENT_AUTH_SECONDS && authTime <= nowSeconds + 30) return true;
  reply.code(401).send({ error: { code: "recent_reauthentication_required" } });
  return false;
}

function requireAdministrator(request: FastifyRequest, reply: FastifyReply, dependencies: ApplicationDependencies): boolean {
  const administratorEmail = dependencies.environment.administratorEmail;
  if (!administratorEmail || request.authenticatedEmailVerified !== true || request.authenticatedEmail?.toLowerCase() !== administratorEmail) {
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
  app.decorateRequest("authenticatedEmailVerified", undefined);
  app.decorateRequest("authTime", undefined);
  app.addHook("onRequest", async (request, reply) => {
    const supplied = request.headers["x-correlation-id"];
    const correlationId = typeof supplied === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(supplied) ? supplied : request.id;
    request.correlationId = correlationId;
    reply.header("x-correlation-id", correlationId);
    const origin = request.headers.origin;
    const isAdminReportRoute = request.url.startsWith("/v1/admin/content-reports");
    const isPublicDeletionRoute = request.url.startsWith("/v1/public/deletion-");
    if (isAdminReportRoute && typeof origin === "string" && origin === dependencies.environment.adminWebOrigin) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-headers", "authorization, content-type");
      reply.header("access-control-allow-methods", "GET, PATCH, OPTIONS");
      reply.header("vary", "Origin");
    }
    if (isPublicDeletionRoute && typeof origin === "string" && origin === dependencies.environment.publicDeletionOrigin) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-headers", "content-type");
      reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
      reply.header("vary", "Origin");
    }
    if (isAdminReportRoute && request.method === "OPTIONS") {
      if (typeof origin !== "string" || origin !== dependencies.environment.adminWebOrigin) return reply.code(403).send({ error: { code: "origin_not_allowed" } });
      return reply.code(204).send();
    }
    if (isPublicDeletionRoute && request.method === "OPTIONS") {
      if (typeof origin !== "string" || origin !== dependencies.environment.publicDeletionOrigin) return reply.code(403).send({ error: { code: "origin_not_allowed" } });
      return reply.code(204).send();
    }
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

  app.get("/v1/progress", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request) => {
    const snapshot = await requireStores(dependencies).progress.readSnapshot(request.userId!);
    return { accountRevision: snapshot.accountRevision, records: snapshot.records };
  });

  app.post("/v1/progress/sync", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const parsed = syncRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request", issues: parsed.error.issues.map((issue) => issue.path.join(".")) } });
    try {
      const result = await requireStores(dependencies).progress.applyBatch(request.userId!, parsed.data.deviceId, parsed.data.expectedAccountRevision, parsed.data.mutations);
      if (result.conflicts.length > 0 || result.accountRevisionConflict) return reply.code(409).send(result.accountRevisionConflict ? { error: result.accountRevisionConflict } : result);
      return reply.code(200).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error";
      if (message === "progress_fingerprint_mismatch") return reply.code(400).send({ error: { code: errorCode(error) } });
      if (message === "mutation_id_reuse") return reply.code(409).send({ error: { code: errorCode(error) } });
      throw error;
    }
  });

  app.post("/v1/account-data/adoption/preview", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const parsed = guestMergeSnapshotSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request", issues: parsed.error.issues.map((issue) => issue.path.join(".")) } });
    return reply.code(200).send(await requireStores(dependencies).progress.previewAdoption(request.userId!, parsed.data));
  });

  app.post("/v1/account-data/adoption/confirm", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const snapshot = guestMergeSnapshotSchema.safeParse(body?.snapshot);
    const confirmation = guestMergeConfirmationSchema.safeParse(body?.confirmation);
    const deviceId = typeof body?.deviceId === "string" ? body.deviceId : "";
    if (!snapshot.success || !confirmation.success || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(deviceId)) return reply.code(400).send({ error: { code: "invalid_request" } });
    try {
      return reply.code(200).send(await requireStores(dependencies).progress.confirmAdoption(request.userId!, deviceId, snapshot.data, confirmation.data));
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error";
      if (["merge_preview_mismatch", "merge_resolution_incomplete", "merge_resolution_mismatch", "merge_conflict_requires_manual_resolution", "active_session_adoption_blocked", "journal_recovery_required", "mutation_id_reuse"].includes(message)) return reply.code(409).send({ error: { code: errorCode(error) } });
      if (message === "progress_fingerprint_mismatch") return reply.code(400).send({ error: { code: errorCode(error) } });
      throw error;
    }
  });

  app.post("/v1/account/recovery-codes", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    if (!requireRecentReauthentication(request, reply)) return;
    const parsed = accountRecoveryCodeIssueSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    try {
      return reply.code(200).send(await requireStores(dependencies).accountLifecycle.issueRecoveryCodes(request.userId!));
    } catch (error) {
      const message = error instanceof Error ? error.message : "account_deleted";
      if (message === "account_deleted") return reply.code(409).send({ error: { code: "account_deleted" } });
      throw error;
    }
  });

  app.post("/v1/public/recovery-codes/consume", async (request, reply) => {
    const parsed = accountRecoveryCodeConsumeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    try {
      return reply.code(200).send(await requireStores(dependencies).accountLifecycle.consumeRecoveryCode(parsed.data.code));
    } catch (error) {
      const message = error instanceof Error ? error.message : "recovery_code_invalid";
      if (message === "recovery_code_used") return reply.code(409).send({ error: { code: "recovery_code_used" } });
      if (message === "recovery_session_revocation_failed") return reply.code(503).send({ error: { code: "recovery_session_revocation_pending" } });
      if (message === "recovery_code_invalid" || message === "account_deleted") return reply.code(401).send({ error: { code: "recovery_code_invalid" } });
      throw error;
    }
  });

  app.post("/v1/account/session/revoke", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const parsed = accountSessionRevokeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    try {
      return reply.code(200).send(await requireStores(dependencies).accountLifecycle.revokeSessions(request.userId!, parsed.data.operationId));
    } catch (error) {
      if (error instanceof Error && error.message === "session_revocation_failed") return reply.code(503).send({ error: { code: "session_revocation_pending" } });
      if (error instanceof Error && error.message === "session_revocation_operation_conflict") return reply.code(409).send({ error: { code: "session_revocation_operation_conflict" } });
      throw error;
    }
  });

  app.post("/v1/account/deletion", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    if (!requireRecentReauthentication(request, reply)) return;
    const parsed = accountDeletionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    try {
      const lifecycle = requireStores(dependencies).accountLifecycle;
      const result = await lifecycle.deleteAccount(request.userId!, parsed.data.operationId);
      try {
        await requireStores(dependencies).contentReports.unlinkAccount(request.userId!);
      } catch {
        throw new Error("remote_deletion_pending");
      }
      return reply.code(200).send(await lifecycle.completeDeletion(result.operationId, result.proofId));
    } catch (error) {
      if (error instanceof Error && ["remote_deletion_pending", "session_revocation_failed"].includes(error.message)) return reply.code(503).send({ error: { code: "remote_deletion_pending" } });
      throw error;
    }
  });

  app.post("/v1/public/deletion-requests", async (request, reply) => {
    const parsed = publicDeletionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    if (!dependencies.deletionEmailSender) return reply.code(503).send({ error: { code: "deletion_email_unavailable" } });
    try {
      await requireStores(dependencies).accountLifecycle.createPublicDeletionRequest(parsed.data.email.trim().toLowerCase(), dependencies.environment.publicDeletionOrigin ?? "", dependencies.deletionEmailSender);
    } catch (error) {
      if (error instanceof Error && error.message === "deletion_rate_limited") return reply.code(429).send({ error: { code: "deletion_rate_limited" } });
      if (error instanceof Error && error.message === "deletion_email_unavailable") return reply.code(503).send({ error: { code: "deletion_email_unavailable" } });
      throw error;
    }
    return reply.code(202).send({ status: "accepted" });
  });

  app.post("/v1/public/deletion-requests/:requestId/confirm", async (request, reply) => {
    const params = request.params as { requestId?: unknown };
    const parsed = publicDeletionConfirmSchema.safeParse(request.body);
    if (typeof params.requestId !== "string" || !parsed.success) return reply.code(400).send({ error: { code: "deletion_request_invalid" } });
    try {
      const lifecycle = requireStores(dependencies).accountLifecycle;
      const possession = await lifecycle.confirmPublicDeletion(params.requestId, parsed.data.token);
      if (possession.status === "complete") return reply.code(200).send({ status: "deleted", operationId: possession.operationId, proofId: possession.proofId });
      const result = await lifecycle.deleteAccount(possession.userId, possession.operationId);
      try {
        await requireStores(dependencies).contentReports.unlinkAccount(possession.userId);
      } catch {
        throw new Error("remote_deletion_pending");
      }
      return reply.code(200).send(await lifecycle.completeDeletion(result.operationId, result.proofId));
    } catch (error) {
      if (error instanceof Error && ["deletion_request_invalid", "deletion_request_expired"].includes(error.message)) return reply.code(400).send({ error: { code: "deletion_request_invalid" } });
      if (error instanceof Error && ["remote_deletion_pending", "session_revocation_failed"].includes(error.message)) return reply.code(503).send({ error: { code: "remote_deletion_pending" } });
      throw error;
    }
  });

  app.get("/v1/public/deletion-proofs/:proofId", async (request, reply) => {
    const params = request.params as { proofId?: unknown };
    if (typeof params.proofId !== "string" || !/^proof_[A-Za-z0-9_-]{20,128}$/u.test(params.proofId)) return reply.code(404).send({ error: { code: "not_found" } });
    const proof = await requireStores(dependencies).accountLifecycle.readDeletionProof(params.proofId);
    if (!proof) return reply.code(404).send({ error: { code: "not_found" } });
    return reply.code(200).send(proof);
  });

  app.post("/v1/public/deletion-operations/status", async (request, reply) => {
    const parsed = publicDeletionStatusSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(404).send({ error: { code: "not_found" } });
    const status = await requireStores(dependencies).accountLifecycle.readDeletionOperationStatus(parsed.data.operationId, parsed.data.accountUidHash);
    if (!status) return reply.code(404).send({ error: { code: "not_found" } });
    return reply.code(200).send(status);
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
    return { reports: await requireStores(dependencies).contentReports.listQueue() };
  });
  app.patch("/v1/admin/content-reports/:clientSubmissionId", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    if (!requireAdministrator(request, reply, dependencies)) return;
    const params = request.params as { clientSubmissionId?: unknown };
    const clientSubmissionId = typeof params.clientSubmissionId === "string" ? params.clientSubmissionId : "";
    const parsed = transitionContentReportSchema.safeParse(request.body);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(clientSubmissionId) || !parsed.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    try {
      return reply.code(200).send(await requireStores(dependencies).contentReports.transitionStatus(clientSubmissionId, request.userId!, parsed.data.status));
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error";
      if (message === "content_report_not_found") return reply.code(404).send({ error: { code: "content_report_not_found" } });
      if (message === "content_report_transition_invalid") return reply.code(409).send({ error: { code: "content_report_transition_invalid" } });
      throw error;
    }
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: "not_found" } }));
  return app;
}
