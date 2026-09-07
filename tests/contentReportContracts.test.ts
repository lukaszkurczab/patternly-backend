import assert from "node:assert/strict";
import test from "node:test";
import { createContentReportSchema } from "../src/modules/content-reports/contracts.js";

const baseReport = {
  clientSubmissionId: "5f61e3f3-f23e-467c-b92a-9b8fd0514f25",
  trackId: "coding-interview-dsa-problem-solving",
  contentVersion: "2026.08.25",
  itemId: "two-sum-001",
  reason: "technical_issue" as const,
  context: {
    releasePackageId: "patternly-launch-2026-08-25-01",
    trackNode: "complexity_and_constraints",
    modeRoute: "practice_feedback_details" as const,
    locale: "en" as const,
    appBuild: "0.1.0",
    platform: "ios" as const,
    occurredAt: "2026-08-25T10:00:00.000Z",
  },
};

test("content report descriptions accept empty input only as a neutral safe fallback", () => {
  const parsed = createContentReportSchema.parse({ ...baseReport, description: "   " });
  assert.equal(parsed.description, "No additional details provided.");
  assert.equal(createContentReportSchema.safeParse({ ...baseReport, description: "x".repeat(280) }).success, true);
  assert.equal(createContentReportSchema.safeParse({ ...baseReport, description: "x".repeat(281) }).success, false);
});

test("content report descriptions reject contact details and obvious credentials", () => {
  for (const description of [
    "Contact me at learner@example.com.",
    "Call +48 600 700 800.",
    "See https://example.com/details.",
    "password: hunter2",
    "code: 123456",
    "kod jednorazowy: 123456",
    "ABCD-EFGH-IJKL-MNOP",
  ]) {
    assert.equal(createContentReportSchema.safeParse({ ...baseReport, description }).success, false, description);
  }
});

test("content report descriptions keep ordinary technical wording", () => {
  for (const description of [
    "The code example has the wrong complexity.",
    "The verification code explanation is unclear.",
  ]) {
    assert.equal(createContentReportSchema.safeParse({ ...baseReport, description }).success, true, description);
  }
});
