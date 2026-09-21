export type RevenueCatEnvironment = "PRODUCTION" | "SANDBOX";

export type RevenueCatEntitlementState = "active" | "grace" | "hold" | "expired" | "refunded" | "unavailable";

export type RevenueCatEntitlementResult = Readonly<{
  entitlement: string;
  productId: string;
  state: RevenueCatEntitlementState;
  providerExpiresAt: string | null;
  providerGraceExpiresAt: string | null;
  providerObservedAt: string;
}>;

export type RevenueCatReaderConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  entitlementId: string;
  productId: string;
  environment: RevenueCatEnvironment;
}>;

/**
 * The client deliberately accepts a string URL. The implementation always
 * passes a string to the injected function, which keeps test doubles small
 * while remaining compatible with the platform fetch implementation.
 */
export type RevenueCatFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type RevenueCatReaderOptions = Readonly<{
  fetch?: RevenueCatFetch;
  timeoutMs?: number;
}>;

export type RevenueCatProviderFailureKind = "http" | "non_json" | "timeout" | "network" | "invalid_response";

/**
 * A provider failure is intentionally represented by a stable, secret-free
 * message. The original provider error and response body are never copied to
 * the message or exposed through this object.
 */
export class RevenueCatProviderUnavailableError extends Error {
  public readonly code = "revenuecat_provider_unavailable" as const;
  public readonly kind: RevenueCatProviderFailureKind;
  public readonly status: number | undefined;

  public constructor(kind: RevenueCatProviderFailureKind, status?: number) {
    super(`revenuecat_provider_unavailable:${kind}`);
    this.name = "RevenueCatProviderUnavailableError";
    this.kind = kind;
    this.status = status;
  }
}

export class RevenueCatHttpError extends RevenueCatProviderUnavailableError {
  public constructor(status: number) {
    super("http", status);
    this.name = "RevenueCatHttpError";
  }
}

export class RevenueCatNonJsonError extends RevenueCatProviderUnavailableError {
  public constructor() {
    super("non_json");
    this.name = "RevenueCatNonJsonError";
  }
}

export class RevenueCatTimeoutError extends RevenueCatProviderUnavailableError {
  public constructor() {
    super("timeout");
    this.name = "RevenueCatTimeoutError";
  }
}

export interface RevenueCatEntitlementReader {
  read(userId: string): Promise<RevenueCatEntitlementResult>;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const TIMEOUT = Symbol("revenuecat_timeout");

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProviderDate(value: unknown, allowNull: boolean): string | null | undefined {
  if (value === null && allowNull) return null;
  if (typeof value !== "string" || value.length === 0) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return undefined;
  }
}

function parseRequestDate(value: unknown): { milliseconds: number; iso: string } | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return undefined;
  try {
    return { milliseconds: value, iso: new Date(value).toISOString() };
  } catch {
    return undefined;
  }
}

function makeResult(
  config: RevenueCatReaderConfig,
  state: RevenueCatEntitlementState,
  providerObservedAt: string,
  providerExpiresAt: string | null = null,
  providerGraceExpiresAt: string | null = null,
): RevenueCatEntitlementResult {
  return Object.freeze({
    entitlement: config.entitlementId,
    productId: config.productId,
    state,
    providerExpiresAt,
    providerGraceExpiresAt,
    providerObservedAt,
  });
}

