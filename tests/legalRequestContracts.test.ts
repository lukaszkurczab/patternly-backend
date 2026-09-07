import assert from "node:assert/strict";
import test from "node:test";
import { complaintResponseDueAt, createLegalRequestSchema, legalRequestAdminActionSchema, retentionUntilFromClosure } from "../src/modules/legal-requests/contracts.js";

test("consumer request intake is bounded and distinguishes every approved route", () => {
  for (const kind of ["complaint", "withdrawal", "data_recovery", "suspension_appeal"] as const) {
    assert.equal(createLegalRequestSchema.safeParse({ kind, narrative: "Request details" }).success, true);
  }
  assert.equal(createLegalRequestSchema.safeParse({ kind: "complaint", narrative: "" }).success, false);
  assert.equal(createLegalRequestSchema.safeParse({ kind: "complaint", narrative: "x".repeat(4_001) }).success, false);
  assert.equal(createLegalRequestSchema.safeParse({ kind: "unknown", narrative: "Request details" }).success, false);
  assert.equal(createLegalRequestSchema.safeParse({ kind: "withdrawal", narrative: "Request details", password: "secret" }).success, false);
  assert.equal(createLegalRequestSchema.safeParse({ kind: "withdrawal" }).success, true);
  assert.equal(createLegalRequestSchema.safeParse({ kind: "complaint" }).success, false);
});

test("only a complaint receives the statutory fourteen-day response deadline", () => {
  const receivedAt = new Date("2026-01-25T12:00:00.000Z");
  assert.equal(complaintResponseDueAt(receivedAt, "complaint")?.toISOString(), "2026-02-08T12:00:00.000Z");
  assert.equal(complaintResponseDueAt(receivedAt, "withdrawal"), null);
  assert.equal(complaintResponseDueAt(receivedAt, "data_recovery"), null);
  assert.equal(complaintResponseDueAt(receivedAt, "suspension_appeal"), null);
});

test("closed consumer cases retain evidence for six calendar years", () => {
  assert.equal(retentionUntilFromClosure(new Date("2024-02-29T08:30:00.000Z")).toISOString(), "2030-03-01T08:30:00.000Z");
  assert.equal(retentionUntilFromClosure(new Date("2026-09-07T08:30:00.000Z")).toISOString(), "2032-09-07T08:30:00.000Z");
});

test("operator transitions require an expected revision and bounded response or hold reason", () => {
  assert.equal(legalRequestAdminActionSchema.safeParse({ action: "start_review", expectedRevision: 0 }).success, true);
  assert.equal(legalRequestAdminActionSchema.safeParse({ action: "answer", expectedRevision: 1, response: "Decision" }).success, true);
  assert.equal(legalRequestAdminActionSchema.safeParse({ action: "close", expectedRevision: 2 }).success, true);
  assert.equal(legalRequestAdminActionSchema.safeParse({ action: "set_legal_hold", expectedRevision: 3, active: true, reason: "Pending court matter" }).success, true);
  assert.equal(legalRequestAdminActionSchema.safeParse({ action: "answer", response: "Decision" }).success, false);
});
