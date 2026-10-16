import { z } from "zod";
import { addUtcCalendarYears } from "../../infrastructure/time/utcCalendar.js";
import { addUtcCalendarMonths } from "../../infrastructure/time/utcCalendar.js";
import { RETENTION_POLICY } from "../retention/policy.js";

export const INCIDENT_CLASSIFICATIONS = ["triage", "breach_confirmed", "not_a_breach"] as const;
export const INCIDENT_DECISIONS = ["undecided", "required", "not_required"] as const;
export const AUTHORITY_DELIVERY_STATUSES = ["not_started", "submitted", "supplemented"] as const;
export const SUBJECT_NOTIFICATION_STATUSES = ["not_started", "prepared", "pending", "sent", "failed", "unknown"] as const;
export const SUBJECT_DELIVERY_STATUSES = ["pending", "sent", "failed", "unknown", "superseded"] as const;

export type IncidentClassification = (typeof INCIDENT_CLASSIFICATIONS)[number];
export type IncidentDecision = (typeof INCIDENT_DECISIONS)[number];
export type AuthorityDeliveryStatus = (typeof AUTHORITY_DELIVERY_STATUSES)[number];
export type SubjectNotificationStatus = (typeof SUBJECT_NOTIFICATION_STATUSES)[number];
export type SubjectDeliveryStatus = (typeof SUBJECT_DELIVERY_STATUSES)[number];

const text = (max: number) => z.string().trim().min(1).max(max);
const revision = { expectedRevision: z.number().int().nonnegative() } as const;
const recipient = z.string().trim().email().max(320);

export const createSecurityIncidentSchema = z.object({
  title: text(200), details: text(50_000), detectedAt: z.string().datetime(), occurredAt: z.string().datetime().optional(), containedAt: z.string().datetime().optional(),
  categories: text(4_000), dataSubjectCount: text(256), recordCount: text(256), specialData: z.boolean(),
  confidentialityImpact: text(2_000), integrityImpact: text(2_000), availabilityImpact: text(2_000), consequences: text(8_000),
  likelihood: text(1_000), severity: text(1_000), containment: text(8_000), remediation: text(8_000), prevention: text(8_000), postmortem: text(8_000),
}).strict();

export const securityIncidentActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("acknowledge_awareness"), ...revision }).strict(),
  z.object({ action: z.literal("classify"), classification: z.enum(INCIDENT_CLASSIFICATIONS), reason: text(4_000), ...revision }).strict(),
  z.object({ action: z.literal("correct_assessment"), reason: text(4_000), details: text(50_000), detectedAt: z.string().datetime(), occurredAt: z.string().datetime().optional(), containedAt: z.string().datetime().optional(), categories: text(4_000), dataSubjectCount: text(256), recordCount: text(256), specialData: z.boolean(), confidentialityImpact: text(2_000), integrityImpact: text(2_000), availabilityImpact: text(2_000), consequences: text(8_000), likelihood: text(1_000), severity: text(1_000), containment: text(8_000), remediation: text(8_000), prevention: text(8_000), postmortem: text(8_000), ...revision }).strict(),
  z.object({ action: z.literal("decide_authority"), decision: z.enum(["required", "not_required"]), reason: text(4_000), legalException: z.string().trim().max(4_000).optional(), ...revision }).strict(),
  z.object({ action: z.literal("prepare_authority_export"), payload: text(100_000), ...revision }).strict(),
  z.object({ action: z.literal("record_authority_submission"), channel: text(128), reference: text(512), evidence: text(20_000), supplementary: z.boolean().default(false), delayReason: z.string().trim().min(1).max(4_000).optional(), ...revision }).strict(),
  z.object({ action: z.literal("decide_subject"), decision: z.enum(["required", "not_required"]), reason: text(4_000), legalException: z.string().trim().max(4_000).optional(), ...revision }).strict(),
  z.object({ action: z.literal("prepare_subject_notification"), recipients: z.array(recipient).min(1).max(500), subject: text(300), text: text(50_000), ...revision }).strict(),
  z.object({ action: z.literal("send_subject_notification"), recipientPseudonym: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u), snapshotVersion: z.number().int().positive(), ...revision }).strict(),
  z.object({ action: z.literal("resolve_subject_notification_unknown"), deliveryId: z.string().uuid(), outcome: z.enum(["sent", "failed"]), reason: text(4_000), ...revision }).strict(),
  z.object({ action: z.literal("reconcile_subject_notifications"), ...revision }).strict(),
  z.object({ action: z.literal("set_legal_hold"), reason: text(4_000), reviewBy: z.string().datetime(), ...revision }).strict(),
  z.object({ action: z.literal("release_legal_hold"), reason: text(4_000), ...revision }).strict(),
  z.object({ action: z.literal("review_retention"), reason: text(4_000), nextReviewAt: z.string().datetime(), ...revision }).strict(),
  z.object({ action: z.literal("close"), reason: text(4_000), ...revision }).strict(),
]);

export type SecurityIncidentAction = z.infer<typeof securityIncidentActionSchema>;

export { addUtcCalendarYears };
export const incidentRetentionExpiry = (closedAt: Date, classification: "breach_confirmed" | "not_a_breach"): Date => classification === "breach_confirmed"
  ? addUtcCalendarYears(closedAt, RETENTION_POLICY.breachDocumentationYears)
  : addUtcCalendarMonths(closedAt, RETENTION_POLICY.nonBreachIncidentMonths);
export const incidentArtifactExpiry = (closedAt: Date): Date => new Date(closedAt.getTime() + RETENTION_POLICY.incidentWorkingRetentionDays * 24 * 60 * 60 * 1_000);
export const incidentDeadline = (awarenessAt: Date): Date => new Date(awarenessAt.getTime() + 72 * 60 * 60 * 1_000);
