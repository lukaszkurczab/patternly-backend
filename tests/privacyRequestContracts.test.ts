import assert from "node:assert/strict";
import test from "node:test";
import {
  PRIVACY_RIGHT_POLICIES,
  addUtcCalendarMonths,
  createPublicPrivacyRequestSchema,
  initialPrivacyRequestDeadline,
  privacyRequestAdminActionSchema,
  transitionPrivacyRequest,
  type PrivacyRequestSnapshot,
} from "../src/modules/privacy-requests/contracts.js";

const at = (value: string) => new Date(value);
const snapshot = (overrides: Partial<PrivacyRequestSnapshot> = {}): PrivacyRequestSnapshot => ({
  status: "received",
  outcome: null,
  deadlineAt: at("2026-02-28T12:00:00.000Z"),
  extendedAt: null,
  responsePreparedAt: null,
  deliveredAt: null,
  closedAt: null,
  ...overrides,
});

test("calendar deadlines clamp to the last UTC day of shorter months", () => {
  assert.equal(initialPrivacyRequestDeadline(at("2026-01-31T12:00:00.000Z")).toISOString(), "2026-02-28T12:00:00.000Z");
  assert.equal(addUtcCalendarMonths(at("2024-01-31T12:00:00.000Z"), 1).toISOString(), "2024-02-29T12:00:00.000Z");
  assert.equal(addUtcCalendarMonths(at("2026-11-30T12:00:00.000Z"), 3).toISOString(), "2027-02-28T12:00:00.000Z");
});

test("extension is an event and can happen only once before the first deadline", () => {
  const action = privacyRequestAdminActionSchema.parse({ action: "extend", reason: "Complex request", noticeLocale: "en", expectedRevision: 0 });
  const extended = transitionPrivacyRequest(snapshot(), action, at("2026-02-20T12:00:00.000Z"));
  assert.equal(extended.status, "received");
  assert.equal(extended.deadlineAt.toISOString(), "2026-04-28T12:00:00.000Z");
  assert.throws(() => transitionPrivacyRequest(extended, action, at("2026-02-21T12:00:00.000Z")), /privacy_request_extension_invalid/u);
  assert.throws(() => transitionPrivacyRequest(snapshot(), action, at("2026-02-28T12:00:00.000Z")), /privacy_request_extension_invalid/u);
});

test("response preparation, delivery and closure remain distinct", () => {
  const reviewed = snapshot({ status: "in_review" });
  const prepare = privacyRequestAdminActionSchema.parse({ action: "prepare_response", outcome: "partially_fulfilled", response: "Redacted response", reason: "Third-party rights", complaintInformationIncluded: true, executionEvidence: "executor:export:123", expectedRevision: 2 });
  const ready = transitionPrivacyRequest(reviewed, prepare, at("2026-02-20T12:00:00.000Z"));
  assert.equal(ready.status, "response_ready");
  assert.equal(ready.deliveredAt, null);
  const delivered = transitionPrivacyRequest(ready, { action: "deliver", expectedRevision: 3 }, at("2026-02-21T12:00:00.000Z"));
  assert.equal(delivered.status, "partially_fulfilled");
  assert.equal(delivered.closedAt, null);
  const closed = transitionPrivacyRequest(delivered, { action: "close", expectedRevision: 4 }, at("2026-02-22T12:00:00.000Z"));
  assert.equal(closed.status, "closed");
});

test("invalid transitions and unproved responses fail closed", () => {
  assert.throws(() => transitionPrivacyRequest(snapshot(), { action: "deliver", expectedRevision: 0 }, new Date()), /privacy_request_transition_invalid/u);
  assert.equal(privacyRequestAdminActionSchema.safeParse({ action: "prepare_response", outcome: "fulfilled", response: "ok", reason: "done", complaintInformationIncluded: true, expectedRevision: 0 }).success, false);
  assert.equal(privacyRequestAdminActionSchema.safeParse({ action: "prepare_response", outcome: "refused", response: "no", reason: "reason", complaintInformationIncluded: false, executionEvidence: "decision:1", expectedRevision: 0 }).success, false);
});

test("public intake accepts bounded identifiers and rejects arbitrary shape", () => {
  assert.equal(createPublicPrivacyRequestSchema.safeParse({ email: "guest@example.com", right: "access", reportSubmissionIds: ["de305d54-75b4-431b-adb2-eb6b9e546014"] }).success, true);
  assert.equal(createPublicPrivacyRequestSchema.safeParse({ email: "guest@example.com", right: "access", accountId: "victim" }).success, false);
  assert.equal(createPublicPrivacyRequestSchema.safeParse({ email: "guest@example.com", right: "access", narrative: "x".repeat(2_001) }).success, false);
});

test("each right has an explicit executor and verification policy", () => {
  assert.deepEqual(Object.keys(PRIVACY_RIGHT_POLICIES).sort(), ["access", "consent_withdrawal", "erasure", "objection", "portability", "rectification", "restriction"]);
  assert.equal(PRIVACY_RIGHT_POLICIES.erasure.executor, "owner_confirmed_deletion");
  assert.equal(PRIVACY_RIGHT_POLICIES.access.accountVerification, "recent_reauthentication");
  assert.equal(PRIVACY_RIGHT_POLICIES.consent_withdrawal.executor, "consent_registry");
});
