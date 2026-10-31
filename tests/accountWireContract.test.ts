import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isAccountWireState } from "../src/modules/progress/accountWireState.js";

type AccountWireRecord = {
  recordId: string;
  recordType: string;
  trackId: string;
  state: Record<string, unknown>;
};
type WireGuard = (recordType: string, recordId: string, trackId: string, state: unknown) => boolean;
type AppAccountWireModule = Readonly<{ isAccountWireState: WireGuard }>;
type AppLegacyFixtureModule = Readonly<{
  terminalWireFixture: () => Promise<Readonly<{ snapshot: Readonly<{ records: readonly AccountWireRecord[] }> }>>;
}>;

const appRequire = createRequire(fileURLToPath(new URL("../../patternly/package.json", import.meta.url)));
const appGuard = (appRequire(fileURLToPath(new URL("../../patternly/src/domain/account/accountWireState.ts", import.meta.url))) as AppAccountWireModule).isAccountWireState;
const appLegacyFixture = (appRequire(fileURLToPath(new URL("../../patternly/src/testing/terminalWireFixture.ts", import.meta.url))) as AppLegacyFixtureModule).terminalWireFixture;
const fixture = JSON.parse(readFileSync(new URL("./fixtures/account-wire/acm-actual-export.json", import.meta.url), "utf8")) as Readonly<{
  schemaVersion: number;
  source: string;
  producer: string;
  currentBank: Readonly<{ trackId: string; contentVersion: string; artifactSha256: string }>;
  runtimeTrainingPin: Readonly<{ trackId: string; contentVersion: string; artifactSha256: string }>;
  ordinaryTrainingIdentity: Readonly<{ trackId: string; contentVersion: string; artifactSha256: string }>;
  records: readonly AccountWireRecord[];
}>;
const preAcmReaderFixtureUrl = new URL("./fixtures/account-wire/pre-acm-accountWireState.ts", import.meta.url);
const preAcmReader = (await import("./fixtures/account-wire/pre-acm-accountWireState.js")).isAccountWireState as WireGuard;

const guards = Object.freeze([appGuard, isAccountWireState]);

function assertAcceptedByBoth(record: AccountWireRecord, message: string): void {
  for (const guard of guards) assert.equal(guard(record.recordType, record.recordId, record.trackId, record.state), true, `${message}: ${guard === appGuard ? "APP" : "BACKEND"}`);
}

function assertRejectedByBoth(record: AccountWireRecord, message: string): void {
  for (const guard of guards) assert.equal(guard(record.recordType, record.recordId, record.trackId, record.state), false, `${message}: ${guard === appGuard ? "APP" : "BACKEND"}`);
}

function recordOfType(recordType: string): AccountWireRecord {
  const record = fixture.records.find((candidate) => candidate.recordType === recordType);
  assert.ok(record, `actual APP export must contain ${recordType}`);
  return structuredClone(record);
}

function moveAttemptToForeignTrack(record: AccountWireRecord): AccountWireRecord {
  const changed = structuredClone(record);
  const trackId = "foreign-track";
  changed.trackId = trackId;
  changed.state.trackId = trackId;
  (changed.state.item as Record<string, unknown>).trackId = trackId;
  ((changed.state.reviewEvidence as Record<string, unknown>).sourceItem as Record<string, unknown>).trackId = trackId;
  return changed;
}

test("backend vendors the canonical APP wire guard without drift", () => {
  const canonical = readFileSync(new URL("../../patternly/src/domain/account/accountWireState.ts", import.meta.url), "utf8");
  assert.equal(readFileSync(new URL("../src/modules/progress/accountWireState.ts", import.meta.url), "utf8"), canonical);
});

test("frozen pre-ACM APP reader rejects the new records whose fields it cannot represent", () => {
  const frozenReader = readFileSync(preAcmReaderFixtureUrl);
  assert.equal(createHash("sha256").update(frozenReader).digest("hex"), "c3971ca5920c0b5818e2f2af48922d8e62d0097a94b0d6b5b4941e69f21812a7");
  const rejected = fixture.records.filter((record) => !preAcmReader(record.recordType, record.recordId, record.trackId, record.state));
  assert.deepEqual(rejected.map(({ recordType, state }) => [recordType, recordType === "training_attempt" ? (state.response as Record<string, unknown>).type : null]).sort(), [
    ["training_attempt", "approach_choice"],
    ["training_session_result", null],
    ["training_session_summary", null],
  ].sort());
});

