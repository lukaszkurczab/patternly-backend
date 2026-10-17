import {
  isSandboxPromotionalAccessAllowed,
  type SandboxPromotionalAccessPolicy,
} from "../../config/sandboxPromotionalAccess.js";
import { type PremiumMap, type StoreBinding } from "../../config/premiumMap.js";

export type RevenueCatEnvironment = "PRODUCTION" | "SANDBOX";

export type RevenueCatEntitlementState = "active" | "grace" | "hold" | "expired" | "refunded" | "unavailable";
export type RevenueCatSourceState = "active" | "grace" | "hold" | "paused" | "expired" | "refunded";
export type RevenueCatEntitlementSource = Readonly<StoreBinding & {
  state: RevenueCatSourceState;
  reason: "paused" | "account_hold" | null;
  managementURL: string | null;
  providerExpiresAt: string | null;
  providerGraceExpiresAt: string | null;
}>;

export type RevenueCatEntitlementResult = Readonly<{
  entitlement: string;
  productId: string;
  state: RevenueCatEntitlementState;
  providerExpiresAt: string | null;
  providerGraceExpiresAt: string | null;
  providerObservedAt: string;
  projectId: string;
  mapVersion: string;
  environment: RevenueCatEnvironment;
  reason: "paused" | "identity_conflict" | "promotional" | null;
  sources: readonly RevenueCatEntitlementSource[];
}>;

export type RevenueCatReaderConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  /** V2 scoped secret keys are separate from the V1 subscriber credential. */
  v2ApiKey?: string | undefined;
  entitlementId: string;
  productId: string;
  environment: RevenueCatEnvironment;
  firebaseProjectId?: string | undefined;
  revenueCatProjectId?: string | undefined;
  revenueCatAppId?: string | undefined;
  sandboxPromotionalAccess?: SandboxPromotionalAccessPolicy | null | undefined;
  premiumMap?: PremiumMap | null | undefined;
  allowTestFixtures?: boolean | undefined;
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
  options: { reason?: RevenueCatEntitlementResult["reason"]; sources?: readonly RevenueCatEntitlementSource[] } = {},
): RevenueCatEntitlementResult {
  const map = config.premiumMap;
  if (!map) throw new TypeError("revenuecat_map_required");
  return Object.freeze({
    entitlement: "premium",
    productId: "com.lkurczab.patternly.premium.monthly",
    state,
    providerExpiresAt,
    providerGraceExpiresAt,
    providerObservedAt,
    projectId: map.projectId,
    mapVersion: map.version,
    environment: map.environment,
    reason: options.reason ?? null,
    sources: Object.freeze([...(options.sources ?? [])]),
  });
}

