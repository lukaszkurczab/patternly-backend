export const SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID = "patternly-app-sandbox" as const;
export const SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID = "proj8ae78267" as const;
export const SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID = "app7b06e9a4c1" as const;
export const REVENUECAT_OFFICIAL_API_BASE_URL = "https://api.revenuecat.com" as const;

export type SandboxPromotionalAccessPolicy = Readonly<{
  firebaseProjectId: typeof SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID;
  revenueCatProjectId: typeof SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID;
  revenueCatAppId: typeof SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID;
  customerId: string;
  expiresAt: string;
}>;

export type SandboxPromotionalAccessRuntime = Readonly<{
  firebaseProjectId?: string | undefined;
  revenueCatProjectId?: string | undefined;
  revenueCatAppId?: string | undefined;
  revenueCatEnvironment?: "PRODUCTION" | "SANDBOX" | undefined;
  revenueCatApiBaseUrl: string;
  accountId: string;
  nowMs?: number;
}>;

const POLICY_ERROR = "invalid_sandbox_promotional_access_config";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return undefined;
  const datePart = value.slice(0, 10);
  const calendarDate = new Date(`${datePart}T00:00:00.000Z`);
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== datePart) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  try { return new Date(timestamp).toISOString(); } catch { return undefined; }
}

/** Parse and pin the temporary grant to the reviewed sandbox projects. */
export function parseSandboxPromotionalAccessPolicy(value: string | undefined): SandboxPromotionalAccessPolicy | null {
  if (value === undefined) return null;
  if (value.length === 0) throw new Error(POLICY_ERROR);

  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(POLICY_ERROR); }
  if (!isRecord(parsed)
    || Object.keys(parsed).sort().join(",") !== "customerId,expiresAt,firebaseProjectId,revenueCatAppId,revenueCatProjectId"
    || parsed.firebaseProjectId !== SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID
    || parsed.revenueCatProjectId !== SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID
    || parsed.revenueCatAppId !== SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID
    || typeof parsed.customerId !== "string"
    || parsed.customerId.length === 0
    || parsed.customerId.trim() !== parsed.customerId
    || parsed.customerId.length > 256) throw new Error(POLICY_ERROR);

  const expiresAt = parseIsoDate(parsed.expiresAt);
  if (expiresAt === undefined) throw new Error(POLICY_ERROR);

  return Object.freeze({
    firebaseProjectId: SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID,
    revenueCatProjectId: SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID,
    revenueCatAppId: SANDBOX_PROMOTIONAL_REVENUECAT_APP_ID,
    customerId: parsed.customerId,
    expiresAt,
  });
}

/** Shared route/client guard for project, account, environment, URL and cutoff. */
export function isSandboxPromotionalAccessAllowed(
  policy: SandboxPromotionalAccessPolicy | null | undefined,
  runtime: SandboxPromotionalAccessRuntime,
): policy is SandboxPromotionalAccessPolicy {
  const nowMs = runtime.nowMs ?? Date.now();
  return policy !== null
    && policy !== undefined
    && runtime.firebaseProjectId === SANDBOX_PROMOTIONAL_FIREBASE_PROJECT_ID
    && policy.firebaseProjectId === runtime.firebaseProjectId
    && runtime.revenueCatProjectId === SANDBOX_PROMOTIONAL_REVENUECAT_PROJECT_ID
    && policy.revenueCatProjectId === runtime.revenueCatProjectId
    && policy.revenueCatAppId === runtime.revenueCatAppId
    && runtime.revenueCatEnvironment === "SANDBOX"
    && runtime.revenueCatApiBaseUrl.replace(/\/+$/u, "") === REVENUECAT_OFFICIAL_API_BASE_URL
    && runtime.accountId === policy.customerId
    && Number.isFinite(nowMs)
    && nowMs < Date.parse(policy.expiresAt);
}
