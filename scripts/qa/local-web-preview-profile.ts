import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { getAuth } from "firebase-admin/auth";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { COLLECTIONS, contentVersionDocumentId, identityDocumentId } from "../../src/infrastructure/firestore/paths.js";
import { FirestoreProgressStore } from "../../src/modules/progress/store.js";
import { progressMutationSchema, type ProgressMutation } from "../../src/modules/progress/contracts.js";
import { createMergeRecordFingerprint } from "../../src/modules/users/merge.js";

const PROJECT_ID = "patternly-app-sandbox";
const AUTH_HOST = "127.0.0.1:19099";
const FIRESTORE_HOST = "127.0.0.1:18081";
const DEMO_EMAIL = "web10a-ios-20261017@example.test";
const TRACK_ID = "coding-interview-dsa-problem-solving";
const MODE_ID = "coding-interview-independent-practice";
const REQUESTED_LENGTH = 10;
const APP_ARTIFACT_SHA256 = "73178e6205688aae2e830975fc0fa7eb78197b8f291b0cae0046300f7156b173";
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../patternly");
const contentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../patternly-content");
const bundlePath = path.join(appRoot, "src/content/generated/canonical-content", `${TRACK_ID}.json`);
const lockPath = path.join(appRoot, "src/content/generated/canonical-content/content-lock.json");

type AppQuestion = {
  questionId: string;
  trackId: string;
  interaction: { type: string; options?: Array<{ optionId: string }> };
  answer: { type: string; optionId: string };
  nodeId: string;
  mentalUnitId: string;
};

function stop(code: string): never { throw new Error(code); }
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

function guardEmulatorEnvironment(): void {
  const envProject = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID;
  if (envProject !== undefined && envProject !== PROJECT_ID) stop("runtime_project_not_allowed");
  for (const [key, expected] of [["FIREBASE_AUTH_EMULATOR_HOST", AUTH_HOST], ["FIRESTORE_EMULATOR_HOST", FIRESTORE_HOST]] as const) {
    const current = process.env[key];
    if (current !== undefined && current !== expected) stop("runtime_emulator_host_not_allowed");
    process.env[key] = expected;
  }
}

