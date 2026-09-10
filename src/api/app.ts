import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { DestinationStream } from "pino";
import { createHash, randomUUID } from "node:crypto";
import type { Environment } from "../config/environment.js";
import type { FirestoreRuntime } from "../infrastructure/firestore/client.js";
import type { IdentityTokenVerifier } from "../infrastructure/firebase/verifier.js";
import type { AppCheckTokenVerifier } from "../infrastructure/firebase/appCheckVerifier.js";
import { OPENAPI_DOCUMENT } from "./openapi.js";
import { authenticateRequest } from "../modules/auth/request.js";
import type { BackendStores } from "../infrastructure/firestore/stores.js";
import { createProgressPageToken, isSyncRequestWithinBudget, parseProgressPageToken, syncRequestSchema, type ProgressRecord, type SyncBatchMetadata } from "../modules/progress/contracts.js";
import { guestMergeConfirmationSchema, guestMergeSnapshotSchema } from "../modules/users/merge.js";
import { createContentReportSchema, transitionContentReportSchema } from "../modules/content-reports/contracts.js";
import { accountRecoveryCodeConsumeSchema, accountRecoveryCodeIssueSchema, accountSessionRevokeSchema, accountDeletionRequestSchema, publicDeletionStatusSchema } from "../modules/account-lifecycle/contracts.js";
import { createLogger } from "../infrastructure/logging/logger.js";
import { DataExportRateLimitError, DataExportTooLargeError } from "../modules/data-export/contracts.js";
import { createAccountPrivacyRequestSchema, createPublicPrivacyRequestSchema, privacyRequestAdminActionSchema, publicPrivacySessionSchema, PRIVACY_RIGHT_POLICIES, verifyPublicPrivacyRequestSchema } from "../modules/privacy-requests/contracts.js";
import { createSecurityIncidentSchema, securityIncidentActionSchema } from "../modules/security-incidents/contracts.js";
import { revenueCatEventSchema, verifyRevenueCatAuthorization } from "../modules/billing/revenuecatWebhook.js";
import { createLegalRequestSchema, createPublicLegalRequestSchema, legalRequestAdminActionSchema } from "../modules/legal-requests/contracts.js";
import { adoptionTransferApplySchema, adoptionTransferConfirmSchema, adoptionTransferPreviewSchema, adoptionTransferSealSchema, adoptionTransferStartSchema, adoptionTransferStatusSchema, adoptionTransferUploadSchema } from "../modules/users/adoptionTransfer.js";
import { z } from "zod";
import { canonicalJson } from "../infrastructure/identity/canonicalJson.js";

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
  privacyRequestEmailSender?: import("../modules/privacy-requests/store.js").PrivacyRequestEmailSender | null;
  securityIncidentEmailSender?: import("../modules/security-incidents/store.js").SecurityIncidentEmailSender | null;
  legalRequestEmailSender?: import("../modules/legal-requests/store.js").LegalRequestEmailSender | null;
  purchaseReceiptEmailSender?: import("../infrastructure/email/smtpPrivacyEmailSender.js").PurchaseReceiptEmailSender | null;
  logStream?: DestinationStream;
}>;

const RECENT_AUTH_SECONDS = 300;
const PRIVACY_REQUEST_ID_PATTERN = /^pr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const privacyRequestId = (value: unknown): string | null => typeof value === "string" && PRIVACY_REQUEST_ID_PATTERN.test(value) ? value : null;
const SECURITY_INCIDENT_ID_PATTERN = /^si_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const securityIncidentId = (value: unknown): string | null => typeof value === "string" && SECURITY_INCIDENT_ID_PATTERN.test(value) ? value : null;
const LEGAL_REQUEST_ID_PATTERN = /^lr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const legalRequestId = (value: unknown): string | null => typeof value === "string" && LEGAL_REQUEST_ID_PATTERN.test(value) ? value : null;
const ADOPTION_TRANSFER_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const adoptionTransferSessionId = (value: unknown): string | null => typeof value === "string" && ADOPTION_TRANSFER_SESSION_ID_PATTERN.test(value) ? value : null;

function progressRecordIdentity(record: Pick<ProgressRecord, "recordType" | "targetId" | "trackId">): string {
  return canonicalJson({ recordId: record.targetId, recordType: record.recordType, trackId: record.trackId });
}

