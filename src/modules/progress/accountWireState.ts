/**
 * Closed account wire contract. Canonical source: APP domain/account.
 * Backend vendors this dependency-free file; the cross-repo contract test checks equality.
 * Dynamic dictionary keys below are identities, never extensible object fields.
 */
type R = Record<string, unknown>;
type Guard = (value: unknown) => boolean;
const object = (x: unknown): x is R => x !== null && typeof x === "object" && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const text: Guard = x => typeof x === "string" && x.trim().length > 0;
const string: Guard = x => typeof x === "string";
const bool: Guard = x => typeof x === "boolean";
const number: Guard = x => typeof x === "number" && Number.isFinite(x) && x >= 0;
const integer: Guard = x => number(x) && Number.isSafeInteger(x);
const positive: Guard = x => integer(x) && Number(x) > 0;
const timestamp: Guard = x => text(x) && Number.isFinite(Date.parse(String(x)));
const sha: Guard = x => typeof x === "string" && /^[a-f0-9]{64}$/u.test(x);
const one = (...values: readonly unknown[]): Guard => x => values.includes(x);
const list = (guard: Guard): Guard => x => Array.isArray(x) && x.every(guard);
const strings = list(text);
const optional = (x: R, key: string, guard: Guard) => !Object.hasOwn(x, key) || guard(x[key]);
function shape(x: unknown, required: Readonly<Record<string, Guard>>, extra: Readonly<Record<string, Guard>> = {}): x is R {
  return object(x) && Object.keys(x).every(key => Object.hasOwn(required, key) || Object.hasOwn(extra, key)) &&
    Object.entries(required).every(([key, guard]) => Object.hasOwn(x, key) && guard(x[key])) &&
    Object.entries(extra).every(([key, guard]) => optional(x, key, guard));
}
const dictionary = (guard: Guard): Guard => x => object(x) && Object.entries(x).every(([key, value]) => text(key) && guard(value));
const ref: Guard = x => shape(x, { trackId: text, questionId: text, contentVersion: text, artifactSha256: sha });
const stages = ["repair24", "repair7", "manual_requested", "retention7", "retention14", "retention28"] as const;
const legacyUnitProof: Guard = x => shape(x, { sourceItem: ref, nodeId: text, mentalUnitId: text });
const source: Guard = x => shape(x, { source: one("due_queue", "manual_request"), reviewEntryId: text, sourceAttemptId: text, dueAt: timestamp, policyVersion: text, stage: one(...stages, "legacy_active_unqualified") }, { manualRequestId: text, legacyUnitProof });
const occurrence: Guard = x => {
  if (!shape(x, { occurrenceId: text, item: ref }, { reviewSourceSnapshot: source })) return false;
  const snapshot = x.reviewSourceSnapshot as R | undefined;
  const proof = snapshot?.legacyUnitProof as R | undefined;
  return !proof || ["trackId", "contentVersion", "artifactSha256"].every(key => (proof.sourceItem as R)[key] === (x.item as R)[key]);
};
const branch: Guard = x => shape(x, { occurrence, optionOrder: strings });
const slot: Guard = x => shape(x, { slotId: text, sourceOccurrenceId: text, ordinaryBranch: branch, resolutionRule: one("incorrect_or_partial_after_three_materialized_submissions") }, { reviewedVariantBranch: branch, exactSourceBranch: branch });
const caseState: Guard = x => shape(x, { policyVersion: one("claude-case-evidence-v1"), caseId: text, caseVersion: text, priorExposedStepIds: strings, hintShownStepIds: strings, solutionExposedStepIds: strings });
const caseEvidence: Guard = x => shape(x, { policyVersion: one("claude-case-evidence-v1"), caseId: text, caseVersion: text, stepId: text, role: one("baseline", "contrast"), assistanceBeforeSubmit: bool, priorExposure: one("known", "unknown"), revealPolicy: one("after_durable_submit") });
const caseEnvelope: Guard = x => shape(x, { familyId: one("certification"), details: caseEvidence });
const evidenceRef: Guard = x => shape(x, { axisId: text, nodeId: text }, { role: text });
const reviewEvidence: Guard = x => shape(x, { sourceItem: ref, taxonomyOrSkillRefs: list(evidenceRef) }, { evidence: caseEnvelope });
const component: Guard = x => shape(x, { id: text, earnedPoints: number, maxPoints: positive }) && Number(x.earnedPoints) <= Number(x.maxPoints);
const attemptResult: Guard = x => shape(x, { kind: one("correct", "partial", "incorrect"), earnedPoints: number, maxPoints: positive }, { components: list(component) }) && Number(x.earnedPoints) <= Number(x.maxPoints);
const response: Guard = x => shape(x, { type: one("choice_single"), optionId: text }) ||
  shape(x, { type: one("choice_multiple"), optionIds: strings }) ||
  shape(x, { type: one("ordering"), orderedElementIds: strings }) ||
  shape(x, { type: one("complexity", "decision_matrix"), selectedValueIdsByDimension: dictionary(strings) });