test("APP and backend guards accept the four exact records from a real APP account snapshot", () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.source, "buildAccountDataSnapshot");
  assert.equal(fixture.producer, "current-canonical-bank-session");
  assert.deepEqual(fixture.currentBank, {
    trackId: "coding-interview-dsa-problem-solving",
    contentVersion: "coding-interview-dsa-problem-solving-authoring-v2026.10.02-bizq01-04-bizq02-v2-bizq03-planning-v2-dsa-20261024-fixes-v1",
    artifactSha256: "f1f3277cc0a5a50289bc8edc921270aebed8d8bf4080ad328e9000d90c7159e1",
  });
  assert.deepEqual(fixture.runtimeTrainingPin, {
    trackId: fixture.currentBank.trackId,
    contentVersion: fixture.currentBank.contentVersion,
    artifactSha256: fixture.currentBank.artifactSha256,
  });
  assert.deepEqual(fixture.ordinaryTrainingIdentity, {
    trackId: fixture.currentBank.trackId,
    contentVersion: fixture.currentBank.contentVersion,
    artifactSha256: "a85fb2ca9f57315d76f34627c109aa8ebc25536c4b4684356d97236a09145a2d",
  });
  assert.equal(fixture.records.length, 4);
  assert.deepEqual(fixture.records.map(({ recordType, state }) => [recordType, (state.response as Record<string, unknown> | undefined)?.type ?? null]).sort(), [
    ["training_attempt", "approach_choice"],
    ["training_attempt", "choice_single"],
    ["training_session_result", null],
    ["training_session_summary", null],
  ].sort());
  for (const record of fixture.records) assertAcceptedByBoth(record, `actual APP ${record.recordType} ${record.recordId}`);
  for (const record of fixture.records.filter(({ recordType }) => recordType === "training_attempt")) {
    const item = record.state.item as Record<string, unknown>;
    assert.deepEqual([record.trackId, item.contentVersion, item.artifactSha256], [fixture.runtimeTrainingPin.trackId, fixture.runtimeTrainingPin.contentVersion, fixture.runtimeTrainingPin.artifactSha256]);
  }

  const q1 = fixture.records.find((record) => record.recordType === "training_attempt" && (record.state.response as Record<string, unknown>).type === "approach_choice")!;
  assert.equal((q1.state.item as Record<string, unknown>).questionId, "acm-b01-01-q1");
  assert.equal((q1.state.result as Record<string, unknown>).kind, "partial");
  assert.equal((q1.state.result as Record<string, unknown>).earnedPoints, 0, "the actual Q1 partial/0 attempt remains valid");

  const q2 = fixture.records.find((record) => record.recordType === "training_attempt" && (record.state.response as Record<string, unknown>).type === "choice_single")!;
  assert.equal((q2.state.item as Record<string, unknown>).questionId, "acm-b01-01-q2");
  assert.equal((q2.state.result as Record<string, unknown>).kind, "correct");
  assert.equal((q2.state.result as Record<string, unknown>).earnedPoints, 1);
});

test("APP and backend guards reject wrong-mode Q1, wrong-track Q1/Q2 and wrong-track result", () => {
  const wrongModeQ1 = recordOfType("training_attempt");
  wrongModeQ1.state.modeId = "coding-interview-guided-practice";
  assertRejectedByBoth(wrongModeQ1, "Q1 approach_choice outside ACM mode");

  const q1 = fixture.records.find((record) => record.recordType === "training_attempt" && (record.state.response as Record<string, unknown>).type === "approach_choice")!;
  assertRejectedByBoth(moveAttemptToForeignTrack(q1), "wrong-track Q1");

  const q2 = fixture.records.find((record) => record.recordType === "training_attempt" && (record.state.response as Record<string, unknown>).type === "choice_single")!;
  assertRejectedByBoth(moveAttemptToForeignTrack(q2), "wrong-track Q2 choice_single");

  const wrongTrackResult = recordOfType("training_session_result");
  wrongTrackResult.trackId = "foreign-track";
  wrongTrackResult.state.trackId = "foreign-track";
  assertRejectedByBoth(wrongTrackResult, "wrong-track ACM result");
});

test("APP and backend guards reject an ACM result with wrong family or partial aggregate metadata", () => {
  const wrongFamily = recordOfType("training_session_result");
  (wrongFamily.state.evidence as Record<string, unknown>).familyId = "design_interview";
  assertRejectedByBoth(wrongFamily, "ACM result with non-Coding family");

  const partialMetadata = recordOfType("training_session_result");
  delete ((partialMetadata.state.evidence as Record<string, unknown>).details as Record<string, unknown>).manifestVersion;
  assertRejectedByBoth(partialMetadata, "ACM result missing manifestVersion");
});

test("legacy APP-produced account records remain accepted by both guards", async () => {
  const legacy = await appLegacyFixture();
  assert.ok(legacy.snapshot.records.some((record) => record.recordType === "training_session_result"));
  assert.ok(legacy.snapshot.records.some((record) => record.recordType === "training_attempt"));
  for (const record of legacy.snapshot.records) assertAcceptedByBoth(record, `legacy APP ${record.recordType} ${record.recordId}`);
});
