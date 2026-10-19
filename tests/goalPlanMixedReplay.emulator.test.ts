import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ProgressMutation } from "../src/modules/progress/contracts.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { createEmulatorContext, createVerifiedRegisteredAuthUser, TEST_APP_CHECK_TOKEN } from "./support.js";

const context = createEmulatorContext();
const db = context.db;
const subjects: string[] = [];
const track = "aws-certified-solutions-architect-associate";
const deviceId = "00000000-0000-4000-8000-000000000000";
const origin = await context.app.listen({ host: "127.0.0.1", port: 0 });
const metadata = () => ({ sessionId: "mixed-replay", batchId: randomUUID(), highWatermark: 1 });
async function persisted(id: string) {
  return Promise.all(["progress", "syncMetadata", "syncMutations", "syncBatches"].map(async collection =>
    (await db.collection("users").doc(id).collection(collection).orderBy("__name__").get()).docs.map(doc => [doc.id, doc.data()])));
}
test.after(async () => {
  for (const id of subjects) await db.recursiveDelete(db.collection("users").doc(id));
  await context.close();
});

function goalState(track: string, targetDate: string, revision = 1) {
  return { schemaVersion: 1, revision, record: { goalType: "prepare_for_a_certification", preferredDays: ["mon"], status: "active", targetDate, trackId: track, weeklySessionTarget: 1 } };
}

function planState(track: string, targetDate: string, goalRevision = 1, planRevision = 1) {
  return { schemaVersion: 1, revision: planRevision, plan: { schemaVersion: 2, planId: `plan-${track}`, trackId: track, goalRevision, status: "accepted", timezone: "Europe/Warsaw", contentVersion: "content-v1", artifactSha256: "a".repeat(64), acceptedTarget: { meaning: "event", targetDate }, createdAt: "2026-09-09T08:00:00.000Z", updatedAt: "2026-09-09T08:00:00.000Z", planRevision, commandId: `command-${planRevision}`, slots: [{ slotId: `slot-${planRevision}`, day: "mon", localTime: "18:00", sessionLength: 25 }], minutesPerStudyDay: 25, executionPolicy: { policyVersion: "patternly-learning-execution-v1", initialDiagnosis: null, practice: { modeId: "coding-interview-guided-practice", requestedLength: 10 } }, planningPolicyIdentity: { contentVersion: "content-v1", artifactSha256: "a".repeat(64), policyVersion: "policy-v1" } } };
}

function goalPlanMutation(recordType: "goal" | "learning_plan", track: string, state: Readonly<Record<string, unknown>>, expectedVersion: number | null = null) {
  const base = { recordId: track, recordType, trackId: track, state };
  return { mutationId: `mutation-${randomUUID()}`, kind: "node" as const, recordType, trackId: track, targetId: track, expectedVersion, state, fingerprint: createMergeRecordFingerprint(base) };
}

function goalPlanPair(track: string, targetDate: string, goalRevision = 1, planRevision = 1) {
  const goal = goalPlanMutation("goal", track, goalState(track, targetDate, goalRevision), goalRevision === 1 ? null : goalRevision - 1);
  const plan = goalPlanMutation("learning_plan", track, planState(track, targetDate, goalRevision, planRevision), planRevision === 1 ? null : planRevision - 1);
  return [goal, plan] as const;
}


for (const transport of ["storage", "HTTP"] as const) {
  for (const scenario of ["deleted goal", "newer live goal", "historical plan", "valid mixed", "duplicates only"] as const) {
    test(`${transport}: mixed replay validates persisted pair: ${scenario}`, async () => {
      const auth = await createVerifiedRegisteredAuthUser(context);
      subjects.push(auth.userId);
      const send = async (mutations: readonly ProgressMutation[], revision: number, batch = metadata()) => {
        if (transport === "storage") {
          try { return { status: 200, body: await context.stores.progress.applyBatch(auth.userId, 1, deviceId, revision, mutations, batch) }; }
          catch (error) {
            if (!(error instanceof Error) || error.message !== "goal_plan_bundle_invalid") throw error;
            return { status: 400, body: { error: { code: error.message } } };
          }
        }
        const response = await fetch(`${origin}/v1/progress/sync`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${auth.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN },
          body: JSON.stringify({ canonicalVersion: "canonical-json-v1", deviceId, expectedAccountRevision: revision, mutations, ...batch }),
        });
        return { status: response.status, body: await response.json() };
      };
      const a = goalPlanPair(track, "2027-09-09");
      const batchA = metadata();
      const resultA = await send(a, 0, batchA);
      assert.equal(resultA.status, 200);
      assert.equal(resultA.body.accountRevision, 2);
      const b = scenario === "deleted goal"
        ? [goalPlanMutation("goal", track, { deleted: true }, 1), goalPlanMutation("learning_plan", track, { deleted: true }, 1)]
        : goalPlanPair(track, "2027-10-10", 2, 2);
      const batchB = metadata();
      const resultB = await send(b, 2, batchB);
      assert.equal(resultB.status, 200);
      assert.equal(resultB.body.accountRevision, 4);
      const c = scenario === "historical plan"
        ? [a[1], goalPlanMutation("goal", track, goalState(track, "2027-09-09", 3), 2)]
        : scenario === "duplicates only" ? [...a]
        : [a[0], goalPlanMutation("learning_plan", track,
          planState(track, scenario === "valid mixed" ? "2027-10-10" : "2027-09-09", scenario === "valid mixed" ? 2 : 1, 3), 2)];
      const before = await persisted(auth.userId);
      const batchC = metadata();
      const resultC = await send(c, 4, batchC);
      if (scenario === "valid mixed" || scenario === "duplicates only") {
        assert.equal(resultC.status, 200);
        assert.equal(resultC.body.accountRevision, scenario === "valid mixed" ? 5 : 4);
        assert.equal(resultC.body.applied.length, scenario === "valid mixed" ? 1 : 0);
        assert.deepEqual(resultC.body.duplicates, scenario === "valid mixed" ? [a[0].mutationId] : a.map(m => m.mutationId));
        const after = await persisted(auth.userId);
        assert.deepEqual(after[2]?.filter(row => a.some(m => m.mutationId === row[0])), before[2]?.filter(row => a.some(m => m.mutationId === row[0])), "historical receipts and TTL are unchanged");
        if (scenario === "duplicates only") assert.deepEqual(after.slice(0, 3), before.slice(0, 3));
        const snapshot = await context.stores.progress.readSnapshot(auth.userId);
        assert.deepEqual(snapshot.records.find(r => r.recordType === "goal")?.state, b[0]!.state);
        assert.deepEqual(snapshot.records.find(r => r.recordType === "learning_plan")?.state, scenario === "valid mixed" ? c[1]!.state : b[1]!.state);
        assert.deepEqual(await send(c, 4, batchC), resultC);
      } else {
        assert.deepEqual(resultC, { status: 400, body: { error: { code: "goal_plan_bundle_invalid" } } });
        assert.deepEqual(await persisted(auth.userId), before, "rejected C changes no records, revision, receipts or batch (no success ACK)");
      }
      const beforeReplay = await persisted(auth.userId);
      assert.deepEqual(await send(a, 0, batchA), resultA, "whole-batch replay returns its original result after newer writes");
      assert.deepEqual(await send(b, 2, batchB), resultB);
      assert.deepEqual(await persisted(auth.userId), beforeReplay);
    });
  }
}