const configuration: Guard = x => shape(x, { kind: text }, {
  timer: one("elapsedForeground", "countdownForeground", "absoluteDeadline"), feedbackMode: one("afterEachAnswer", "atSessionEnd"),
  answerChanges: one("none", "untilFinalSubmission"), submission: one("perItem", "manualOrForegroundTimeout"), reinsertEnabled: bool,
  mentalUnitId: text, caseBlockPolicy: one("claude-case-blocks-v1"), caseReviewPolicy: one("claude-case-review-v1"),
  preset: one("single_case"), caseId: text, caseVersion: text, policyVersion: one("claude-case-evidence-v1"),
  navigation: one("free", "linear"), timerDurationMs: positive, timerDeadlineAt: timestamp,
  simulationProfileId: text, simulationProfileVersion: text, simulationCaseId: text, simulationCaseVersion: text,
  simulationBlueprintId: text, simulationBlueprintVersion: text, simulationPoolId: text, simulationPoolVersion: text,
  simulationPolicyId: text, simulationPolicyVersion: text, flagging: one("available"), navigator: one("available"), sectionIds: strings,
});
const summary: Guard = x => shape(x, {
  schemaVersion: one("terminal-session-v1"), id: text, trackId: text, modeId: text, requestedLength: integer,
  status: one("completed", "abandoned"), startedAt: timestamp, durationMs: number,
  contentVersion: text, artifactSha256: sha, configurationSnapshot: configuration,
  itemOrder: x => Array.isArray(x) && x.length > 0 && x.every(occurrence), optionOrderByOccurrence: dictionary(strings), conditionalReinsertSlots: list(slot),
}, { completedAt: timestamp, taxonomyVersion: text, planFingerprint: sha, caseState, caseStates: list(caseState) }) &&
  (x.status !== "completed" || timestamp(x.completedAt)) && Number(x.requestedLength) >= (x.itemOrder as unknown[]).length;
