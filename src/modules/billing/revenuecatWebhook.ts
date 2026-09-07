import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const revenueCatEventSchema = z.object({
  id: z.string().min(1), type: z.string().min(1), app_user_id: z.string().min(1).optional(),
  original_app_user_id: z.string().min(1).optional(), aliases: z.array(z.string().min(1)).optional(),
  event_timestamp_ms: z.number().int().safe().finite(), expiration_at_ms: z.number().int().safe().finite().nullable().optional(),
  purchased_at_ms: z.number().int().safe().finite().optional(),
  app_id: z.string().min(1), entitlement_ids: z.array(z.string()).optional(), product_id: z.string().min(1).optional(), environment: z.enum(["SANDBOX", "PRODUCTION"]),
  transaction_id: z.string().min(1).max(256).optional(), original_transaction_id: z.string().min(1).max(256).optional(),
  cancel_reason: z.string().optional(), expiration_reason: z.string().optional(), will_renew: z.boolean().optional(), transferred_from: z.array(z.string()).optional(), transferred_to: z.array(z.string()).optional(),
}).passthrough();
export type RevenueCatEvent = z.infer<typeof revenueCatEventSchema>;

export function verifyRevenueCatAuthorization(header: unknown, secret: string | undefined): boolean {
  if (typeof header !== "string" || !secret) return false;
  const a = Buffer.from(header); const b = Buffer.from(secret);
  const length = Math.max(a.length, b.length, 1);
  const paddedA = Buffer.alloc(length); const paddedB = Buffer.alloc(length);
  a.copy(paddedA); b.copy(paddedB);
  return timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}

export type EntitlementProjection = { status: "active" | "expired" | "refunded" | "revoked"; expiresAtMs: number | null; willRenew?: boolean; eventTimestampMs: number; eventId: string };
const active = new Set(["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "SUBSCRIPTION_EXTENDED", "REFUND_REVERSED"]);
export function reduceRevenueCatEvent(event: RevenueCatEvent, nowMs = Date.now(), maxFutureSkewMs = 5 * 60_000): EntitlementProjection | null {
  if (event.event_timestamp_ms > nowMs + maxFutureSkewMs) throw new Error("event_timestamp_future");
  if (active.has(event.type)) return { status: "active", expiresAtMs: event.expiration_at_ms ?? null, eventTimestampMs: event.event_timestamp_ms, eventId: event.id };
  if (event.type === "CANCELLATION") {
    return { status: "active", expiresAtMs: event.expiration_at_ms ?? null, willRenew: false, eventTimestampMs: event.event_timestamp_ms, eventId: event.id };
  }
  if (event.type === "EXPIRATION") return { status: event.expiration_reason === "CUSTOMER_SUPPORT" ? "refunded" : "expired", expiresAtMs: event.expiration_at_ms ?? null, willRenew: false, eventTimestampMs: event.event_timestamp_ms, eventId: event.id };
  if (["BILLING_ISSUE", "PRODUCT_CHANGE"].includes(event.type)) return null;
  return null;
}