function progressRecordOrder(left: ProgressRecord, right: ProgressRecord): number {
  return progressRecordIdentity(left).localeCompare(progressRecordIdentity(right));
}

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
  if (message === "goal_plan_bundle_invalid") return "goal_plan_bundle_invalid";
  if (message === "progress_state_too_large") return "progress_state_too_large";
  if (message === "sync_request_too_large") return "sync_request_too_large";
  if (message === "progress_pagination_token_invalid") return "progress_pagination_token_invalid";
  if (message === "progress_generation_conflict") return "progress_generation_conflict";
  if (message.startsWith("adoption_transfer_")) return message;
  if (message === "firestore_not_ready") return "firestore_not_ready";
  if (message === "authentication_required") return "authentication_required";
  if (message === "recent_reauthentication_required") return "recent_reauthentication_required";
  if (message === "recovery_code_invalid") return "recovery_code_invalid";
  if (message === "recovery_code_used") return "recovery_code_used";
  if (message === "account_deleted") return "account_deleted";
  if (message === "legal_acceptance_required") return "legal_acceptance_required";
  if (message === "remote_deletion_pending") return "remote_deletion_pending";
  if (message === "session_revocation_failed") return "session_revocation_failed";
  if (message === "session_revocation_operation_conflict") return "session_revocation_operation_conflict";
  if (message === "recovery_session_revocation_failed") return "recovery_session_revocation_failed";
  if (message === "app_check_required") return "app_check_required";
  if (message === "app_check_invalid") return "app_check_invalid";
  if (message === "content_report_not_found") return "content_report_not_found";
  if (message === "content_report_transition_invalid") return "content_report_transition_invalid";
  if (message === "data_export_rate_limited") return "data_export_rate_limited";
  if (message === "data_export_too_large") return "data_export_too_large";
  if (message === "privacy_request_not_found") return "privacy_request_not_found";
  if (message === "privacy_request_revision_conflict") return "privacy_request_revision_conflict";
  if (message === "privacy_request_transition_invalid") return "privacy_request_transition_invalid";
  if (message === "privacy_request_extension_invalid") return "privacy_request_extension_invalid";
  if (message === "privacy_request_subject_unverified") return "privacy_request_subject_unverified";
  if (message === "privacy_request_executor_required") return "privacy_request_executor_required";
  if (message === "privacy_request_executor_unavailable") return "privacy_request_executor_unavailable";
  if (message === "privacy_request_rate_limited") return "privacy_request_rate_limited";
  if (message === "privacy_email_unavailable") return "privacy_email_unavailable";
  if (message.startsWith("legal_request_")) return message;
  if (message.startsWith("security_incident_")) return message;
  return "internal_error";
};

const ACCOUNT_SYNC_REJECTED_EVENT = "account_sync_rejected" as const;
const ACCOUNT_SYNC_REJECTION_CODES = new Set([
  "invalid_request",
  "version_conflict",
  "account_revision_conflict",
  "progress_fingerprint_mismatch",
  "goal_plan_bundle_invalid",
  "progress_state_too_large",
  "sync_request_too_large",
  "progress_pagination_token_invalid",
  "progress_generation_conflict",
  "mutation_id_reuse",
  "merge_preview_mismatch",
  "merge_resolution_incomplete",
  "merge_resolution_mismatch",
  "merge_conflict_requires_manual_resolution",
  "active_session_adoption_blocked",
  "journal_recovery_required",
]);

type AccountSyncRejectionStage = "sync" | "preview" | "confirm";

function accountSyncRejectionCode(value: unknown): string {
  const candidate = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  return ACCOUNT_SYNC_REJECTION_CODES.has(candidate) ? candidate : "unknown";
}

function logAccountSyncRejection(request: FastifyRequest, stage: AccountSyncRejectionStage, code: unknown): void {
  request.log.warn(
    {
      event: ACCOUNT_SYNC_REJECTED_EVENT,
      stage,
      code: accountSyncRejectionCode(code),
      correlationId: request.correlationId,
    },
    ACCOUNT_SYNC_REJECTED_EVENT,
  );
}

function requireStores(dependencies: ApplicationDependencies): BackendStores {
  if (!dependencies.stores) throw new Error("firestore_not_ready");
  return dependencies.stores;
}

