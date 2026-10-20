export type RevenueCatCustomerDeletionOutcome = Readonly<{ status: "accepted" | "absent" }>;

export interface RevenueCatCustomerDeletionClient {
  readonly projectId: string;
  deleteCustomer(appUserId: string, beforeDelete?: () => Promise<void>): Promise<RevenueCatCustomerDeletionOutcome>;
}

export type RevenueCatCustomerDeletionConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  projectId: string;
}>;

export type RevenueCatCustomerDeletionFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type RevenueCatCustomerDeletionOptions = Readonly<{
  fetch?: RevenueCatCustomerDeletionFetch;
  timeoutMs?: number;
  allowTestFixtures?: boolean;
}>;

export type RevenueCatCustomerDeletionStage = "configuration" | "search" | "aliases" | "delete" | "verify_absence";
export type RevenueCatCustomerDeletionFailureKind = "configuration" | "http" | "network" | "timeout" | "non_json" | "invalid_response" | "identity_conflict";

/** Safe failure category. Provider bodies, URLs, IDs and credentials are never included. */
export class RevenueCatCustomerDeletionError extends Error {
  public readonly code = "revenuecat_customer_deletion_failed" as const;

  public constructor(public readonly stage: RevenueCatCustomerDeletionStage, public readonly kind: RevenueCatCustomerDeletionFailureKind, public readonly status?: number) {
    super(`revenuecat_customer_deletion_failed:${stage}:${kind}`);
    this.name = "RevenueCatCustomerDeletionError";
  }
}

const PRODUCTION_ORIGIN = "https://api.revenuecat.com";
const DEFAULT_TIMEOUT_MS = 5_000;
const TIMEOUT = Symbol("revenuecat_customer_deletion_timeout");
const ANONYMOUS_ID = /^\$RCAnonymousID:.+$/u;
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(stage: RevenueCatCustomerDeletionStage, kind: RevenueCatCustomerDeletionFailureKind, status?: number): never {
  throw new RevenueCatCustomerDeletionError(stage, kind, status);
}

function validateConfig(config: RevenueCatCustomerDeletionConfig, options: RevenueCatCustomerDeletionOptions): { baseUrl: string; fetch: RevenueCatCustomerDeletionFetch; timeoutMs: number } {
  if (!isRecord(config) || typeof config.baseUrl !== "string" || typeof config.apiKey !== "string" || config.apiKey.length === 0 || config.apiKey !== config.apiKey.trim()
    || typeof config.projectId !== "string" || !/^proj[A-Za-z0-9]+$/u.test(config.projectId)) {
    return fail("configuration", "configuration");
  }
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { return fail("configuration", "configuration"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    return fail("configuration", "configuration");
  }
  const baseUrl = url.origin;
  if (baseUrl !== PRODUCTION_ORIGIN && options.allowTestFixtures !== true) return fail("configuration", "configuration");
  if (baseUrl !== PRODUCTION_ORIGIN && typeof options.fetch !== "function") return fail("configuration", "configuration");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fail("configuration", "configuration");
  return { baseUrl, fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)), timeoutMs };
}

function isSafeUrl(value: string, baseUrl: string, expectedPath: string): URL {
  let parsed: URL;
  try { parsed = new URL(value, baseUrl); } catch { return fail("aliases", "invalid_response"); }
  if (parsed.origin !== baseUrl || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== expectedPath || parsed.hash
    || [...parsed.searchParams.keys()].some((key) => key !== "starting_after" && key !== "limit")) {
    return fail("aliases", "invalid_response");
  }
  return parsed;
}

