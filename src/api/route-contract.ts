/**
 * Shared route vocabulary and path identity helpers.
 *
 * The OpenAPI document is the only method/path catalogue. This module must
 * stay free of endpoint entries so runtime inventory and documentation cannot
 * silently drift through two independently maintained route lists.
 */

export const ROUTE_SECURITY_PROFILES = [
  "public",
  "bearer",
  "app_check_optional_bearer",
  "admin",
  "webhook",
] as const;
export type RouteSecurityProfile = (typeof ROUTE_SECURITY_PROFILES)[number];

export const ROUTE_CONSUMER_SCOPES = ["backend-only", "diagnostic", "mobile", "web", "mobile+web"] as const;
export type RouteConsumerScope = (typeof ROUTE_CONSUMER_SCOPES)[number];

export const ROUTE_GUARDS = ["none", "bearer", "app_check_optional_bearer", "admin", "webhook"] as const;
export type RouteGuard = (typeof ROUTE_GUARDS)[number];

/** Fastify route paths and OpenAPI paths share this canonical identity. */
export function normalizeRoutePath(value: string): string {
  const withoutQuery = value.split(/[?#]/u, 1)[0] ?? value;
  const withBraces = withoutQuery.replace(/:([A-Za-z_][A-Za-z0-9_]*)(?:<[^>]+>)?/gu, "{$1}");
  const prefixed = withBraces.startsWith("/") ? withBraces : `/${withBraces}`;
  if (prefixed === "/") return prefixed;
  return prefixed.replace(/\/+$/u, "");
}
