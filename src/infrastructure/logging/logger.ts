import pino, { type DestinationStream, type LevelWithSilent, type Logger, type LoggerOptions } from "pino";
import type { Environment } from "../../config/environment.js";

const SAFE_REQUEST_FIELDS = ["method"] as const;
const SAFE_LOG_FIELDS = new Set(["req", "res", "err", "event", "stage", "code", "correlationId", "signal", "responseTime"]);
const SAFE_EVENTS = new Set(["account_sync_rejected", "request_failed", "bootstrap_failed", "shutting_down", "shutdown_failed"]);
const SAFE_STAGES = new Set(["sync", "preview", "confirm"]);
const SAFE_CODES = new Set([
  "invalid_request", "version_conflict", "account_revision_conflict", "progress_fingerprint_mismatch", "mutation_id_reuse",
  "merge_preview_mismatch", "merge_resolution_incomplete", "merge_resolution_mismatch", "merge_conflict_requires_manual_resolution",
  "active_session_adoption_blocked", "journal_recovery_required", "firestore_not_ready", "authentication_required",
  "recent_reauthentication_required", "recovery_code_invalid", "recovery_code_used", "account_deleted",
  "remote_deletion_pending", "session_revocation_failed", "session_revocation_operation_conflict",
  "recovery_session_revocation_failed", "app_check_required", "app_check_invalid", "content_report_not_found",
  "content_report_transition_invalid", "data_export_rate_limited", "data_export_too_large", "internal_error", "unknown",
]);
const SAFE_MESSAGES = new Set([
  "incoming request", "request completed", "request errored", "account_sync_rejected", "request_failed",
  "bootstrap_failed", "shutting_down", "shutdown_failed", "suppressed_log_message",
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function safeRequestSerializer(request: unknown): Readonly<Record<(typeof SAFE_REQUEST_FIELDS)[number], string>> {
  const method = typeof (request as { method?: unknown })?.method === "string" ? (request as { method: string }).method : "UNKNOWN";
  return { method };
}

function safeResponseSerializer(response: unknown): Readonly<{ statusCode: number }> {
  const statusCode = typeof (response as { statusCode?: unknown })?.statusCode === "number" ? (response as { statusCode: number }).statusCode : 0;
  return { statusCode };
}

function safeErrorSerializer(): Readonly<{ code: "internal_error" }> {
  return { code: "internal_error" };
}

function safeLogField(key: string, value: unknown): [string, unknown] | undefined {
  if (!SAFE_LOG_FIELDS.has(key)) return undefined;
  if (key === "req" || key === "res" || key === "err") return [key, value];
  if (key === "event") return SAFE_EVENTS.has(value as string) ? [key, value] : undefined;
  if (key === "stage") return SAFE_STAGES.has(value as string) ? [key, value] : undefined;
  if (key === "code") return SAFE_CODES.has(value as string) ? [key, value] : [key, "internal_error"];
  if (key === "correlationId") return typeof value === "string" && UUID_V4.test(value) ? [key, value] : undefined;
  if (key === "signal") return value === "SIGINT" || value === "SIGTERM" ? [key, value] : undefined;
  if (key === "responseTime") return typeof value === "number" && Number.isFinite(value) && value >= 0 ? [key, value] : undefined;
  return undefined;
}

function safeLogFormatter(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, fieldValue]) => {
    const field = safeLogField(key, fieldValue);
    return field === undefined ? [] : [field];
  }));
}

function safeLogMethod(this: Logger, args: Parameters<Logger["info"]>, method: Logger["info"]): void {
  const fields = typeof args[0] === "object" && args[0] !== null && !Array.isArray(args[0]) ? args[0] as Record<string, unknown> : {};
  const candidate = typeof args[1] === "string" ? args[1] : typeof args[0] === "string" ? args[0] : undefined;
  method.call(this, fields, candidate !== undefined && SAFE_MESSAGES.has(candidate) ? candidate : "suppressed_log_message");
}

function safeChildBindings(bindings: Record<string, unknown>): Record<string, string> {
  const reqId = bindings.reqId;
  return typeof reqId === "string" && UUID_V4.test(reqId) ? { reqId } : {};
}

function secureChildLoggers(logger: Logger): Logger {
  const createChild = logger.child.bind(logger);
  logger.child = ((bindings: Record<string, unknown>, _options: unknown) => secureChildLoggers(createChild(safeChildBindings(bindings)))) as unknown as Logger["child"];
  return logger;
}

function loggerOptions(level: LevelWithSilent): LoggerOptions {
  return {
    level,
    base: null,
    formatters: { bindings: safeChildBindings, log: safeLogFormatter },
    hooks: { logMethod: safeLogMethod },
    serializers: {
      req: safeRequestSerializer,
      res: safeResponseSerializer,
      err: safeErrorSerializer,
    },
    redact: {
      paths: ["token", "secret", "payload", "password", "email", "uid", "subject", "contact", "operationSecret", "recoveryCode", "authorization", "cookie", "headers", "body", "query"],
      censor: "[REDACTED]",
    },
  };
}

/** The only production logger constructor. Request, response, and error objects are allowlisted. */
export function createLogger(environment: Environment, stream?: DestinationStream): Logger {
  const options = loggerOptions(environment.logLevel as LevelWithSilent);
  return secureChildLoggers(stream === undefined ? pino(options) : pino(options, stream));
}

/** Minimal safe logger for failures before validated environment/application composition exists. */
export function createBootstrapLogger(): Logger {
  return secureChildLoggers(pino(loggerOptions("info")));
}
