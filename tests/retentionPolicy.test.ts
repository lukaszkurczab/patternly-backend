import assert from "node:assert/strict";
import test from "node:test";
import { addUtcCalendarMonths, addUtcCalendarYears } from "../src/infrastructure/time/utcCalendar.js";
import { RETENTION_POLICY } from "../src/modules/retention/policy.js";
import { incidentArtifactExpiry, incidentRetentionExpiry } from "../src/modules/security-incidents/contracts.js";
import { retentionUntilFromClosure } from "../src/modules/legal-requests/contracts.js";

test("canonical retention policy exposes the approved periods", () => {
  assert.equal(RETENTION_POLICY.contentReportDays, 30);
  assert.equal(RETENTION_POLICY.accountDeletionProofMonths, 12);
  assert.equal(RETENTION_POLICY.privacyRequestArchiveMonths, 12);
  assert.equal(RETENTION_POLICY.privacyRequestSecretRetentionDays, 30);
  assert.equal(RETENTION_POLICY.legalRequestMinimalArchiveMonths, 12);
  assert.equal(RETENTION_POLICY.legalClaimReviewMonths, 6);
  assert.equal(RETENTION_POLICY.disputeReviewMonths, 6);
  assert.equal(RETENTION_POLICY.breachDocumentationYears, 6);
  assert.equal(RETENTION_POLICY.breachReviewMonths, 12);
  assert.equal(RETENTION_POLICY.nonBreachIncidentMonths, 12);
  assert.equal(RETENTION_POLICY.incidentWorkingRetentionDays, 30);
  assert.equal(RETENTION_POLICY.ordinaryOperationalLogDays, 30);
  assert.equal(RETENTION_POLICY.selectedSecurityLogDays, 90);
});

test("calendar retention clamps leap dates and distinguishes working evidence from breach evidence", () => {
  const leap = new Date("2024-02-29T08:30:00.000Z");
  assert.equal(addUtcCalendarMonths(leap, 12).toISOString(), "2025-02-28T08:30:00.000Z");
  assert.equal(addUtcCalendarYears(leap, 6).toISOString(), "2030-02-28T08:30:00.000Z");
  assert.equal(retentionUntilFromClosure(leap, 12).toISOString(), "2025-02-28T08:30:00.000Z");
  assert.equal(incidentRetentionExpiry(leap, "not_a_breach").toISOString(), "2025-02-28T08:30:00.000Z");
  assert.equal(incidentRetentionExpiry(leap, "breach_confirmed").toISOString(), "2030-02-28T08:30:00.000Z");
  assert.equal(incidentArtifactExpiry(leap).getTime(), leap.getTime() + 30 * 86_400_000);
});