function unavailable(config: RevenueCatReaderConfig, providerObservedAt: string): RevenueCatEntitlementResult {
  return makeResult(config, "unavailable", providerObservedAt);
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function resolveOptions(
  config: RevenueCatReaderConfig,
  optionsOrFetch: RevenueCatReaderOptions | RevenueCatFetch | undefined,
): { fetch: RevenueCatFetch; timeoutMs: number } {
  const configWithOptions = config as RevenueCatReaderConfig & RevenueCatReaderOptions;
  const options: RevenueCatReaderOptions = typeof optionsOrFetch === "function"
    ? { fetch: optionsOrFetch }
    : optionsOrFetch ?? {};
  const fetchImpl = options.fetch ?? configWithOptions.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? configWithOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("revenuecat_timeout_invalid");
  return { fetch: fetchImpl, timeoutMs };
}

function validateConfig(config: RevenueCatReaderConfig): void {
  if (!isRecord(config) || !hasNonEmptyString(config.baseUrl) || !hasNonEmptyString(config.apiKey) || !hasNonEmptyString(config.entitlementId) || !hasNonEmptyString(config.productId) || (config.environment !== "PRODUCTION" && config.environment !== "SANDBOX")) {
    throw new TypeError("revenuecat_config_invalid");
  }
}

async function fetchJson(
  fetchImpl: RevenueCatFetch,
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(TIMEOUT);
    }, timeoutMs);
  });

  try {
    const responseBody = (async (): Promise<unknown> => {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      const status = typeof response.status === "number" ? response.status : undefined;
      const ok = response.ok === true || (response.ok === undefined && status !== undefined && status >= 200 && status < 300);
      if (!ok) throw new RevenueCatHttpError(status ?? 0);
      if (typeof response.json !== "function") throw new RevenueCatNonJsonError();
      try {
        return await response.json();
      } catch {
        throw new RevenueCatNonJsonError();
      }
    })();
    return await Promise.race([responseBody, timeoutPromise]);
  } catch (error) {
    if (error === TIMEOUT || timedOut) throw new RevenueCatTimeoutError();
    if (error instanceof RevenueCatProviderUnavailableError) throw error;
    throw new RevenueCatProviderUnavailableError("network");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

function parseResponse(
  config: RevenueCatReaderConfig,
  userId: string,
  payload: unknown,
): RevenueCatEntitlementResult {
  if (!isRecord(payload)) throw new RevenueCatProviderUnavailableError("invalid_response");
  const requestDate = parseRequestDate(payload.request_date_ms);
  if (!requestDate || !isRecord(payload.subscriber)) throw new RevenueCatProviderUnavailableError("invalid_response");

  const subscriber = payload.subscriber;
  if (subscriber.original_app_user_id !== userId) return unavailable(config, requestDate.iso);
  const entitlementsValue = subscriber.entitlements;
  const subscriptionsValue = subscriber.subscriptions;
  if (!isRecord(entitlementsValue) || !isRecord(subscriptionsValue)) return unavailable(config, requestDate.iso);
  const entitlements = entitlementsValue;
  const subscriptions = subscriptionsValue;
  const entitlement = entitlements[config.entitlementId];
  const subscription = subscriptions[config.productId];

  if (entitlement === undefined || entitlement === null || subscription === undefined || subscription === null) {
    return makeResult(config, "expired", requestDate.iso);
  }
  if (!isRecord(entitlement) || !isRecord(subscription)) return unavailable(config, requestDate.iso);

  if (entitlement.product_identifier !== config.productId) return unavailable(config, requestDate.iso);
  if (typeof subscription.is_sandbox !== "boolean" || subscription.is_sandbox !== (config.environment === "SANDBOX")) return unavailable(config, requestDate.iso);
  if (!hasNonEmptyString(subscription.store)) return unavailable(config, requestDate.iso);

  const entitlementExpiresAt = parseProviderDate(entitlement.expires_date, false);
  const subscriptionExpiresAt = parseProviderDate(subscription.expires_date, false);
  if (entitlementExpiresAt === undefined || entitlementExpiresAt === null || subscriptionExpiresAt === undefined || subscriptionExpiresAt === null || entitlementExpiresAt !== subscriptionExpiresAt) return unavailable(config, requestDate.iso);

  const entitlementGraceAt = parseProviderDate(entitlement.grace_period_expires_date, true);
  const subscriptionGraceAt = parseProviderDate(subscription.grace_period_expires_date, true);
  const refundedAt = parseProviderDate(subscription.refunded_at, true);
  const billingIssueAt = parseProviderDate(subscription.billing_issues_detected_at, true);
  if (entitlementGraceAt === undefined || subscriptionGraceAt === undefined || refundedAt === undefined || billingIssueAt === undefined) return unavailable(config, requestDate.iso);
  if (entitlementGraceAt !== null && subscriptionGraceAt !== null && entitlementGraceAt !== subscriptionGraceAt) return unavailable(config, requestDate.iso);

  const providerGraceExpiresAt = subscriptionGraceAt ?? entitlementGraceAt;
  const observedAtMs = requestDate.milliseconds;
  const expiresAtMs = Date.parse(entitlementExpiresAt);
  const graceExpiresAtMs = providerGraceExpiresAt === null ? null : Date.parse(providerGraceExpiresAt);
  const hasFutureExpiry = expiresAtMs > observedAtMs;
  const hasFutureGrace = graceExpiresAtMs !== null && graceExpiresAtMs > observedAtMs;

  if (refundedAt !== null) return makeResult(config, "refunded", requestDate.iso, entitlementExpiresAt, providerGraceExpiresAt);
  if (hasFutureGrace) return makeResult(config, "grace", requestDate.iso, entitlementExpiresAt, providerGraceExpiresAt);
  if (billingIssueAt !== null) return makeResult(config, "hold", requestDate.iso, entitlementExpiresAt, providerGraceExpiresAt);
  return makeResult(config, hasFutureExpiry ? "active" : "expired", requestDate.iso, entitlementExpiresAt, providerGraceExpiresAt);
}

export function createRevenueCatEntitlementReader(
  config: RevenueCatReaderConfig,
  optionsOrFetch?: RevenueCatReaderOptions | RevenueCatFetch,
): RevenueCatEntitlementReader {
  validateConfig(config);
  const normalizedConfig = Object.freeze({
    baseUrl: config.baseUrl.replace(/\/+$/u, ""),
    apiKey: config.apiKey,
    entitlementId: config.entitlementId,
    productId: config.productId,
    environment: config.environment,
  });
  const { fetch: fetchImpl, timeoutMs } = resolveOptions(config, optionsOrFetch);

  return Object.freeze({
    async read(userId: string): Promise<RevenueCatEntitlementResult> {
      if (typeof userId !== "string") throw new TypeError("revenuecat_user_id_invalid");
      const endpoint = `${normalizedConfig.baseUrl}/v1/subscribers/${encodeURIComponent(userId)}`;
      const payload = await fetchJson(fetchImpl, endpoint, normalizedConfig.apiKey, timeoutMs);
      return parseResponse(normalizedConfig, userId, payload);
    },
  });
}

// Kept for the existing, currently unused billing boundary. The online reader
// above is the canonical implementation for the ODK-119 slice.
export interface RevenueCatReconciler {
  reconcile(userId: string, externalCustomerId: string): Promise<Readonly<{ status: "active" | "expired" | "revoked"; expiresAt: string | null }>>;
}

export function createUnavailableRevenueCatReconciler(): RevenueCatReconciler {
  return Object.freeze({
    async reconcile(): Promise<Readonly<{ status: "active" | "expired" | "revoked"; expiresAt: string | null }>> {
      throw new Error("revenuecat_not_composed");
    },
  });
}