async function verifyProducerBundle(): Promise<{ bytes: Buffer; contentVersion: string; sha256: string; questionCount: number }> {
  const validation = spawnSync("npm", ["run", "content:validate", "--", "--track", TRACK_ID], { cwd: contentRoot, encoding: "utf8", timeout: 120_000 });
  if (validation.status !== 0) stop("content_producer_validation_failed");
  const outputRoot = await mkdtemp(path.join(tmpdir(), "patternly-web-preview-content-"));
  try {
    const build = spawnSync("npm", ["run", "content:build", "--", "--track", TRACK_ID, "--output-root", outputRoot], { cwd: contentRoot, encoding: "utf8", timeout: 120_000 });
    if (build.status !== 0) stop("content_producer_build_failed");
    const [builtBytes, bundleBytes, lockBytes] = await Promise.all([
      readFile(path.join(outputRoot, `${TRACK_ID}.json`)), readFile(bundlePath), readFile(lockPath),
    ]);
    const builtSha = sha256(builtBytes);
    const bundleSha = sha256(bundleBytes);
    if (!builtBytes.equals(bundleBytes) || bundleSha !== APP_ARTIFACT_SHA256) stop("app_bundle_differs_from_verified_producer");
    const bundle = JSON.parse(bundleBytes.toString("utf8")) as { trackId?: string; contentVersion?: string; questions?: AppQuestion[] };
    const lock = JSON.parse(lockBytes.toString("utf8")) as { tracks?: Array<{ trackId: string; contentVersion: string; questionCount: number; sha256: string }> };
    const entry = lock.tracks?.find((candidate) => candidate.trackId === TRACK_ID);
    if (bundle.trackId !== TRACK_ID || !bundle.contentVersion || !Array.isArray(bundle.questions) || !entry
      || entry.contentVersion !== bundle.contentVersion || entry.questionCount !== bundle.questions.length || entry.sha256 !== bundleSha || builtSha !== entry.sha256) {
      stop("app_bundle_lock_mismatch");
    }
    return { bytes: bundleBytes, contentVersion: bundle.contentVersion, sha256: bundleSha, questionCount: bundle.questions.length };
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

function mutationsFor(questions: AppQuestion[], contentVersion: string, artifactSha256: string): { mutations: ProgressMutation[]; sessionId: string } {
  const candidates = questions.filter((question) => question.trackId === TRACK_ID && question.interaction?.type === "choice_single"
    && question.answer?.type === "choice_single" && question.nodeId && question.mentalUnitId
    && Array.isArray(question.interaction.options) && question.interaction.options.length >= 2
    && question.interaction.options.some((option) => option.optionId === question.answer.optionId));
  if (candidates.length < REQUESTED_LENGTH) stop("verified_bundle_has_too_few_single_choice_items");
  const selected = candidates.slice(0, REQUESTED_LENGTH);
  const sessionId = `web10a-ios-demo-${randomUUID()}`;
  const now = Date.now();
  const startedAt = new Date(now - 8 * 60_000).toISOString();
  const completedAt = new Date(now - 90_000).toISOString();
  const refs = selected.map((question) => ({ trackId: TRACK_ID, questionId: question.questionId, contentVersion, artifactSha256 }));
  const occurrences = selected.map((question, index) => ({ occurrenceId: `${sessionId}:occurrence:${index + 1}`, item: { ...refs[index]! } }));
  const optionOrderByOccurrence = Object.fromEntries(selected.map((question, index) => [occurrences[index]!.occurrenceId, question.interaction.options!.map(({ optionId }) => optionId)]));
  const summary = {
    schemaVersion: "terminal-session-v1", id: sessionId, trackId: TRACK_ID, modeId: MODE_ID, requestedLength: REQUESTED_LENGTH,
    status: "completed", startedAt, completedAt, durationMs: 390_000, contentVersion, artifactSha256,
    configurationSnapshot: { kind: "practice", timer: "elapsedForeground", feedbackMode: "afterEachAnswer", answerChanges: "none", submission: "perItem", reinsertEnabled: false },
    itemOrder: occurrences, optionOrderByOccurrence, conditionalReinsertSlots: [],
  };
  const correctCount = 7;
  const attempts = selected.map((question, index) => {
    const occurrenceId = occurrences[index]!.occurrenceId;
    const correct = index < correctCount;
    const optionId = correct ? question.answer.optionId : question.interaction.options!.find((option) => option.optionId !== question.answer.optionId)!.optionId;
    const timestamp = new Date(now - 7 * 60_000 + (index + 1) * 30_000).toISOString();
    const id = `${sessionId}:attempt:${index + 1}`;
    return {
      id, sessionId, trackId: TRACK_ID, modeId: MODE_ID, occurrenceId, item: { ...refs[index]! },
      response: { type: "choice_single", optionId },
      result: { kind: correct ? "correct" : "incorrect", earnedPoints: correct ? 1 : 0, maxPoints: 1 },
      reviewEvidence: {
        sourceItem: { ...refs[index]! },
        taxonomyOrSkillRefs: [
          { axisId: "node", nodeId: question.nodeId, role: "primary" },
          { axisId: "mental_unit", nodeId: question.mentalUnitId, role: "primary" },
        ],
      },
      answeredAt: timestamp, committedAt: timestamp, durationMs: 30_000,
    };
  });
  const result = {
    id: `${sessionId}:result`, sessionId, trackId: TRACK_ID, totalOccurrences: REQUESTED_LENGTH,
    answeredOccurrenceIds: occurrences.map(({ occurrenceId }) => occurrenceId), unansweredOccurrenceIds: [], completedAt,
    evidence: { familyId: "coding_interview", details: { activeForegroundMs: 390_000, correctCount, partialCount: 0, incorrectCount: REQUESTED_LENGTH - correctCount, pointsEarned: correctCount, maxPoints: REQUESTED_LENGTH } },
  };
  const states = [
    { recordType: "training_session_summary" as const, kind: "node" as const, targetId: sessionId, state: summary },
    ...attempts.map((state) => ({ recordType: "training_attempt" as const, kind: "item" as const, targetId: state.id, state })),
    { recordType: "training_session_result" as const, kind: "node" as const, targetId: result.id, state: result },
  ];
  const mutations = states.map(({ recordType, kind, targetId, state }, index): ProgressMutation => ({
    mutationId: `web10a_${sessionId.replaceAll("-", "")}_${String(index).padStart(2, "0")}`,
    kind, recordType, trackId: TRACK_ID, targetId, expectedVersion: null,
    fingerprint: createMergeRecordFingerprint({ recordId: targetId, recordType, trackId: TRACK_ID, state }), state,
  }));
  for (const mutation of mutations) {
    const parsed = progressMutationSchema.safeParse(mutation);
    if (!parsed.success) {
      console.error(JSON.stringify({ recordType: mutation.recordType, issues: parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code, message: issue.message })) }));
      stop("synthetic_progress_wire_shape_invalid");
    }
  }
  return { mutations, sessionId };
}

