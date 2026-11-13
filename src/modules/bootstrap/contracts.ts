/**
 * GET /v1/bootstrap aggregates the authenticated start-up reads that the
 * mobile client otherwise performs one after another:
 * GET /v1/me, GET /v1/entitlements, the first conditional GET /v1/progress
 * page and GET /v1/tracks.
 *
 * Every component carries the exact HTTP status and JSON body that its
 * standalone route would have returned for the same authenticated request.
 * A failing component therefore never hides the others, and a client can
 * feed `{ status, body }` into the parser it already uses for that route.
 */

import type { ProgressReadCondition } from "../progress/contracts.js";

export const BOOTSTRAP_VERSION = 1 as const;
export const BOOTSTRAP_COMPONENTS = ["me", "entitlements", "progress", "tracks"] as const;
export type BootstrapComponentName = (typeof BOOTSTRAP_COMPONENTS)[number];

/** Progress page size used by the aggregate; identical to the client's pageSize=100 first page. */
export const BOOTSTRAP_PROGRESS_PAGE_SIZE = 100;

export const BOOTSTRAP_QUERY_KEYS = ["include", "progressKnownSnapshot", "progressKnownScope", "progressKnownRevision"] as const;

export type BootstrapQuery = Readonly<{
  include: readonly BootstrapComponentName[];
  /** Same semantics as GET /v1/progress?conditional=1 knownSnapshot / knownScope+knownRevision. */
  progressCondition: ProgressReadCondition;
}>;

/** Exact status and JSON body of the standalone route for this component. */
export type BootstrapComponentResult = Readonly<{ status: number; body: unknown }>;

export type BootstrapResponse = Readonly<{
  bootstrapVersion: typeof BOOTSTRAP_VERSION;
  serverObservedAt: string;
  components: Readonly<Partial<Record<BootstrapComponentName, BootstrapComponentResult>>>;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^(0|[1-9][0-9]*)$/u;

export class BootstrapQueryError extends Error {
  public constructor() { super("invalid_request"); }
}

/** Parse the raw Fastify query. An unknown, repeated or malformed key is rejected before reading. */
export function parseBootstrapQuery(value: unknown): BootstrapQuery {
  const query = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(query)) {
    if (!(BOOTSTRAP_QUERY_KEYS as readonly string[]).includes(key) || typeof entry !== "string") throw new BootstrapQueryError();
  }
  let include: readonly BootstrapComponentName[] = BOOTSTRAP_COMPONENTS;
  if (query.include !== undefined) {
    const names = (query.include as string).split(",");
    if (names.length === 0 || names.some((name) => !(BOOTSTRAP_COMPONENTS as readonly string[]).includes(name)) || new Set(names).size !== names.length) {
      throw new BootstrapQueryError();
    }
    include = BOOTSTRAP_COMPONENTS.filter((name) => names.includes(name));
  }
  const knownSnapshot = query.progressKnownSnapshot as string | undefined;
  const knownScope = query.progressKnownScope as string | undefined;
  const knownRevision = query.progressKnownRevision as string | undefined;
  const hasScopeCondition = knownScope !== undefined || knownRevision !== undefined;
  const hasCondition = knownSnapshot !== undefined || hasScopeCondition;
  if (hasCondition && !include.includes("progress")) throw new BootstrapQueryError();
  if (knownSnapshot !== undefined && (hasScopeCondition || !SHA256.test(knownSnapshot))) throw new BootstrapQueryError();
  if (hasScopeCondition && (knownScope === undefined || knownRevision === undefined || !SHA256.test(knownScope)
    || !REVISION.test(knownRevision) || !Number.isSafeInteger(Number(knownRevision)))) throw new BootstrapQueryError();
  return Object.freeze({
    include: Object.freeze([...include]),
    progressCondition: Object.freeze({
      ...(knownSnapshot !== undefined ? { knownSnapshot } : {}),
      ...(hasScopeCondition ? { knownScope: knownScope!, knownRevision: Number(knownRevision) } : {}),
    }),
  });
}

export type BootstrapComponentReader = () => Promise<BootstrapComponentResult>;
export type BootstrapComponentTiming = Readonly<{ name: BootstrapComponentName; durationMs: number }>;

/**
 * Run the selected component readers concurrently. A reader that throws is
 * isolated through `onUnexpectedError`, which must return the same envelope
 * the standalone route's error handler would have produced (HTTP 500).
 */
export async function composeBootstrap(
  include: readonly BootstrapComponentName[],
  readers: Readonly<Record<BootstrapComponentName, BootstrapComponentReader>>,
  onUnexpectedError: (name: BootstrapComponentName, error: unknown) => BootstrapComponentResult,
  now: () => Date = () => new Date(),
): Promise<Readonly<{ response: BootstrapResponse; timings: readonly BootstrapComponentTiming[] }>> {
  const settled = await Promise.all(include.map(async (name) => {
    const startedAt = performance.now();
    let result: BootstrapComponentResult;
    try { result = await readers[name](); }
    catch (error) { result = onUnexpectedError(name, error); }
    return { name, result, durationMs: performance.now() - startedAt };
  }));
  const components: Partial<Record<BootstrapComponentName, BootstrapComponentResult>> = {};
  for (const entry of settled) components[entry.name] = Object.freeze({ status: entry.result.status, body: entry.result.body });
  return Object.freeze({
    response: Object.freeze({ bootstrapVersion: BOOTSTRAP_VERSION, serverObservedAt: now().toISOString(), components: Object.freeze(components) }),
    timings: Object.freeze(settled.map(({ name, durationMs }) => Object.freeze({ name, durationMs }))),
  });
}

/** RFC 8941-style Server-Timing value: one entry per component plus the aggregate wall time. */
export function bootstrapServerTiming(timings: readonly BootstrapComponentTiming[], totalMs: number): string {
  return [...timings.map(({ name, durationMs }) => `${name};dur=${durationMs.toFixed(1)}`), `total;dur=${totalMs.toFixed(1)}`].join(", ");
}