const aggregateFields = { activeForegroundMs: number, correctCount: integer, partialCount: integer, incorrectCount: integer, pointsEarned: number, maxPoints: number };
const aggregate: Guard = x => shape(x, aggregateFields, { profileId: text, profileVersion: text });
const designResponses: Guard = x => shape(x, { requirements: string, architecture: string, tradeoffs: string, final_answer: string });
const designCompleteness: Guard = x => shape(x, { requirements: bool, architecture: bool, tradeoffs: bool, final_answer: bool });
const designResult: Guard = x => shape(x, { profileId: text, profileVersion: text, caseId: text, caseVersion: text, responsesByStage: designResponses, stageCompleteness: designCompleteness });
const resultEnvelope: Guard = x => shape(x, { familyId: one("certification", "coding_interview"), details: aggregate }) || shape(x, { familyId: one("design_interview"), details: x => aggregate(x) || designResult(x) });
const sessionResult: Guard = x => shape(x, { id: text, sessionId: text, trackId: text, totalOccurrences: positive, answeredOccurrenceIds: strings, unansweredOccurrenceIds: strings, completedAt: timestamp, evidence: resultEnvelope });
const attempt: Guard = x => shape(x, { id: text, sessionId: text, trackId: text, modeId: text, occurrenceId: text, item: ref, response, result: attemptResult, reviewEvidence, answeredAt: timestamp, committedAt: timestamp }, { durationMs: number });
const review: Guard = x => shape(x, {
  id: text, trackId: text, sourceAttemptId: text, sourceSessionId: text, sourceItem: ref, taxonomyOrSkillRefs: list(evidenceRef),
  reasons: list(one("incorrect", "partial", "hint_used", "wrong_pattern", "wrong_strategy", "complexity_error", "repeated_mistake", "scheduled_retrieval", "weak_taxonomy_area", "manual_mark")),
  createdAt: timestamp, consecutiveAfterDueSuccesses: integer, persistent: bool,
}, { dueAt: timestamp, lastReviewedAt: timestamp, policyVersion: text, stage: one(...stages), manualRequestId: text, status: one("active", "completed"), completedAt: timestamp, completedByAttemptId: text });
const days = one("mon", "tue", "wed", "thu", "fri", "sat", "sun");
const goal: Guard = x => shape(x, {
  goalType: one("prepare_for_an_interview", "prepare_for_a_certification", "build_foundations", "refresh_and_maintain_skills", "learn_at_own_pace"),
  preferredDays: list(days), status: one("active", "paused"), trackId: text, weeklySessionTarget: integer,
}, { targetDate: x => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(x) });
const planSlot: Guard = x => shape(x, { slotId: text, day: days, localTime: x => typeof x === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(x), sessionLength: positive });
const plannedMode: Guard = x => shape(x, { modeId: text, requestedLength: positive });
const execution: Guard = x => shape(x, { policyVersion: one("patternly-learning-execution-v1"), initialDiagnosis: x => x === null || plannedMode(x), practice: plannedMode });
const planningIdentity: Guard = x => shape(x, { contentVersion: text, artifactSha256: sha, policyVersion: text });
const planFields = {
  planId: text, trackId: text, goalRevision: positive, status: one("accepted", "paused", "completed"), timezone: text,
  contentVersion: text, artifactSha256: sha, acceptedTarget: (x: unknown) => shape(x, { meaning: one("event", "deadline", "checkpoint", "none"), targetDate: x => x === null || string(x) }),
  createdAt: timestamp, updatedAt: timestamp, planRevision: positive, commandId: text, slots: list(planSlot),
};
const plan: Guard = x => shape(x, { ...planFields, schemaVersion: one(1) }) || shape(x, { ...planFields, schemaVersion: one(2), minutesPerStudyDay: positive, executionPolicy: execution, planningPolicyIdentity: planningIdentity });
const guards: Readonly<Record<string, Guard>> = {
  active_track: x => shape(x, { trackId: text }), training_session_summary: summary,
  training_session_result: sessionResult, training_attempt: attempt, review_queue_entry: review,
  goal: x => shape(x, { schemaVersion: one(1), revision: positive, record: goal }),
  learning_plan: x => shape(x, { schemaVersion: one(1), revision: positive, plan }),
};
/** No coercion, stripping, fallback, or mutation. Domain semantics remain family-owned. */
export function isAccountWireState(recordType: string, recordId: string, trackId: string, state: unknown): boolean {
  if (!Object.hasOwn(guards, recordType)) return false;
  if (shape(state, { deleted: one(true) })) return true;
  if (!guards[recordType]!(state) || !object(state)) return false;
  if (recordType === "goal" || recordType === "learning_plan") {
    const nested = state[recordType === "goal" ? "record" : "plan"] as R;
    return recordId === trackId && nested.trackId === trackId;
  }
  if (state.trackId !== trackId) return false;
  if (recordType === "active_track") return recordId === "current";
  if (state.id !== recordId) return false;
  if (recordType === "training_attempt") {
    const item = state.item as R, evidence = state.reviewEvidence as R, sourceItem = evidence.sourceItem as R;
    return item.trackId === trackId && ["trackId", "questionId", "contentVersion", "artifactSha256"].every(key => item[key] === sourceItem[key]) &&
      (!Object.hasOwn(evidence, "evidence") || trackId === "claude-certified-architect-professional-certification");
  }
  if (recordType === "review_queue_entry") return (state.sourceItem as R).trackId === trackId;
  if (recordType === "training_session_summary") {
    const planPinsMatch = (state.itemOrder as R[]).every(entry => {
      const item = entry.item as R;
      return item.trackId === trackId && item.contentVersion === state.contentVersion && item.artifactSha256 === state.artifactSha256;
    });
    const branches = (state.conditionalReinsertSlots as R[]).flatMap(slot => [slot.ordinaryBranch, slot.reviewedVariantBranch, slot.exactSourceBranch].filter(object));
    return planPinsMatch && branches.every(branch => {
      const snapshot = (branch.occurrence as R).reviewSourceSnapshot as R | undefined;
      const proof = snapshot?.legacyUnitProof as R | undefined;
      if (!proof) return true;
      const sourceItem = proof.sourceItem as R;
      return sourceItem.trackId === trackId && sourceItem.contentVersion === state.contentVersion && sourceItem.artifactSha256 === state.artifactSha256;
    });
  }
  return true;
}