async function requestJson(
  fetchImpl: RevenueCatCustomerDeletionFetch,
  url: string,
  apiKey: string,
  timeoutMs: number,
  stage: RevenueCatCustomerDeletionStage,
  baseUrl: string,
): Promise<{ status: number; payload: unknown }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; controller.abort(); reject(TIMEOUT); }, timeoutMs);
  });
  try {
    const responsePromise = (async () => {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: stage === "delete" ? "DELETE" : "GET",
          headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        return fail(stage, "network");
      }
      if (response.redirected === true) fail(stage, "invalid_response");
      if (response.url) {
        let finalUrl: URL;
        try { finalUrl = new URL(response.url); } catch { fail(stage, "invalid_response"); }
        if (finalUrl.origin !== baseUrl) fail(stage, "invalid_response");
      }
      if (stage === "delete" && response.status === 404) return { status: 404, payload: null };
      if (response.status !== 200 || response.ok === false) fail(stage, "http", response.status);
      if (typeof response.json !== "function") fail(stage, "non_json", response.status);
      try { return { status: response.status, payload: await response.json() }; }
      catch { return fail(stage, "non_json", response.status); }
    })();
    return await Promise.race([responsePromise, timeout]);
  } catch (error) {
    if (error === TIMEOUT || timedOut) return fail(stage, "timeout");
    if (error instanceof RevenueCatCustomerDeletionError) throw error;
    return fail(stage, "network");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

function parseSearch(payload: unknown, projectId: string, stage: "search" | "verify_absence" = "search"): readonly string[] {
  if (!isRecord(payload) || payload.object !== "list" || !Array.isArray(payload.items)
    || !Object.hasOwn(payload, "next_page") || payload.next_page !== null) return fail(stage, "invalid_response");
  const ids: string[] = [];
  for (const item of payload.items) {
    if (!isRecord(item) || item.object !== "customer" || typeof item.id !== "string" || item.id.length === 0 || item.project_id !== projectId) {
      return fail(stage, "invalid_response");
    }
    ids.push(item.id);
  }
  return Object.freeze(ids);
}

function validateCanonicalCustomerId(customerId: string, appUserId: string): void {
  if (customerId !== appUserId && !ANONYMOUS_ID.test(customerId)) fail("search", "identity_conflict");
}

async function readAliases(
  input: { baseUrl: string; projectId: string; customerId: string; appUserId: string; apiKey: string; fetch: RevenueCatCustomerDeletionFetch; timeoutMs: number },
): Promise<void> {
  const path = `/v2/projects/${encodeURIComponent(input.projectId)}/customers/${encodeURIComponent(input.customerId)}/aliases`;
  let next: string | null = `${input.baseUrl}${path}?limit=100`;
  const visited = new Set<string>();
  let containsTarget = input.customerId === input.appUserId;
  for (let count = 0; next !== null; count += 1) {
    if (count >= 500 || visited.has(next)) fail("aliases", "invalid_response");
    visited.add(next);
    const safe = isSafeUrl(next, input.baseUrl, path);
    const result = await requestJson(input.fetch, safe.toString(), input.apiKey, input.timeoutMs, "aliases", input.baseUrl);
    const page = result.payload;
    if (!isRecord(page) || page.object !== "list" || !Array.isArray(page.items)
      || !Object.hasOwn(page, "next_page") || (page.next_page !== null && typeof page.next_page !== "string")) fail("aliases", "invalid_response");
    for (const item of page.items) {
      if (!isRecord(item) || item.object !== "customer.alias" || typeof item.id !== "string" || item.id.length === 0) fail("aliases", "invalid_response");
      if (item.id === input.appUserId) containsTarget = true;
      else if (item.id === input.customerId) continue;
      else if (!ANONYMOUS_ID.test(item.id)) fail("aliases", "identity_conflict");
    }
    if (typeof page.next_page === "string") {
      const following = isSafeUrl(page.next_page, input.baseUrl, path);
      next = following.toString();
    } else next = null;
  }
  if (!containsTarget) fail("aliases", "identity_conflict");
}

export function createRevenueCatCustomerDeletionClient(
  config: RevenueCatCustomerDeletionConfig,
  options: RevenueCatCustomerDeletionOptions = {},
): RevenueCatCustomerDeletionClient {
  const resolved = validateConfig(config, options);
  const normalized = Object.freeze({ ...resolved, projectId: config.projectId, apiKey: config.apiKey });
  return Object.freeze({
    projectId: normalized.projectId,
    async deleteCustomer(appUserId: string, beforeDelete?: () => Promise<void>): Promise<RevenueCatCustomerDeletionOutcome> {
      if (typeof appUserId !== "string" || appUserId.length === 0 || appUserId.length > 255) fail("configuration", "configuration");
      const encodedProject = encodeURIComponent(normalized.projectId);
      const searchUrl = new URL(`/v2/projects/${encodedProject}/customers`, normalized.baseUrl);
      searchUrl.searchParams.set("search", appUserId);
      searchUrl.searchParams.set("limit", "100");
      const lookup = await requestJson(normalized.fetch, searchUrl.toString(), normalized.apiKey, normalized.timeoutMs, "search", normalized.baseUrl);
      let customerIds = parseSearch(lookup.payload, normalized.projectId);
      if (customerIds.length === 0) return Object.freeze({ status: "absent" });
      if (customerIds.length !== 1 || new Set(customerIds).size !== 1) fail("search", "identity_conflict");
      const customerId = customerIds[0]!;
      validateCanonicalCustomerId(customerId, appUserId);
      await readAliases({ ...normalized, customerId, appUserId });
      if (beforeDelete) await beforeDelete();
      const deleteUrl = new URL(`/v2/projects/${encodedProject}/customers/${encodeURIComponent(customerId)}`, normalized.baseUrl);
      const deletion = await requestJson(normalized.fetch, deleteUrl.toString(), normalized.apiKey, normalized.timeoutMs, "delete", normalized.baseUrl);
      if (deletion.status === 404) {
        const verify = await requestJson(normalized.fetch, searchUrl.toString(), normalized.apiKey, normalized.timeoutMs, "verify_absence", normalized.baseUrl);
        const remaining = parseSearch(verify.payload, normalized.projectId, "verify_absence");
        if (remaining.length === 0) return Object.freeze({ status: "absent" });
        fail("delete", "http", 404);
      }
      if (!isRecord(deletion.payload) || deletion.payload.object !== "customer" || deletion.payload.id !== customerId
        || typeof deletion.payload.deleted_at !== "number" || !Number.isSafeInteger(deletion.payload.deleted_at) || deletion.payload.deleted_at < 0) {
        fail("delete", "invalid_response", deletion.status);
      }
      return Object.freeze({ status: "accepted" });
    },
  });
}
