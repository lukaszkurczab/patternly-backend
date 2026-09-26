import { createHash } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

import { progressDocumentId } from "../src/infrastructure/firestore/paths.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";

const PROJECT = "patternly-app-sandbox";
const TRACK = "coding-interview-dsa-problem-solving";
const ATTEMPT_ID = "profile06-e-preserved-attempt";
const SESSION_ID = "profile06-e-preserved-session";
const RESULT_ID = `${SESSION_ID}:result`;
const CONTENT_VERSION = "coding-interview-dsa-problem-solving-0004";
const ARTIFACT_SHA256 = "8a6ed5c1938e28588bb57856870c59ab5640fc6a88f25b577d473be57a282e94";

function requireLocalEnvironment(): string {
  if (process.env.FIREBASE_PROJECT_ID !== PROJECT
    || process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:19099"
    || process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:18081") throw new Error("profile06_e_local_emulators_required");
  const email = process.env.PROFILE06_E_EMAIL;
  if (!email || !email.endsWith("@example.test")) throw new Error("profile06_e_fixture_email_required");
  return email;
}

const command = process.argv[2];
if (!new Set(["prepare", "heal", "assert", "assert-healed", "cleanup"]).has(command ?? "")) throw new Error("profile06_e_fixture_command_required");
const email = requireLocalEnvironment();
const app = getApps()[0] ?? initializeApp({ projectId: PROJECT });
const authUser = await getAuth(app).getUserByEmail(email);
const db = getFirestore(app);
const mappings = await db.collection("identityMappings").where("provider", "==", "firebase").where("subject", "==", authUser.uid).get();
if (mappings.size !== 1) throw new Error("profile06_e_identity_mapping_ambiguous");
const accountId = mappings.docs[0]!.get("userId");
if (typeof accountId !== "string") throw new Error("profile06_e_account_id_invalid");
const metadataRef = db.collection("users").doc(accountId).collection("syncMetadata").doc("account");
const metadata = await metadataRef.get();
const generationValue = metadata.get("generation") ?? 0;
if (!Number.isSafeInteger(generationValue) || Number(generationValue) < 0) throw new Error("profile06_e_generation_invalid");
const generation = Number(generationValue);
const records = generation === 0
  ? db.collection("users").doc(accountId).collection("progress")
  : db.collection("users").doc(accountId).collection("progressGenerations").doc(String(generation)).collection("records");
const goalState = {
  schemaVersion: 1,
  revision: 1,
  record: { goalType: "prepare_for_an_interview", preferredDays: ["mon", "wed", "sat"], status: "active", trackId: TRACK, weeklySessionTarget: 3 },
};
const invalidPlanState = { schemaVersion: 1, revision: 1, plan: { schemaVersion: 99, trackId: TRACK } };
const validPlanState = { schemaVersion: 1, revision: 2, plan: { schemaVersion: 1, planId: "profile06-e-heal-plan", trackId: TRACK, goalRevision: 1, status: "accepted", timezone: "Europe/Warsaw", contentVersion: CONTENT_VERSION, artifactSha256: ARTIFACT_SHA256, acceptedTarget: { meaning: "none", targetDate: null }, createdAt: "2026-09-26T17:00:00.000Z", updatedAt: "2026-09-26T17:00:00.000Z", planRevision: 1, commandId: "profile06-e-heal-command", slots: [{ slotId: "profile06-e-heal-slot", day: "mon", localTime: "18:00", sessionLength: 10 }] } };
const item = { artifactSha256: ARTIFACT_SHA256, contentVersion: CONTENT_VERSION, questionId: "alg-arrays-duplicate-handling-001", trackId: TRACK };
const attemptState = {
  answeredAt: "2026-09-26T18:00:00.000Z",
  committedAt: "2026-09-26T18:00:00.000Z",
  id: ATTEMPT_ID,
  item,
  modeId: "practice",
  occurrenceId: "profile06-e-occurrence",
  response: { optionId: "first_occurrence_order", type: "choice_single" },
  result: { earnedPoints: 1, kind: "correct", maxPoints: 1 },
  reviewEvidence: { sourceItem: item, taxonomyOrSkillRefs: [{ axisId: "node", nodeId: "arrays_and_strings", role: "primary" }] },
  sessionId: SESSION_ID,
  trackId: TRACK,
};
const sessionState = {
  activeForegroundMs: 90_000,
  actualLength: 1,
  artifactSha256: ARTIFACT_SHA256,
  completedAt: "2026-09-26T18:01:30.000Z",
  conditionalReinsertSlots: [],
  configurationSnapshot: { kind: "practice" },
  contentVersion: CONTENT_VERSION,
  currentItemIndex: 0,
  id: SESSION_ID,
  itemOrder: [{ occurrenceId: "profile06-e-occurrence", item }],
  modeId: "practice",
  optionOrderByOccurrence: {},
  requestedLength: 1,
  startedAt: "2026-09-26T18:00:00.000Z",
  status: "completed",
  trackId: TRACK,
};
const resultState = {
  answeredOccurrenceIds: ["profile06-e-occurrence"],
  completedAt: "2026-09-26T18:01:30.000Z",
  evidence: { details: { source: "profile06-e-fixture" }, familyId: "coding_interview" },
  id: RESULT_ID,
  sessionId: SESSION_ID,
  totalOccurrences: 1,
  trackId: TRACK,
  unansweredOccurrenceIds: [],
};
const activeTrackState = { trackId: TRACK };
const activeTrackIdentity = { kind: "node" as const, recordType: "active_track" as const, trackId: TRACK, targetId: "current" };
const goalIdentity = { kind: "node" as const, recordType: "goal" as const, trackId: TRACK, targetId: TRACK };
const planIdentity = { kind: "node" as const, recordType: "learning_plan" as const, trackId: TRACK, targetId: TRACK };
const attemptIdentity = { kind: "item" as const, recordType: "training_attempt" as const, trackId: TRACK, targetId: ATTEMPT_ID };
const sessionIdentity = { kind: "node" as const, recordType: "training_session_summary" as const, trackId: TRACK, targetId: SESSION_ID };
const resultIdentity = { kind: "node" as const, recordType: "training_session_result" as const, trackId: TRACK, targetId: RESULT_ID };
const activeTrackRef = records.doc(progressDocumentId(activeTrackIdentity));
const goalRef = records.doc(progressDocumentId(goalIdentity));
const planRef = records.doc(progressDocumentId(planIdentity));
const attemptRef = records.doc(progressDocumentId(attemptIdentity));
const sessionRef = records.doc(progressDocumentId(sessionIdentity));
const resultRef = records.doc(progressDocumentId(resultIdentity));

if (command === "prepare") {
  const now = Timestamp.now();
  await activeTrackRef.set({ ...activeTrackIdentity, version: 2, state: activeTrackState, fingerprint: createMergeRecordFingerprint({ recordId: "current", recordType: "active_track", state: activeTrackState, trackId: TRACK }), lastMutationId: "profile06-e-active-track-fixture", updatedAt: now, ...(generation === 0 ? {} : { generation }) });
  await goalRef.set({ ...goalIdentity, version: 3, state: goalState, fingerprint: createMergeRecordFingerprint({ recordId: TRACK, recordType: "goal", state: goalState, trackId: TRACK }), lastMutationId: "profile06-e-goal-fixture", updatedAt: now, ...(generation === 0 ? {} : { generation }) });
  await planRef.set({ ...planIdentity, version: 9, state: invalidPlanState, fingerprint: createMergeRecordFingerprint({ recordId: TRACK, recordType: "learning_plan", state: invalidPlanState, trackId: TRACK }), lastMutationId: "profile06-e-invalid-plan", updatedAt: now, ...(generation === 0 ? {} : { generation }) });
  await attemptRef.set({ ...attemptIdentity, version: 4, state: attemptState, fingerprint: createMergeRecordFingerprint({ recordId: ATTEMPT_ID, recordType: "training_attempt", state: attemptState, trackId: TRACK }), lastMutationId: "profile06-e-attempt-fixture", updatedAt: now, ...(generation === 0 ? {} : { generation }) });
  await sessionRef.set({ ...sessionIdentity, version: 2, state: sessionState, fingerprint: createMergeRecordFingerprint({ recordId: SESSION_ID, recordType: "training_session_summary", state: sessionState, trackId: TRACK }), lastMutationId: "profile06-e-session-fixture", updatedAt: now, ...(generation === 0 ? {} : { generation }) });
  await resultRef.set({ ...resultIdentity, version: 2, state: resultState, fingerprint: createMergeRecordFingerprint({ recordId: RESULT_ID, recordType: "training_session_result", state: resultState, trackId: TRACK }), lastMutationId: "profile06-e-result-fixture", updatedAt: now, ...(generation === 0 ? {} : { generation }) });
}
if (command === "heal") {
  const now = Timestamp.now();
  await planRef.set({ ...planIdentity, version: 10, state: validPlanState, fingerprint: createMergeRecordFingerprint({ recordId: TRACK, recordType: "learning_plan", state: validPlanState, trackId: TRACK }), lastMutationId: "profile06-e-heal-plan", updatedAt: now, ...(generation === 0 ? {} : { generation }) });
}

const [activeTrack, goal, plan, attempt, session, result, accountMetadata] = await Promise.all([activeTrackRef.get(), goalRef.get(), planRef.get(), attemptRef.get(), sessionRef.get(), resultRef.get(), metadataRef.get()]);
if (command === "assert" || command === "assert-healed") {
  const expectedAccountRevision = Number(process.env.PROFILE06_E_EXPECTED_ACCOUNT_REVISION);
  if (!Number.isSafeInteger(expectedAccountRevision) || expectedAccountRevision < 0 || accountMetadata.get("accountRevision") !== expectedAccountRevision) {
    throw new Error("profile06_e_account_revision_changed");
  }
  const exact = (snapshot: FirebaseFirestore.DocumentSnapshot, expected: Readonly<{ fingerprint: string; lastMutationId: string }>) => snapshot.get("fingerprint") === expected.fingerprint
    && snapshot.get("lastMutationId") === expected.lastMutationId && snapshot.get("state.deleted") !== true;
  const expectedPlan = command === "assert-healed"
    ? { fingerprint: createMergeRecordFingerprint({ recordId: TRACK, recordType: "learning_plan", state: validPlanState, trackId: TRACK }), lastMutationId: "profile06-e-heal-plan", schemaVersion: 1, version: 10 }
    : { fingerprint: createMergeRecordFingerprint({ recordId: TRACK, recordType: "learning_plan", state: invalidPlanState, trackId: TRACK }), lastMutationId: "profile06-e-invalid-plan", schemaVersion: 99, version: 9 };
  if (!activeTrack.exists || activeTrack.get("version") !== 2 || activeTrack.get("state.trackId") !== TRACK
    || !goal.exists || goal.get("version") !== 3 || !plan.exists || plan.get("version") !== expectedPlan.version || plan.get("state.plan.schemaVersion") !== expectedPlan.schemaVersion
    || !attempt.exists || attempt.get("version") !== 4 || attempt.get("state.id") !== ATTEMPT_ID
    || !session.exists || session.get("version") !== 2 || session.get("state.status") !== "completed"
    || !result.exists || result.get("version") !== 2 || result.get("state.sessionId") !== SESSION_ID
    || !exact(activeTrack, { fingerprint: createMergeRecordFingerprint({ recordId: "current", recordType: "active_track", state: activeTrackState, trackId: TRACK }), lastMutationId: "profile06-e-active-track-fixture" })
    || !exact(goal, { fingerprint: createMergeRecordFingerprint({ recordId: TRACK, recordType: "goal", state: goalState, trackId: TRACK }), lastMutationId: "profile06-e-goal-fixture" })
    || !exact(plan, expectedPlan)
    || !exact(attempt, { fingerprint: createMergeRecordFingerprint({ recordId: ATTEMPT_ID, recordType: "training_attempt", state: attemptState, trackId: TRACK }), lastMutationId: "profile06-e-attempt-fixture" })
    || !exact(session, { fingerprint: createMergeRecordFingerprint({ recordId: SESSION_ID, recordType: "training_session_summary", state: sessionState, trackId: TRACK }), lastMutationId: "profile06-e-session-fixture" })
    || !exact(result, { fingerprint: createMergeRecordFingerprint({ recordId: RESULT_ID, recordType: "training_session_result", state: resultState, trackId: TRACK }), lastMutationId: "profile06-e-result-fixture" })) throw new Error("profile06_e_fixture_assertion_failed");
}
if (command === "cleanup") await Promise.all([activeTrackRef.delete(), goalRef.delete(), planRef.delete(), attemptRef.delete(), sessionRef.delete(), resultRef.delete()]);

process.stdout.write(`${JSON.stringify({ command, generation, accountRevision: accountMetadata.get("accountRevision") ?? 0, fixtureAccount: createHash("sha256").update(accountId).digest("hex").slice(0, 16), activeTrack: command === "cleanup" ? null : { exists: activeTrack.exists, version: activeTrack.get("version") }, goal: command === "cleanup" ? null : { exists: goal.exists, version: goal.get("version") }, plan: command === "cleanup" ? null : { exists: plan.exists, schemaVersion: plan.get("state.plan.schemaVersion"), version: plan.get("version") }, progress: command === "cleanup" ? null : { attemptVersion: attempt.get("version"), resultVersion: result.get("version"), sessionStatus: session.get("state.status"), sessionVersion: session.get("version") } })}\n`);