function unavailable(config: RevenueCatReaderConfig, providerObservedAt: string): RevenueCatEntitlementResult {
  return makeResult(config, "unavailable", providerObservedAt);
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readPromotionalEntitlement(
  config: RevenueCatReaderConfig,
  userId: string,
  subscriber: JsonRecord,
  entitlement: JsonRecord,
  requestDate: { milliseconds: number; iso: string },
): RevenueCatEntitlementResult {
  const unavailableResult = unavailable(config, requestDate.iso);
  const policy = config.sandboxPromotionalAccess;
  const allowed = isSandboxPromotionalAccessAllowed(policy, {
    ...(config.firebaseProjectId === undefined ? {} : { firebaseProjectId: config.firebaseProjectId }),
    ...(config.revenueCatProjectId === undefined ? {} : { revenueCatProjectId: config.revenueCatProjectId }),
    ...(config.revenueCatAppId === undefined ? {} : { revenueCatAppId: config.revenueCatAppId }),
    revenueCatEnvironment: config.environment,
    revenueCatApiBaseUrl: config.baseUrl,
    accountId: userId,
  });
  if (!allowed || policy.customerId !== userId || subscriber.original_app_user_id !== userId) return unavailableResult;

  const productIdentifier = entitlement.product_identifier;
  if (!hasNonEmptyString(productIdentifier) || !productIdentifier.startsWith("rc_promo_")) return unavailableResult;
  const subscriptionsValue = subscriber.subscriptions;
  if (!isRecord(subscriptionsValue)) return unavailableResult;
  const subscription = subscriptionsValue[productIdentifier];
  if (!isRecord(subscription)
    || subscription.store !== "promotional"
    || subscription.is_sandbox !== false) return unavailableResult;

  const entitlementExpiresAt = parseProviderDate(entitlement.expires_date, false);
  const subscriptionExpiresAt = parseProviderDate(subscription.expires_date, false);
  const entitlementGraceAt = parseProviderDate(entitlement.grace_period_expires_date, true);
  const subscriptionGraceAt = parseProviderDate(subscription.grace_period_expires_date, true);
  const refundedAt = parseProviderDate(subscription.refunded_at, true);
  const billingIssueAt = parseProviderDate(subscription.billing_issues_detected_at, true);
  if (entitlementExpiresAt === undefined || entitlementExpiresAt === null
    || subscriptionExpiresAt === undefined || subscriptionExpiresAt === null
    || entitlementExpiresAt !== subscriptionExpiresAt
    || entitlementGraceAt !== null || subscriptionGraceAt !== null
    || refundedAt !== null || billingIssueAt !== null) return unavailableResult;

  const policyExpiresAtMs = Date.parse(policy.expiresAt);
  if (requestDate.milliseconds >= policyExpiresAtMs || Date.now() >= policyExpiresAtMs) return unavailableResult;
  const expiresAtMs = Math.min(Date.parse(entitlementExpiresAt), policyExpiresAtMs);
  if (expiresAtMs <= requestDate.milliseconds) return makeResult(config, "expired", requestDate.iso, new Date(expiresAtMs).toISOString(), null, { reason: "promotional" });
  return makeResult(config, "active", requestDate.iso, new Date(expiresAtMs).toISOString(), null, { reason: "promotional" });
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
  if (config.premiumMap && config.entitlementId !== config.premiumMap.entitlementId) throw new TypeError("revenuecat_entitlement_mismatch");
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

function parseV2Timestamp(value: unknown, allowNull = false): string | null | undefined {
  if (value === null && allowNull) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  try { return new Date(value).toISOString(); } catch { return undefined; }
}

function transactionId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

async function fetchAllPages(
  fetchImpl: RevenueCatFetch,
  firstUrl: string,
  apiKey: string,
  timeoutMs: number,
  requiredPrefix: string,
): Promise<JsonRecord[]> {
  const entries: JsonRecord[] = [];
  const visited = new Set<string>();
  let url: string | null = firstUrl;
  for (let pageCount = 0; url !== null; pageCount += 1) {
    if (pageCount >= 500 || visited.has(url)) throw new RevenueCatProviderUnavailableError("invalid_response");
    visited.add(url);
    const current: URL = new URL(url);
    const first = new URL(firstUrl);
    if (current.origin !== first.origin || !current.pathname.startsWith(requiredPrefix)) throw new RevenueCatProviderUnavailableError("invalid_response");
    const payload = await fetchJson(fetchImpl, url, apiKey, timeoutMs);
    if (!isRecord(payload) || !Array.isArray(payload.items)) throw new RevenueCatProviderUnavailableError("invalid_response");
    for (const item of payload.items) {
      if (!isRecord(item)) throw new RevenueCatProviderUnavailableError("invalid_response");
      entries.push(item);
    }
    const next = payload.next_page;
    if (next === undefined || next === null) url = null;
    else if (typeof next === "string" && next.length > 0) url = new URL(next, current).toString();
    else throw new RevenueCatProviderUnavailableError("invalid_response");
  }
  return entries;
}

function catalogBinding(map: PremiumMap, binding: StoreBinding, product: JsonRecord): boolean {
  const app = product.app;
  return isRecord(app) && product.id === binding.rcProductId && product.app_id === binding.appId
    && app.id === binding.appId && app.project_id === map.projectId
    && app.type === (binding.store === "APP_STORE" ? "app_store" : "play_store")
    && product.type === "subscription"
    && product.state === "active"
    && product.store_identifier === (binding.platform === "android" ? `${binding.storeProductId}:${binding.basePlanId}` : binding.storeProductId)
    ;
}

function parseV1Owner(payload: unknown, userId: string): { subscriber: JsonRecord; requestDate: { milliseconds: number; iso: string } } {
  if (!isRecord(payload) || !isRecord(payload.subscriber)) throw new RevenueCatProviderUnavailableError("invalid_response");
  const requestDate = parseRequestDate(payload.request_date_ms);
  if (!requestDate) throw new RevenueCatProviderUnavailableError("invalid_response");
  if (!isRecord(payload.subscriber.subscriptions) || !isRecord(payload.subscriber.entitlements)) throw new RevenueCatProviderUnavailableError("invalid_response");
  return { subscriber: payload.subscriber, requestDate };
}

function v1GraceEnd(
  subscriber: JsonRecord,
  binding: StoreBinding,
  expectedEnvironment: RevenueCatEnvironment,
  exactTransaction: string,
  entitlementId: string,
): string | undefined {
  const subscriptions = subscriber.subscriptions as JsonRecord;
  const key = binding.platform === "android" ? `${binding.storeProductId}:${binding.basePlanId}` : binding.storeProductId;
  const record = subscriptions[key];
  if (!isRecord(record) || record.store !== (binding.store === "APP_STORE" ? "app_store" : "play_store")
    || record.is_sandbox !== (expectedEnvironment === "SANDBOX") || transactionId(record.store_transaction_id) !== exactTransaction) return undefined;
  const grace = parseProviderDate(record.grace_period_expires_date, true);
  if (grace === undefined || grace === null) return undefined;
  const entitlementValue = (subscriber.entitlements as JsonRecord)[entitlementId];
  if (entitlementValue !== undefined && entitlementValue !== null) {
    if (!isRecord(entitlementValue)) return undefined;
    if (entitlementValue.product_identifier === key) {
      const entitlementGrace = parseProviderDate(entitlementValue.grace_period_expires_date, true);
      if (entitlementGrace === undefined || (entitlementGrace !== null && entitlementGrace !== grace)) return undefined;
    }
  }
  return grace;
}

function managementURL(value: unknown, store: StoreBinding["store"]): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    const expectedHost = store === "APP_STORE" ? url.hostname === "apps.apple.com" : url.hostname === "play.google.com";
    return url.protocol === "https:" && expectedHost && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
}

async function parseV2Result(
  config: RevenueCatReaderConfig,
  userId: string,
  v1Payload: unknown,
  subscriptions: JsonRecord[],
  products: JsonRecord[],
  entitlementResourceId: string,
): Promise<RevenueCatEntitlementResult> {
  const map = config.premiumMap!;
  const { subscriber, requestDate } = parseV1Owner(v1Payload, userId);
  if (subscriber.original_app_user_id !== userId) return makeResult(config, "unavailable", requestDate.iso, null, null, { reason: "identity_conflict" });
  const v2Rows: RevenueCatEntitlementSource[] = [];
  for (const subscription of subscriptions) {
    if (subscription.customer_id !== userId || subscription.original_customer_id !== userId) {
      return makeResult(config, "unavailable", requestDate.iso, null, null, { reason: "identity_conflict" });
    }
    if (subscription.product_id === null) {
      if (subscription.store !== "promotional") return unavailable(config, requestDate.iso);
      continue;
    }
    if (!hasNonEmptyString(subscription.product_id)) return unavailable(config, requestDate.iso);
    const matchingProducts = products.filter((product) => product.id === subscription.product_id);
    const premiumBinding = map.bindings.find((binding) => matchingProducts.some((product) => catalogBinding(map, binding, product)));
    const entitlementList = subscription.entitlements;
    if (!isRecord(entitlementList) || !Array.isArray(entitlementList.items)) return unavailable(config, requestDate.iso);
    if (entitlementList.next_page !== undefined && entitlementList.next_page !== null) return unavailable(config, requestDate.iso);
    const premiumEntitlements = entitlementList.items.filter((item) => isRecord(item) && item.id === entitlementResourceId && item.project_id === map.projectId);
    const claimsPremium = premiumEntitlements.length === 1;
    if (!premiumBinding) {
      if (subscription.gives_access === true && claimsPremium) return unavailable(config, requestDate.iso);
      continue;
    }
    const store = premiumBinding.store === "APP_STORE" ? "app_store" : "play_store";
    const environmentMatches = subscription.environment === (map.environment === "SANDBOX" ? "sandbox" : "production");
    if (subscription.store !== store || !environmentMatches || !claimsPremium || typeof subscription.gives_access !== "boolean"
      || typeof subscription.pending_payment !== "boolean" || typeof subscription.status !== "string") return unavailable(config, requestDate.iso);
    const end = parseV2Timestamp(subscription.ends_at, true);
    if (end === undefined) return unavailable(config, requestDate.iso);
    const management = managementURL(subscription.management_url, premiumBinding.store);
    if (management === undefined) return unavailable(config, requestDate.iso);
    let sourceState: RevenueCatSourceState;
    let reason: RevenueCatEntitlementSource["reason"] = null;
    let grace: string | null = null;
    const status = subscription.status;
    if (!["active", "in_grace_period", "in_billing_retry", "paused", "expired", "unknown", "trialing", "incomplete"].includes(status)) return unavailable(config, requestDate.iso);
    if (status === "unknown" || status === "trialing" || status === "incomplete" || subscription.pending_payment === true) return unavailable(config, requestDate.iso);
    if (subscription.gives_access) {
      if (status === "active") {
        if (!end || Date.parse(end) <= requestDate.milliseconds) return unavailable(config, requestDate.iso);
        sourceState = "active";
      } else if (status === "in_grace_period") {
        const exactTransaction = transactionId(subscription.store_subscription_identifier);
        if (!exactTransaction) return unavailable(config, requestDate.iso);
        grace = v1GraceEnd(subscriber, premiumBinding, map.environment, exactTransaction, config.entitlementId) ?? null;
        if (!grace || Date.parse(grace) <= requestDate.milliseconds) return unavailable(config, requestDate.iso);
        sourceState = "grace";
      } else return unavailable(config, requestDate.iso);
    } else if (status === "paused") {
      sourceState = "paused";
      reason = "paused";
    } else if (status === "in_billing_retry") {
      sourceState = "hold";
      reason = "account_hold";
    } else if (status === "expired") {
      sourceState = "expired";
    } else return unavailable(config, requestDate.iso);
    v2Rows.push(Object.freeze({ ...premiumBinding, state: sourceState, reason, managementURL: management, providerExpiresAt: end, providerGraceExpiresAt: grace }));
  }
  const accessSources = v2Rows.filter((row) => row.state === "active" || row.state === "grace");
  if (accessSources.length === 0) {
    const paused = v2Rows.some((row) => row.state === "paused");
    const hold = v2Rows.some((row) => row.state === "hold");
    return makeResult(config, paused ? "hold" : hold ? "hold" : "expired", requestDate.iso, null, null, { reason: paused ? "paused" : null, sources: v2Rows });
  }
  const winningSource = [...accessSources].sort((left, right) => {
    const leftEnd = left.state === "grace" ? left.providerGraceExpiresAt : left.providerExpiresAt;
    const rightEnd = right.state === "grace" ? right.providerGraceExpiresAt : right.providerExpiresAt;
    return Date.parse(rightEnd ?? "") - Date.parse(leftEnd ?? "");
  })[0];
  if (!winningSource || !winningSource.providerExpiresAt) return unavailable(config, requestDate.iso);
  return makeResult(config, winningSource.state === "active" ? "active" : "grace", requestDate.iso,
    winningSource.providerExpiresAt, winningSource.providerGraceExpiresAt, { sources: v2Rows });
}

export function createRevenueCatEntitlementReader(
  config: RevenueCatReaderConfig,
  optionsOrFetch?: RevenueCatReaderOptions | RevenueCatFetch,
): RevenueCatEntitlementReader {
  validateConfig(config);
  if (!config.premiumMap || (config.premiumMap.fixture && config.allowTestFixtures !== true)) throw new TypeError("revenuecat_map_required");
  if (config.revenueCatProjectId !== undefined && config.revenueCatProjectId !== config.premiumMap.projectId) throw new TypeError("revenuecat_project_mismatch");
  const normalizedConfig = Object.freeze({
    baseUrl: config.baseUrl.replace(/\/+$/u, ""),
    apiKey: config.apiKey,
    v2ApiKey: config.v2ApiKey,
    entitlementId: config.entitlementId,
    productId: config.productId,
    environment: config.environment,
    premiumMap: config.premiumMap,
    allowTestFixtures: config.allowTestFixtures,
    ...(config.firebaseProjectId === undefined ? {} : { firebaseProjectId: config.firebaseProjectId }),
    ...(config.revenueCatProjectId === undefined ? {} : { revenueCatProjectId: config.revenueCatProjectId }),
    ...(config.revenueCatAppId === undefined ? {} : { revenueCatAppId: config.revenueCatAppId }),
    ...(config.sandboxPromotionalAccess === undefined ? {} : { sandboxPromotionalAccess: config.sandboxPromotionalAccess }),
  });
  const { fetch: fetchImpl, timeoutMs } = resolveOptions(config, optionsOrFetch);

  return Object.freeze({
    async read(userId: string): Promise<RevenueCatEntitlementResult> {
      if (typeof userId !== "string") throw new TypeError("revenuecat_user_id_invalid");
      if (!hasNonEmptyString(userId)) throw new TypeError("revenuecat_user_id_invalid");
      const projectPath = `/v2/projects/${encodeURIComponent(normalizedConfig.premiumMap!.projectId)}`;
      const firstProducts = `${normalizedConfig.baseUrl}${projectPath}/products?expand=items.app`;
      const customerSubscriptions = `${normalizedConfig.baseUrl}${projectPath}/customers/${encodeURIComponent(userId)}/subscriptions`;
      const ownerUrl = `${normalizedConfig.baseUrl}/v1/subscribers/${encodeURIComponent(userId)}`;
      const v1Payload = await fetchJson(fetchImpl, ownerUrl, normalizedConfig.apiKey, timeoutMs);
      const ownerData = parseV1Owner(v1Payload, userId);
      if (ownerData.subscriber.original_app_user_id !== userId) {
        return makeResult(normalizedConfig, "unavailable", ownerData.requestDate.iso, null, null, { reason: "identity_conflict" });
      }
      const entitlement = (ownerData.subscriber.entitlements as JsonRecord)[normalizedConfig.premiumMap!.entitlementId];
      if (isRecord(entitlement) && hasNonEmptyString(entitlement.product_identifier) && entitlement.product_identifier.startsWith("rc_promo_")) {
        return readPromotionalEntitlement(normalizedConfig, userId, ownerData.subscriber, entitlement, ownerData.requestDate);
      }
      if (!normalizedConfig.v2ApiKey?.trim()) throw new RevenueCatProviderUnavailableError("invalid_response");
      const [productRows, subscriptionRows, entitlementRows] = await Promise.all([
        fetchAllPages(fetchImpl, firstProducts, normalizedConfig.v2ApiKey, timeoutMs, `${projectPath}/products`),
        fetchAllPages(fetchImpl, customerSubscriptions, normalizedConfig.v2ApiKey, timeoutMs, `${projectPath}/customers/${encodeURIComponent(userId)}/subscriptions`),
        fetchAllPages(fetchImpl, `${normalizedConfig.baseUrl}${projectPath}/entitlements`, normalizedConfig.v2ApiKey, timeoutMs, `${projectPath}/entitlements`),
      ]);
      const matchingEntitlements = entitlementRows.filter((entry) => entry.project_id === normalizedConfig.premiumMap!.projectId && entry.lookup_key === normalizedConfig.premiumMap!.entitlementId);
      if (matchingEntitlements.length !== 1 || !hasNonEmptyString(matchingEntitlements[0]?.id)) throw new RevenueCatProviderUnavailableError("invalid_response");
      for (const binding of normalizedConfig.premiumMap!.bindings) {
        if (productRows.filter((product) => catalogBinding(normalizedConfig.premiumMap!, binding, product)).length !== 1) {
          throw new RevenueCatProviderUnavailableError("invalid_response");
        }
      }
      return parseV2Result(normalizedConfig, userId, v1Payload, subscriptionRows, productRows, matchingEntitlements[0]!.id as string);
    },
  });
}