function adoptionTransferErrorResponse(error: unknown, reply: FastifyReply): boolean {
  const message = error instanceof Error ? error.message : "internal_error";
  if (!message.startsWith("adoption_transfer_") && !["active_session_adoption_blocked", "journal_recovery_required", "progress_fingerprint_mismatch", "goal_plan_bundle_invalid"].includes(message)) return false;
  const notFound = message === "adoption_transfer_not_found";
  const tooLarge = message === "adoption_transfer_record_limit" || message.includes("too_large");
  const conflict = message.includes("conflict") || message.includes("mismatch") || message.includes("stale") || message.includes("precondition") || message.includes("duplicate") || message.includes("generation") || message.includes("cursor") || message.includes("incomplete") || message.includes("sequence");
  const status = notFound ? 404 : tooLarge ? 413 : conflict || message === "active_session_adoption_blocked" || message === "journal_recovery_required" ? 409 : 400;
  reply.code(status).send({ error: { code: errorCode(error) } });
  return true;
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

export function buildApplication(dependencies: ApplicationDependencies) {
  const app = Fastify({
    loggerInstance: createLogger(dependencies.environment, dependencies.logStream),
    genReqId: () => randomUUID(),
  });
  app.decorateRequest("correlationId", "");
  app.decorateRequest("userId", undefined);
  app.decorateRequest("authenticatedEmail", undefined);
  app.decorateRequest("authenticatedEmailVerified", undefined);
  app.decorateRequest("authTime", undefined);
  app.addHook("onRequest", async (request, reply) => {
    request.correlationId = request.id;
    reply.header("x-correlation-id", request.id);
    const origin = request.headers.origin;
    const isAdminRoute = request.url.startsWith("/v1/admin/");
    const isPublicPrivacyRoute = request.url.startsWith("/v1/public/privacy-requests");
    if (isAdminRoute && typeof origin === "string" && origin === dependencies.environment.adminWebOrigin) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-headers", "authorization, content-type");
      reply.header("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
      reply.header("vary", "Origin");
    }
    if (isPublicPrivacyRoute && typeof origin === "string" && origin === dependencies.environment.publicPrivacyOrigin) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-headers", "content-type");
      reply.header("access-control-allow-methods", "POST, OPTIONS");
      reply.header("vary", "Origin");
      reply.header("referrer-policy", "no-referrer");
      reply.header("cache-control", "no-store");
    }
    if (isAdminRoute && request.method === "OPTIONS") {
      if (typeof origin !== "string" || origin !== dependencies.environment.adminWebOrigin) return reply.code(403).send({ error: { code: "origin_not_allowed" } });
      return reply.code(204).send();
    }
    if (isPublicPrivacyRoute && request.method === "OPTIONS") {
      if (typeof origin !== "string" || origin !== dependencies.environment.publicPrivacyOrigin) return reply.code(403).send({ error: { code: "origin_not_allowed" } });
      return reply.code(204).send();
    }
  });
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ event: "request_failed", code: errorCode(error), correlationId: request.correlationId }, "request_failed");
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

  app.post("/v1/webhooks/revenuecat", async (request, reply) => {
    const configuration = dependencies.environment;
    if (!configuration.revenueCatWebhookSecret || !configuration.revenueCatAppId || !configuration.revenueCatEntitlementId || !configuration.revenueCatProductId || !configuration.revenueCatWebhookEnvironment) return reply.code(503).send({ error: { code: "revenuecat_not_configured" } });
    if (!verifyRevenueCatAuthorization(request.headers.authorization, configuration.revenueCatWebhookSecret)) return reply.code(401).send({ error: { code: "revenuecat_webhook_unauthorized" } });
    const envelope = request.body as { event?: unknown } | null;
    const parsed = revenueCatEventSchema.safeParse(envelope?.event);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    try {
      const store = requireStores(dependencies).revenueCatWebhook;
      const result = await store.process(parsed.data, configuration.revenueCatAppId, configuration.revenueCatWebhookEnvironment, configuration.revenueCatEntitlementId, configuration.revenueCatProductId);
      if (result.receipt) {
        if (!dependencies.purchaseReceiptEmailSender) {
          await store.markReceiptDelivery(result.receipt.userId, result.receipt.receiptId, result.receipt.deliveryClaimId, "failed");
          return reply.code(503).send({ error: { code: "purchase_receipt_delivery_unavailable" } });
        }
        try {
          await dependencies.purchaseReceiptEmailSender.send(result.receipt);
          await store.markReceiptDelivery(result.receipt.userId, result.receipt.receiptId, result.receipt.deliveryClaimId, "sent");
        } catch {
          await store.markReceiptDelivery(result.receipt.userId, result.receipt.receiptId, result.receipt.deliveryClaimId, "failed");
          return reply.code(503).send({ error: { code: "purchase_receipt_delivery_failed" } });
        }
      }
      return reply.code(200).send({ outcome: result.outcome, duplicate: result.duplicate });
    } catch (error) {
      if (error instanceof Error && error.message === "event_timestamp_future") return reply.code(400).send({ error: { code: "invalid_request" } });
      throw error;
    }
  });

  app.get("/v1/me", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const profile = await requireStores(dependencies).users.readProfile(request.userId!);
    if (!profile) return reply.code(404).send({ error: { code: "user_not_found" } });
    return { user: profile };
  });

  app.post("/v1/legal-acceptances", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const parsed = z.object({ termsVersion: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/u), minimumAgeConfirmed: z.literal(18) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    const acceptance = await requireStores(dependencies).users.recordLegalAcceptance(request.userId!, parsed.data.termsVersion);
    return reply.code(201).send({ acceptance });
  });

  app.post("/v1/purchase-confirmations", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const parsed = z.object({ confirmationId: z.string().uuid(), termsVersion: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/u), productIdentifier: z.string().trim().min(1).max(200), storefrontPrice: z.string().trim().min(1).max(80), locale: z.enum(["en", "pl"]), immediateStartRequested: z.literal(true) }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    try {
      const confirmation = await requireStores(dependencies).users.recordPurchaseConfirmation(request.userId!, parsed.data);
      return reply.code(201).send({ confirmation });
    } catch (error) {
      if (error instanceof Error && error.message === "legal_acceptance_required") return reply.code(409).send({ error: { code: "legal_acceptance_required" } });
      if (error instanceof Error && error.message === "purchase_attempt_active") return reply.code(409).send({ error: { code: "purchase_attempt_active" } });
      throw error;
    }
  });

  app.get("/v1/entitlements", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request) => ({ entitlements: await requireStores(dependencies).entitlements.read(request.userId!) }));

  app.get("/v1/progress", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const requested = (request.query as { protocolVersion?: unknown }).protocolVersion;
    if (requested !== undefined && requested !== "1" && requested !== "2") return reply.code(400).send({ error: { code: "invalid_request" } });
    const protocolVersion = requested === "2" ? 2 : 1;
    const snapshot = await requireStores(dependencies).progress.readSnapshot(request.userId!, protocolVersion);
    const query = request.query as { pageSize?: unknown; pageToken?: unknown };
    if (query.pageSize === undefined && query.pageToken === undefined) return { accountRevision: snapshot.accountRevision, generation: snapshot.generation ?? 0, records: snapshot.records };
    const pageSize = query.pageSize === undefined ? 100 : Number(query.pageSize);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) return reply.code(400).send({ error: { code: "invalid_request" } });
    let cursor: string | null = null;
    if (query.pageToken !== undefined) {
      if (typeof query.pageToken !== "string") return reply.code(400).send({ error: { code: "progress_pagination_token_invalid" } });
      try {
        const token = parseProgressPageToken(query.pageToken);
        if (token.userId !== request.userId || token.accountRevision !== snapshot.accountRevision || token.generation !== (snapshot.generation ?? 0)) return reply.code(409).send({ error: { code: "progress_generation_conflict" } });
        cursor = token.cursor;
      } catch (error) {
        if (error instanceof Error && error.message === "progress_pagination_token_invalid") return reply.code(400).send({ error: { code: "progress_pagination_token_invalid" } });
        throw error;
      }
    }
    const records = [...snapshot.records].sort(progressRecordOrder);
    const cursorIndex = cursor === null ? -1 : records.findIndex((record) => progressRecordIdentity(record) === cursor);
    if (cursor !== null && cursorIndex < 0) return reply.code(409).send({ error: { code: "progress_generation_conflict" } });
    const start = cursorIndex + 1;
    const page = records.slice(start, start + pageSize);
    const last = page.at(-1);
    const nextPageToken = start + page.length < records.length && last
      ? createProgressPageToken({ version: 1, userId: request.userId!, generation: snapshot.generation ?? 0, accountRevision: snapshot.accountRevision, cursor: progressRecordIdentity(last) })
      : null;
    return { accountRevision: snapshot.accountRevision, generation: snapshot.generation ?? 0, records: page, nextPageToken };
  });

  app.get("/v1/account-data/export", { preHandler: async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    await protect(request, reply, dependencies);
  } }, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (!requireRecentReauthentication(request, reply)) return;
    try {
      const result = await requireStores(dependencies).dataExport.create(request.userId!);
      return reply
        .header("content-disposition", 'attachment; filename="patternly-account-data.json"')
        .type("application/json; charset=utf-8")
        .send(result.serialized);
    } catch (error) {
      if (error instanceof DataExportRateLimitError) return reply.header("retry-after", String(error.retryAfterSeconds)).code(429).send({ error: { code: "data_export_rate_limited" } });
      if (error instanceof DataExportTooLargeError) return reply.code(413).send({ error: { code: "data_export_too_large" } });
      throw error;
    }
  });

  app.post("/v1/privacy-requests", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const parsed = createAccountPrivacyRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    if (PRIVACY_RIGHT_POLICIES[parsed.data.right].accountVerification === "recent_reauthentication" && !requireRecentReauthentication(request, reply)) return;
    const created = await requireStores(dependencies).privacyRequests.createAccount(request.userId!, parsed.data.right, parsed.data.narrative);
    return reply.code(201).send({ request: created });
  });

  app.get("/v1/privacy-requests", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request) => ({ requests: await requireStores(dependencies).privacyRequests.listAccount(request.userId!) }));

  app.get("/v1/privacy-requests/:requestId", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    if (!requireRecentReauthentication(request, reply)) return;
    const requestId = privacyRequestId((request.params as { requestId?: unknown }).requestId);
    if (!requestId) return reply.code(404).send({ error: { code: "not_found" } });
    const result = await requireStores(dependencies).privacyRequests.readAccount(request.userId!, requestId);
    return result ? reply.code(200).send(result) : reply.code(404).send({ error: { code: "not_found" } });
  });

  app.post("/v1/public/privacy-requests", async (request, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const parsed = createPublicPrivacyRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    if (!dependencies.privacyRequestEmailSender || !dependencies.environment.publicPrivacyOrigin) return reply.code(503).send({ error: { code: "privacy_email_unavailable" } });
    try {
      await requireStores(dependencies).privacyRequests.createPublic({ email: parsed.data.email, right: parsed.data.right, reportSubmissionIds: parsed.data.reportSubmissionIds, rateLimitKey: request.ip, ...(parsed.data.narrative === undefined ? {} : { narrative: parsed.data.narrative }) }, dependencies.environment.publicPrivacyOrigin, dependencies.privacyRequestEmailSender);
    } catch (error) {
      if (error instanceof Error && error.message === "privacy_request_rate_limited") return reply.code(429).send({ error: { code: "privacy_request_rate_limited" } });
      if (error instanceof Error && error.message === "privacy_email_unavailable") return reply.code(503).send({ error: { code: "privacy_email_unavailable" } });
      throw error;
    }
    return reply.code(202).send({ status: "accepted" });
  });

  app.post("/v1/public/privacy-requests/:requestId/session", async (request, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const requestId = privacyRequestId((request.params as { requestId?: unknown }).requestId);
    const parsed = verifyPublicPrivacyRequestSchema.safeParse(request.body);
    if (!requestId || !parsed.success) return reply.code(404).send({ error: { code: "not_found" } });
    try {
      return reply.code(200).send(await requireStores(dependencies).privacyRequests.exchangePublicToken(requestId, parsed.data.token));
    } catch {
      return reply.code(404).send({ error: { code: "not_found" } });
    }
  });

  app.post("/v1/public/privacy-requests/:requestId/response", async (request, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const requestId = privacyRequestId((request.params as { requestId?: unknown }).requestId);
    const parsed = publicPrivacySessionSchema.safeParse(request.body);
    if (!requestId || !parsed.success) return reply.code(404).send({ error: { code: "not_found" } });
    const result = await requireStores(dependencies).privacyRequests.readPublic(requestId, parsed.data.sessionToken);
    return result ? reply.code(200).send(result) : reply.code(404).send({ error: { code: "not_found" } });
  });

  app.post("/v1/legal-requests", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const parsed = createLegalRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    if (!dependencies.legalRequestEmailSender || !request.authenticatedEmail || request.authenticatedEmailVerified !== true) return reply.code(503).send({ error: { code: "legal_request_email_unavailable" } });
    try {
      const created = await requireStores(dependencies).legalRequests.create({ userId: request.userId!, email: request.authenticatedEmail, kind: parsed.data.kind, ...(parsed.data.narrative === undefined ? {} : { narrative: parsed.data.narrative }), ...(parsed.data.transactionId === undefined ? {} : { transactionId: parsed.data.transactionId }) }, dependencies.legalRequestEmailSender);
      return reply.code(201).send({ request: created });
    } catch (error) {
      if (error instanceof Error && error.message === "legal_request_email_unavailable") return reply.code(503).send({ error: { code: "legal_request_email_unavailable" } });
      if (error instanceof Error && error.message === "legal_request_rate_limited") return reply.code(429).send({ error: { code: "legal_request_rate_limited" } });
      throw error;
    }
  });

  app.get("/v1/legal-requests", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request) => ({ requests: await requireStores(dependencies).legalRequests.listAccount(request.userId!) }));

  app.get("/v1/legal-requests/:requestId", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const requestId = legalRequestId((request.params as { requestId?: unknown }).requestId);
    if (!requestId) return reply.code(404).send({ error: { code: "not_found" } });
    const result = await requireStores(dependencies).legalRequests.readAccount(request.userId!, requestId);
    return result ? reply.code(200).send({ request: result }) : reply.code(404).send({ error: { code: "not_found" } });
  });

  app.post("/v1/public/legal-requests", { preHandler: (request, reply) => protectWithAppCheckAndOptionalAuth(request, reply, dependencies) }, async (request, reply) => {
    const parsed = createPublicLegalRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    if (!dependencies.legalRequestEmailSender) return reply.code(503).send({ error: { code: "legal_request_email_unavailable" } });
    try {
      const created = await requireStores(dependencies).legalRequests.create({ userId: request.userId ?? null, email: parsed.data.email, kind: parsed.data.kind, ...(parsed.data.narrative === undefined ? {} : { narrative: parsed.data.narrative }), ...(parsed.data.transactionId === undefined ? {} : { transactionId: parsed.data.transactionId }) }, dependencies.legalRequestEmailSender);
      return reply.code(201).send({ request: created });
    } catch (error) {
      if (error instanceof Error && error.message === "legal_request_email_unavailable") return reply.code(503).send({ error: { code: "legal_request_email_unavailable" } });
      if (error instanceof Error && error.message === "legal_request_rate_limited") return reply.code(429).send({ error: { code: "legal_request_rate_limited" } });
      throw error;
    }
  });

  app.post("/v1/progress/sync", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const parsed = syncRequestSchema.safeParse(request.body);
    const withinBudget = isSyncRequestWithinBudget(request.body);
    if (!parsed.success || !withinBudget) {
      const recordTooLarge = parsed.success === false && parsed.error.issues.some((issue) => issue.message === "progress_state_too_large");
      const envelopeTooLarge = parsed.success && !withinBudget;
      const code = recordTooLarge ? "progress_state_too_large" : envelopeTooLarge ? "sync_request_too_large" : "invalid_request";
      logAccountSyncRejection(request, "sync", code);
      return reply.code(recordTooLarge || envelopeTooLarge ? 413 : 400).send({ error: { code, ...(parsed.success ? {} : { issues: parsed.error.issues.map((issue) => issue.path.join(".")) }) } });
    }
    try {
      const metadata: SyncBatchMetadata | undefined = parsed.data.protocolVersion === 3
        ? { sessionId: parsed.data.sessionId, batchId: parsed.data.batchId, planVersion: 3, highWatermark: parsed.data.highWatermark }
        : undefined;
      const result = await requireStores(dependencies).progress.applyBatch(request.userId!, parsed.data.deviceId, parsed.data.expectedAccountRevision, parsed.data.mutations, metadata);
      if (result.conflicts.length > 0 || result.accountRevisionConflict) {
        logAccountSyncRejection(request, "sync", result.accountRevisionConflict?.code ?? result.conflicts[0]?.code);
        return reply.code(409).send(result.accountRevisionConflict ? { error: result.accountRevisionConflict } : result);
      }
      return reply.code(200).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error";
      if (message === "progress_fingerprint_mismatch" || message === "goal_plan_bundle_invalid") {
        logAccountSyncRejection(request, "sync", message);
        return reply.code(400).send({ error: { code: errorCode(error) } });
      }
      if (message === "mutation_id_reuse") {
        logAccountSyncRejection(request, "sync", message);
        return reply.code(409).send({ error: { code: errorCode(error) } });
      }
      throw error;
    }
  });

  app.post("/v1/account-data/adoption/preview", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const parsed = guestMergeSnapshotSchema.safeParse(request.body);
    if (!parsed.success) {
      logAccountSyncRejection(request, "preview", "invalid_request");
      return reply.code(400).send({ error: { code: "invalid_request", issues: parsed.error.issues.map((issue) => issue.path.join(".")) } });
    }
    try {
      return reply.code(200).send(await requireStores(dependencies).progress.previewAdoption(request.userId!, parsed.data));
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error";
      if (message === "progress_fingerprint_mismatch" || message === "goal_plan_bundle_invalid") {
        logAccountSyncRejection(request, "preview", message);
        return reply.code(400).send({ error: { code: errorCode(error) } });
      }
      throw error;
    }
  });

  app.post("/v1/account-data/adoption/confirm", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const snapshot = guestMergeSnapshotSchema.safeParse(body?.snapshot);
    const confirmation = guestMergeConfirmationSchema.safeParse(body?.confirmation);
    const deviceId = typeof body?.deviceId === "string" ? body.deviceId : "";
    if (!snapshot.success || !confirmation.success || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(deviceId)) {
      logAccountSyncRejection(request, "confirm", "invalid_request");
      return reply.code(400).send({ error: { code: "invalid_request" } });
    }
    try {
      return reply.code(200).send(await requireStores(dependencies).progress.confirmAdoption(request.userId!, deviceId, snapshot.data, confirmation.data));
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error";
      if (["merge_preview_mismatch", "merge_resolution_incomplete", "merge_resolution_mismatch", "merge_conflict_requires_manual_resolution", "merge_group_choice_incomplete", "merge_group_choice_mismatch", "active_session_adoption_blocked", "journal_recovery_required", "mutation_id_reuse"].includes(message)) {
        logAccountSyncRejection(request, "confirm", message);
        return reply.code(409).send({ error: { code: errorCode(error) } });
      }
      if (message === "progress_fingerprint_mismatch" || message === "goal_plan_bundle_invalid") {
        logAccountSyncRejection(request, "confirm", message);
        return reply.code(400).send({ error: { code: errorCode(error) } });
      }
      throw error;
    }
  });

  // Protocol-v3 is deliberately explicit and resumable.  The legacy v1/v2
  // preview/confirm routes above retain their existing one-shot contract.
  app.post("/v3/account-data/adoption/start", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const parsed = adoptionTransferStartSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request", issues: parsed.error.issues.map((issue) => issue.path.join(".")) } });
    try {
      return reply.code(200).send(await requireStores(dependencies).progress.startAdoptionTransfer(request.userId!, parsed.data));
    } catch (error) {
      if (adoptionTransferErrorResponse(error, reply)) return;
      throw error;
    }
  });

  app.post("/v3/account-data/adoption/:sessionId/upload", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const sessionId = adoptionTransferSessionId((request.params as { sessionId?: unknown }).sessionId);
    const parsed = adoptionTransferUploadSchema.safeParse(request.body);
    if (!sessionId || !parsed.success) return reply.code(400).send({ error: { code: "invalid_request", ...(parsed.success ? {} : { issues: parsed.error.issues.map((issue) => issue.path.join(".")) }) } });
    try {
      return reply.code(200).send(await requireStores(dependencies).progress.uploadAdoptionTransfer(request.userId!, sessionId, parsed.data));
    } catch (error) {
      if (adoptionTransferErrorResponse(error, reply)) return;
      throw error;
    }
  });

  app.post("/v3/account-data/adoption/:sessionId/seal", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const sessionId = adoptionTransferSessionId((request.params as { sessionId?: unknown }).sessionId);
    const parsed = adoptionTransferSealSchema.safeParse(request.body);
    if (!sessionId || !parsed.success) return reply.code(400).send({ error: { code: "invalid_request", ...(parsed.success ? {} : { issues: parsed.error.issues.map((issue) => issue.path.join(".")) }) } });
    try {
      return reply.code(200).send(await requireStores(dependencies).progress.sealAdoptionTransfer(request.userId!, sessionId, parsed.data));
    } catch (error) {
      if (adoptionTransferErrorResponse(error, reply)) return;
      throw error;
    }
  });

  app.post("/v3/account-data/adoption/:sessionId/preview", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const sessionId = adoptionTransferSessionId((request.params as { sessionId?: unknown }).sessionId);
    const parsed = adoptionTransferPreviewSchema.safeParse(request.body ?? {});
    if (!sessionId || !parsed.success) return reply.code(400).send({ error: { code: "invalid_request", ...(parsed.success ? {} : { issues: parsed.error.issues.map((issue) => issue.path.join(".")) }) } });
    try {
      return reply.code(200).send(await requireStores(dependencies).progress.previewAdoptionTransfer(request.userId!, sessionId, parsed.data));
    } catch (error) {
      if (adoptionTransferErrorResponse(error, reply)) return;
      throw error;
    }
  });

  app.post("/v3/account-data/adoption/:sessionId/confirm", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const sessionId = adoptionTransferSessionId((request.params as { sessionId?: unknown }).sessionId);
    const body = request.body as Record<string, unknown> | null;
    const nested = body && typeof body.confirmation === "object" && body.confirmation !== null && !Array.isArray(body.confirmation)
      ? { ...(body.confirmation as Record<string, unknown>), ...(typeof body.deviceId === "string" ? { deviceId: body.deviceId } : {}) }
      : body;
    const parsed = adoptionTransferConfirmSchema.safeParse(nested);
    if (!sessionId || !parsed.success) return reply.code(400).send({ error: { code: "invalid_request", ...(parsed.success ? {} : { issues: parsed.error.issues.map((issue) => issue.path.join(".")) }) } });
    try {
      return reply.code(200).send(await requireStores(dependencies).progress.confirmAdoptionTransfer(request.userId!, sessionId, parsed.data));
    } catch (error) {
      if (adoptionTransferErrorResponse(error, reply)) return;
      throw error;
    }
  });

  app.post("/v3/account-data/adoption/:sessionId/apply", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const sessionId = adoptionTransferSessionId((request.params as { sessionId?: unknown }).sessionId);
    const parsed = adoptionTransferApplySchema.safeParse(request.body);
    if (!sessionId || !parsed.success) return reply.code(400).send({ error: { code: "invalid_request", ...(parsed.success ? {} : { issues: parsed.error.issues.map((issue) => issue.path.join(".")) }) } });
    try {
      return reply.code(200).send(await requireStores(dependencies).progress.applyAdoptionTransfer(request.userId!, sessionId, parsed.data));
    } catch (error) {
      if (adoptionTransferErrorResponse(error, reply)) return;
      throw error;
    }
  });

  app.get("/v3/account-data/adoption/:sessionId/status", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    const sessionId = adoptionTransferSessionId((request.params as { sessionId?: unknown }).sessionId);
    const query = request.query as { deviceId?: unknown };
    const parsed = adoptionTransferStatusSchema.safeParse({ deviceId: query.deviceId });
    if (!sessionId || !parsed.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    try {
      const status = await requireStores(dependencies).progress.statusAdoptionTransfer(request.userId!, sessionId, parsed.data.deviceId);
      return status ? reply.code(200).send(status) : reply.code(404).send({ error: { code: "adoption_transfer_not_found" } });
    } catch (error) {
      if (adoptionTransferErrorResponse(error, reply)) return;
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
      const result = await lifecycle.deleteAccount(request.userId!, parsed.data.operationId, parsed.data.operationSecret);
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
    const status = await requireStores(dependencies).accountLifecycle.resumeDeletion(parsed.data.operationId, parsed.data.operationSecret);
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
  app.get("/v1/admin/privacy-requests", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    if (!requireAdministrator(request, reply, dependencies)) return;
    return { requests: await requireStores(dependencies).privacyRequests.listAdmin() };
  });
  app.get("/v1/admin/legal-requests", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    if (!requireAdministrator(request, reply, dependencies)) return;
    return { requests: await requireStores(dependencies).legalRequests.listAdmin() };
  });
  app.get("/v1/admin/legal-requests/:requestId", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    if (!requireAdministrator(request, reply, dependencies)) return;
    const requestId = legalRequestId((request.params as { requestId?: unknown }).requestId);
    if (!requestId) return reply.code(404).send({ error: { code: "legal_request_not_found" } });
    const result = await requireStores(dependencies).legalRequests.readAdmin(requestId, request.userId!);
    return result ? reply.code(200).send({ request: result }) : reply.code(404).send({ error: { code: "legal_request_not_found" } });
  });
  app.patch("/v1/admin/legal-requests/:requestId", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    if (!requireAdministrator(request, reply, dependencies)) return;
    const requestId = legalRequestId((request.params as { requestId?: unknown }).requestId);
    const parsed = legalRequestAdminActionSchema.safeParse(request.body);
    if (!requestId || !parsed.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    if (!dependencies.legalRequestEmailSender) return reply.code(503).send({ error: { code: "legal_request_email_unavailable" } });
    try {
      const result = await requireStores(dependencies).legalRequests.transitionAdmin(requestId, request.userId!, parsed.data, dependencies.legalRequestEmailSender);
      return reply.code(200).send({ request: result });
    } catch (error) {
      const code = errorCode(error);
      if (code === "legal_request_not_found") return reply.code(404).send({ error: { code } });
      if (code === "legal_request_email_unavailable") return reply.code(503).send({ error: { code } });
      if (code.startsWith("legal_request_")) return reply.code(409).send({ error: { code } });
      throw error;
    }
  });
  app.post("/v1/admin/security-incidents", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    if (!requireAdministrator(request, reply, dependencies)) return;
    const parsed = createSecurityIncidentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    const incident = await requireStores(dependencies).securityIncidents.create(request.userId!, parsed.data);
    return reply.code(201).send({ incident });
  });
  app.get("/v1/admin/security-incidents", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    if (!requireAdministrator(request, reply, dependencies)) return;
    return { incidents: await requireStores(dependencies).securityIncidents.listAdmin() };
  });
  app.get("/v1/admin/security-incidents/:incidentId", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    if (!requireAdministrator(request, reply, dependencies)) return;
    const incidentId = securityIncidentId((request.params as { incidentId?: unknown }).incidentId);
    if (!incidentId) return reply.code(404).send({ error: { code: "security_incident_not_found" } });
    const incident = await requireStores(dependencies).securityIncidents.readAdmin(incidentId, request.userId!);
    return incident ? reply.code(200).send({ incident }) : reply.code(404).send({ error: { code: "security_incident_not_found" } });
  });
  app.get("/v1/admin/security-incidents/:incidentId/authority-exports/:version", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    if (!requireAdministrator(request, reply, dependencies)) return;
    const incidentId = securityIncidentId((request.params as { incidentId?: unknown }).incidentId);
    const rawVersion = (request.params as { version?: unknown }).version;
    const version = typeof rawVersion === "string" && /^[1-9][0-9]*$/u.test(rawVersion) ? Number(rawVersion) : NaN;
    if (!incidentId || !Number.isSafeInteger(version)) return reply.code(404).send({ error: { code: "security_incident_export_not_found" } });
    const exported = await requireStores(dependencies).securityIncidents.readAuthorityExport(incidentId, version, request.userId!);
    return exported ? reply.code(200).send(exported) : reply.code(404).send({ error: { code: "security_incident_export_not_found" } });
  });
  app.patch("/v1/admin/security-incidents/:incidentId", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    if (!requireAdministrator(request, reply, dependencies)) return;
    const incidentId = securityIncidentId((request.params as { incidentId?: unknown }).incidentId);
    const parsed = securityIncidentActionSchema.safeParse(request.body);
    if (!incidentId || !parsed.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    try {
      const incident = await requireStores(dependencies).securityIncidents.act(incidentId, request.userId!, parsed.data, dependencies.securityIncidentEmailSender ?? null);
      return reply.code(200).send({ incident });
    } catch (error) {
      const code = errorCode(error);
      if (code === "security_incident_not_found") return reply.code(404).send({ error: { code } });
      if (code === "security_incident_email_unavailable") return reply.code(503).send({ error: { code } });
      if (code.startsWith("security_incident_")) return reply.code(409).send({ error: { code } });
      throw error;
    }
  });
  app.get("/v1/admin/privacy-requests/:requestId", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    if (!requireAdministrator(request, reply, dependencies)) return;
    const requestId = privacyRequestId((request.params as { requestId?: unknown }).requestId);
    if (!requestId) return reply.code(404).send({ error: { code: "privacy_request_not_found" } });
    const result = await requireStores(dependencies).privacyRequests.readAdmin(requestId, request.userId!);
    return result ? reply.code(200).send({ request: result }) : reply.code(404).send({ error: { code: "privacy_request_not_found" } });
  });
  app.patch("/v1/admin/privacy-requests/:requestId", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    if (!requireAdministrator(request, reply, dependencies)) return;
    const requestId = privacyRequestId((request.params as { requestId?: unknown }).requestId);
    const parsed = privacyRequestAdminActionSchema.safeParse(request.body);
    if (!requestId || !parsed.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    try {
      if (parsed.data.action === "execute_export") {
        const privacy = requireStores(dependencies).privacyRequests;
        const context = await privacy.readExecutionContext(requestId);
        if (!context) return reply.code(404).send({ error: { code: "privacy_request_not_found" } });
        if (context.revision !== parsed.data.expectedRevision) return reply.code(409).send({ error: { code: "privacy_request_revision_conflict" } });
        if (context.channel !== "account" || !context.userId || (context.right !== "access" && context.right !== "portability")) return reply.code(409).send({ error: { code: "privacy_request_executor_unavailable" } });
        const stableExportId = `export_${createHash("sha256").update(`privacy:${requestId}`, "utf8").digest("base64url").slice(0, 32)}`;
        let result: Awaited<ReturnType<typeof privacy.prepareExecutedResponse>> | null = null;
        await requireStores(dependencies).dataExport.create(context.userId, stableExportId, async (exported) => {
          result = await privacy.prepareExecutedResponse(requestId, request.userId!, parsed.data.expectedRevision, exported.serialized, `${context.right === "access" ? "article_15_export" : "portability_export"}:${exported.exportId}`);
        });
        if (!result) throw new Error("privacy_request_executor_incomplete");
        return reply.code(200).send({ request: result });
      }
      const result = await requireStores(dependencies).privacyRequests.transitionAdmin(requestId, request.userId!, parsed.data, dependencies.environment.publicPrivacyOrigin ?? "", dependencies.privacyRequestEmailSender ?? null);
      return reply.code(200).send({ request: result });
    } catch (error) {
      const code = errorCode(error);
      if (code === "privacy_request_not_found") return reply.code(404).send({ error: { code } });
      if (["privacy_request_revision_conflict", "privacy_request_transition_invalid", "privacy_request_extension_invalid", "privacy_request_subject_unverified", "privacy_request_executor_required", "privacy_request_executor_unavailable"].includes(code)) return reply.code(409).send({ error: { code } });
      if (code === "privacy_email_unavailable") return reply.code(503).send({ error: { code } });
      throw error;
    }
  });
  app.get("/v1/admin/overview", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    if (!requireAdministrator(request, reply, dependencies)) return;
    return requireStores(dependencies).admin.readOverview();
  });
  app.get("/v1/admin/questions", { preHandler: (request, reply) => protect(request, reply, dependencies) }, async (request, reply) => {
    if (!requireAdministrator(request, reply, dependencies)) return;
    const query = request.query as { trackId?: unknown; q?: unknown; page?: unknown; pageSize?: unknown };
    const trackId = typeof query.trackId === "string" && /^[A-Za-z0-9._:/-]{1,128}$/u.test(query.trackId) ? query.trackId : undefined;
    const search = typeof query.q === "string" && query.q.trim().length <= 160 ? query.q : undefined;
    const page = query.page === undefined ? 1 : typeof query.page === "string" && /^[1-9][0-9]{0,5}$/u.test(query.page) ? Number(query.page) : NaN;
    const pageSize = query.pageSize === undefined ? 25 : typeof query.pageSize === "string" && /^[1-9][0-9]{0,2}$/u.test(query.pageSize) ? Number(query.pageSize) : NaN;
    if (!Number.isSafeInteger(page) || !Number.isSafeInteger(pageSize) || pageSize > 100 || (query.trackId !== undefined && trackId === undefined) || (query.q !== undefined && search === undefined)) return reply.code(400).send({ error: { code: "invalid_request" } });
    const questions = await requireStores(dependencies).admin.listQuestions({ ...(trackId === undefined ? {} : { trackId }), ...(search === undefined ? {} : { query: search }), page, pageSize });
    if ("unavailable" in questions) return reply.code(503).send({ error: { code: "question_inspection_unavailable", reason: questions.reason } });
    return questions;
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