function assertSyntheticSnapshot(snapshot: Awaited<ReturnType<FirestoreProgressStore["readSnapshot"]>>, questions: AppQuestion[], contentVersion: string, artifactSha256: string) {
  const trackRecords = snapshot.records.filter((record) => record.trackId === TRACK_ID);
  const summaries = trackRecords.filter((record) => record.recordType === "training_session_summary" && record.state.id === record.targetId
    && typeof record.targetId === "string" && record.targetId.startsWith("web10a-ios-demo-") && record.state.status === "completed");
  if (summaries.length !== 1) stop("synthetic_session_summary_readback_mismatch");
  const summaryRecord = summaries[0]!;
  const summary = summaryRecord.state;
  const sessionId = summaryRecord.targetId;
  const itemOrder = summary.itemOrder as Array<{ occurrenceId: string; item: Record<string, unknown> }>;
  if (summary.trackId !== TRACK_ID || summary.modeId !== MODE_ID || summary.requestedLength !== REQUESTED_LENGTH
    || summary.contentVersion !== contentVersion || summary.artifactSha256 !== artifactSha256 || itemOrder.length !== REQUESTED_LENGTH
    || summary.completedAt === undefined || Date.parse(String(summary.startedAt)) > Date.parse(String(summary.completedAt))) stop("synthetic_session_summary_readback_mismatch");
  const byQuestion = new Map(questions.map((question) => [question.questionId, question]));
  const attempts = trackRecords.filter((record) => record.recordType === "training_attempt" && record.state.sessionId === sessionId);
  if (attempts.length !== REQUESTED_LENGTH) stop("synthetic_attempt_readback_mismatch");
  let correctCount = 0;
  let incorrectCount = 0;
  const expectedAttemptIds = new Set<string>();
  for (let index = 0; index < itemOrder.length; index += 1) {
    const occurrence = itemOrder[index]!;
    const question = byQuestion.get(String(occurrence.item.questionId));
    const attempt = attempts.find((candidate) => candidate.state.occurrenceId === occurrence.occurrenceId);
    if (!question || !attempt || attempt.targetId !== `${sessionId}:attempt:${index + 1}` || attempt.state.id !== attempt.targetId
      || attempt.state.trackId !== TRACK_ID || attempt.state.modeId !== MODE_ID || !isDeepStrictEqual(attempt.state.item, occurrence.item)
      || occurrence.item.trackId !== TRACK_ID || occurrence.item.contentVersion !== contentVersion || occurrence.item.artifactSha256 !== artifactSha256
      || !isDeepStrictEqual(attempt.state.reviewEvidence && (attempt.state.reviewEvidence as Record<string, unknown>).sourceItem, occurrence.item)
      || createMergeRecordFingerprint({ recordId: attempt.targetId, recordType: attempt.recordType, trackId: attempt.trackId, state: attempt.state }) !== attempt.fingerprint) {
      stop("synthetic_attempt_readback_mismatch");
    }
    expectedAttemptIds.add(attempt.targetId);
    const response = attempt.state.response as Record<string, unknown>;
    const expectedCorrect = index < 7;
    if (question.answer.optionId === response.optionId && expectedCorrect && (attempt.state.result as Record<string, unknown>).kind === "correct") correctCount += 1;
    else if (question.answer.optionId !== response.optionId && !expectedCorrect && (attempt.state.result as Record<string, unknown>).kind === "incorrect") incorrectCount += 1;
    else stop("synthetic_attempt_outcome_readback_mismatch");
  }
  const resultId = `${sessionId}:result`;
  const results = trackRecords.filter((record) => record.recordType === "training_session_result" && record.targetId === resultId && record.state.sessionId === sessionId);
  if (results.length !== 1 || correctCount !== 7 || incorrectCount !== 3 || trackRecords.length !== REQUESTED_LENGTH + 2 || snapshot.generation !== 0
    || snapshot.accountRevision !== REQUESTED_LENGTH + 2 || !expectedAttemptIds.has(`${sessionId}:attempt:${REQUESTED_LENGTH}`)) stop("synthetic_progress_readback_mismatch");
  const resultState = results[0]!.state;
  const evidence = resultState.evidence as Record<string, unknown>;
  const details = evidence.details as Record<string, unknown>;
  if (resultState.totalOccurrences !== REQUESTED_LENGTH || (resultState.answeredOccurrenceIds as string[]).length !== REQUESTED_LENGTH
    || (resultState.unansweredOccurrenceIds as string[]).length !== 0 || evidence.familyId !== "coding_interview"
    || details.correctCount !== 7 || details.partialCount !== 0 || details.incorrectCount !== 3 || details.pointsEarned !== 7 || details.maxPoints !== REQUESTED_LENGTH
    || createMergeRecordFingerprint({ recordId: results[0]!.targetId, recordType: results[0]!.recordType, trackId: results[0]!.trackId, state: resultState }) !== results[0]!.fingerprint) {
    stop("synthetic_result_readback_mismatch");
  }
  if (createMergeRecordFingerprint({ recordId: summaryRecord.targetId, recordType: summaryRecord.recordType, trackId: summaryRecord.trackId, state: summary }) !== summaryRecord.fingerprint) stop("synthetic_summary_fingerprint_mismatch");
  return { generation: snapshot.generation, accountRevision: snapshot.accountRevision, trackRecordCount: trackRecords.length, completedSessionCount: 1, attemptCount: attempts.length, correctAttempts: correctCount, incorrectAttempts: incorrectCount, resultCount: 1 };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "inspect" && command !== "seed" && command !== "verify") stop("usage_inspect_seed_or_verify");
  guardEmulatorEnvironment();
  const bundleProof = await verifyProducerBundle();
  const app = getApps().find((candidate) => candidate.options.projectId === PROJECT_ID) ?? initializeApp({ projectId: PROJECT_ID });
  if (app.options.projectId !== PROJECT_ID) stop("firebase_project_mismatch");
  const auth = getAuth(app);
  const db = getFirestore(app);
  const authUser = await auth.getUserByEmail(DEMO_EMAIL);
  if (authUser.email !== DEMO_EMAIL) stop("synthetic_auth_email_mismatch");
  // Resolve the canonical mapping only after Auth has returned the exact synthetic UID.
  const identityRef = db.collection(COLLECTIONS.identityMappings).doc(identityDocumentId("firebase", authUser.uid));
  const identity = await identityRef.get();
  if (!identity.exists) stop("synthetic_identity_mapping_missing");
  const identityData = identity.data() as Record<string, unknown>;
  if (identityData.provider !== "firebase" || identityData.subject !== authUser.uid || identityData.email !== DEMO_EMAIL || typeof identityData.userId !== "string") stop("synthetic_identity_mapping_invalid");
  const accountId = identityData.userId;
  const userRef = db.collection(COLLECTIONS.users).doc(accountId);
  const metadataRef = userRef.collection("syncMetadata").doc("account");
  const [userSnapshot, metadataSnapshot] = await Promise.all([userRef.get(), metadataRef.get()]);
  if (!userSnapshot.exists) stop("synthetic_account_missing");
  const user = userSnapshot.data() as Record<string, unknown>;
  const authGeneration = user.authorizationGeneration === undefined ? 1 : user.authorizationGeneration;
  if (!Number.isSafeInteger(authGeneration) || Number(authGeneration) <= 0 || user.authorizationState !== "active" || user.deletedAt !== undefined) stop("synthetic_account_not_active");
  const metadata = metadataSnapshot.data() as Record<string, unknown> | undefined;
  const activeGeneration = metadata?.generation === undefined ? 0 : metadata.generation;
  const accountRevision = metadata?.accountRevision === undefined ? 0 : metadata.accountRevision;
  if (!Number.isSafeInteger(activeGeneration) || !Number.isSafeInteger(accountRevision)) stop("account_progress_metadata_invalid");
  const generationZero = await userRef.collection("progress").get();
  const generationDocs = await userRef.collection("progressGenerations").get();
  const generationProgress = await Promise.all(generationDocs.docs.map((document) => document.ref.collection("records").get()));
  const progressRecordCount = generationZero.size + generationProgress.reduce((sum, snapshot) => sum + snapshot.size, 0);
  const contentDoc = await db.collection(COLLECTIONS.contentVersions).doc(contentVersionDocumentId(TRACK_ID, bundleProof.contentVersion)).get();
  if (contentDoc.exists) {
    const catalog = contentDoc.data() as Record<string, unknown>;
    if (catalog.trackId !== TRACK_ID || catalog.version !== bundleProof.contentVersion || catalog.checksumSha256 !== bundleProof.sha256) stop("firestore_content_catalog_mismatch");
  }
  const result = { mode: command, projectId: PROJECT_ID, emulatorHosts: { auth: AUTH_HOST, firestore: FIRESTORE_HOST }, syntheticAccountFound: true, activeGeneration, accountRevision, progressRecordCount, retiredProgressGenerationCount: generationDocs.size, appArtifact: { contentVersion: bundleProof.contentVersion, sha256: bundleProof.sha256, questionCount: bundleProof.questionCount }, firestoreContentCatalogRowPresent: contentDoc.exists };
  const prepared = command === "inspect" || command === "seed"
    ? mutationsFor(JSON.parse(bundleProof.bytes.toString("utf8")).questions as AppQuestion[], bundleProof.contentVersion, bundleProof.sha256)
    : null;
  if (command === "inspect") { console.log(JSON.stringify({ ...result, plannedMutationCount: prepared!.mutations.length, plannedAttemptCount: REQUESTED_LENGTH, plannedOutcomeCounts: { correct: 7, incorrect: 3 } })); await db.terminate(); await deleteApp(app); return; }
  if (command === "verify") {
    const snapshot = await new FirestoreProgressStore(db).readSnapshot(accountId);
    const readback = assertSyntheticSnapshot(snapshot, JSON.parse(bundleProof.bytes.toString("utf8")).questions as AppQuestion[], bundleProof.contentVersion, bundleProof.sha256);
    console.log(JSON.stringify({ ...result, readback }));
    await db.terminate(); await deleteApp(app); return;
  }
  if (activeGeneration !== 0 || accountRevision !== 0 || progressRecordCount !== 0 || generationDocs.size !== 0) stop("synthetic_account_has_existing_progress");
  const { mutations, sessionId } = prepared!;
  const batch = await new FirestoreProgressStore(db).applyBatch(accountId, Number(authGeneration), "3d67c6d2-3df2-4c25-9d3f-40ea29705a10", 0, mutations, { sessionId, batchId: `${sessionId}:batch:0`, highWatermark: 1 });
  if (batch.accountRevisionConflict || batch.conflicts.length > 0 || batch.applied.length !== mutations.length) stop("progress_batch_not_fully_applied");
  const snapshot = await new FirestoreProgressStore(db).readSnapshot(accountId);
  const readback = assertSyntheticSnapshot(snapshot, JSON.parse(bundleProof.bytes.toString("utf8")).questions as AppQuestion[], bundleProof.contentVersion, bundleProof.sha256);
  if (readback.accountRevision !== mutations.length || readback.attemptCount !== REQUESTED_LENGTH || !snapshot.records.some((record) => record.recordType === "training_session_summary" && record.targetId === sessionId)) stop("progress_readback_mismatch");
  console.log(JSON.stringify({ ...result, seeded: true, readback }));
  await db.terminate(); await deleteApp(app);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "local_demo_profile_failed");
  process.exitCode = 1;
});
