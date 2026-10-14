/** Canonical test facts used by transport/receipt tests, independent of the subject validators. */
export function attemptState(id: string, trackId: string, answer = "correct") {
  const item = { trackId, questionId: "fixture-question", contentVersion: "fixture-v1", artifactSha256: "a".repeat(64) };
  const correct = answer !== "incorrect";
  return { id, sessionId: "fixture-session", trackId, modeId: "fixture-mode", occurrenceId: `${id}:occurrence`, item,
    response: { type: "choice_single", optionId: answer },
    result: { kind: correct ? "correct" : "incorrect", earnedPoints: correct ? 1 : 0, maxPoints: 1 },
    reviewEvidence: { sourceItem: { ...item }, taxonomyOrSkillRefs: [] },
    answeredAt: "2026-10-14T10:00:00.000Z", committedAt: "2026-10-14T10:00:00.000Z" };
}
export function reviewState(id: string, trackId: string) {
  return { id, trackId, sourceAttemptId: "fixture-attempt", sourceSessionId: "fixture-session",
    sourceItem: { trackId, questionId: "fixture-question", contentVersion: "fixture-v1", artifactSha256: "a".repeat(64) }, taxonomyOrSkillRefs: [],
    reasons: ["incorrect"], createdAt: "2026-10-14T10:00:00.000Z", dueAt: "2026-10-15T10:00:00.000Z", consecutiveAfterDueSuccesses: 0, persistent: true };
}
