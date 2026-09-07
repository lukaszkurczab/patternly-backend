import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { RetentionPurgeService } from "../src/modules/retention-purge/service.js";
import { clearFirestore, createEmulatorContext, firestore, type EmulatorContext } from "./support.js";

const past = Timestamp.fromMillis(Date.parse("2026-01-01T00:00:00.000Z"));
const future = Timestamp.fromMillis(Date.parse("2030-01-01T00:00:00.000Z"));
const runAt = new Date("2026-06-01T00:00:00.000Z");

let context: EmulatorContext;
test.before(async () => { context = createEmulatorContext(); await clearFirestore(); });
test.beforeEach(async () => { await clearFirestore(); });
test.after(async () => { await clearFirestore(); await context.close(); });

test("expired content report is recursively deleted with its direct audit and no raw actor remains", async () => {
  const db = firestore();
  const report = db.collection("contentReports").doc("expired-report");
  const audit = report.collection("audit").doc("transition");
  await report.set({ expiresAt: past, status: "closed" });
  await audit.set({ expiresAt: past, actorId: "raw-actor-id" });
  assert.equal((await audit.get()).data()?.actorId, "raw-actor-id");

  const dryRun = await new RetentionPurgeService(db).run({ now: runAt });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.parents.eligible, 1);
  assert.equal(dryRun.complete, false);
  assert.equal((await audit.get()).data()?.actorId, "raw-actor-id");

  const result = await new RetentionPurgeService(db).run({ execute: true, now: runAt });
  assert.equal(result.complete, true);
  assert.equal(result.parents.confirmed, 1);
  assert.equal((await report.get()).exists, false);
  assert.equal((await audit.get()).exists, false);
});

test("only an expired exact orphan content-report audit is directly deleted", async () => {
  const db = firestore();
  const orphan = db.collection("contentReports").doc("missing-parent").collection("audit").doc("orphan");
  const liveParent = db.collection("contentReports").doc("live-parent");
  const liveAudit = liveParent.collection("audit").doc("still-owned");
  const privacyAudit = db.collection("privacyRequests").doc("privacy").collection("audit").doc("keep");
  const securityAudit = db.collection("securityIncidents").doc("incident").collection("audit").doc("keep");
  const unknownAudit = db.collection("users").doc("user").collection("audit").doc("unknown");
  await orphan.set({ expiresAt: past, actorId: "raw-orphan-actor" });
  await liveParent.set({ expiresAt: future });
  await liveAudit.set({ expiresAt: past });
  await privacyAudit.set({ expiresAt: past });
  await securityAudit.set({ expiresAt: past });
  await unknownAudit.set({ expiresAt: past });

  const result = await new RetentionPurgeService(db).run({ execute: true, now: runAt });
  assert.equal(result.audits.orphanEligible, 1);
  assert.equal(result.audits.confirmed, 1);
  assert.equal(result.audits.ignored, 2);
  assert.equal(result.unresolved, 1);
  assert.equal(result.complete, false);
  assert.equal((await orphan.get()).exists, false);
  assert.equal((await liveAudit.get()).exists, true);
  assert.equal((await privacyAudit.get()).exists, true);
  assert.equal((await securityAudit.get()).exists, true);
  assert.equal((await unknownAudit.get()).exists, true);
});

test("orphan audit deletion rechecks parent absence in its transaction", async () => {
  const db = firestore();
  const parent = db.collection("contentReports").doc("parent-created-during-purge");
  const audit = parent.collection("audit").doc("orphan-before-transaction");
  await audit.set({ expiresAt: past });
  const originalRunTransaction = db.runTransaction.bind(db);
  let injected = false;
  const racingDb = new Proxy(db, { get(target, property) {
    if (property === "runTransaction") return async <T>(callback: Parameters<Firestore["runTransaction"]>[0]): Promise<T> => {
      if (!injected) { injected = true; await parent.set({ expiresAt: future }); }
      return originalRunTransaction(callback) as Promise<T>;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }) as unknown as Firestore;
  const result = await new RetentionPurgeService(racingDb).run({ execute: true, now: runAt });
  assert.equal(result.audits.attempted, 0);
  assert.equal(result.audits.confirmed, 0);
  assert.equal(result.complete, false);
  assert.equal((await parent.get()).exists, true);
  assert.equal((await audit.get()).exists, true);
});

test("delete budget interrupts work and idempotent retries with the same budget reach the zero-due postcondition", async () => {
  const db = firestore();
  for (const id of ["a", "b", "c"]) await db.collection("contentReports").doc(id).set({ expiresAt: past });
  const interrupted = await new RetentionPurgeService(db).run({ execute: true, pageSize: 1, maxDeletes: 1, now: runAt });
  assert.equal(interrupted.complete, false);
  assert.equal(interrupted.remainingDue, true);
  assert.equal(interrupted.parents.confirmed, 1);
  const retry = await new RetentionPurgeService(db).run({ execute: true, pageSize: 1, maxDeletes: 1, now: runAt });
  assert.equal(retry.complete, false);
  assert.equal(retry.parents.confirmed, 1);
  const finalRetry = await new RetentionPurgeService(db).run({ execute: true, pageSize: 1, maxDeletes: 1, now: runAt });
  assert.equal(finalRetry.complete, true);
  assert.equal(finalRetry.remainingDue, false);
  assert.equal(finalRetry.unresolved, 0);
  assert.equal((await db.collection("contentReports").get()).empty, true);
});

test("fresh parent prefix cannot starve expired suffix across paged budgeted retries", async () => {
  const db = firestore();
  for (const id of ["a-fresh", "b-fresh"]) await db.collection("contentReports").doc(id).set({ expiresAt: future });
  for (const id of ["z-due-one", "z-due-two"]) await db.collection("contentReports").doc(id).set({ expiresAt: past });
  const first = await new RetentionPurgeService(db).run({ execute: true, pageSize: 2, maxDeletes: 1, now: runAt });
  assert.equal(first.parents.examined, 4);
  assert.equal(first.parents.confirmed, 1);
  assert.equal(first.remainingDue, true);
  const second = await new RetentionPurgeService(db).run({ execute: true, pageSize: 2, maxDeletes: 1, now: runAt });
  assert.equal(second.parents.examined, 3);
  assert.equal(second.parents.confirmed, 1);
  assert.equal(second.complete, true);
  assert.equal((await db.collection("contentReports").doc("a-fresh").get()).exists, true);
  assert.equal((await db.collection("contentReports").doc("b-fresh").get()).exists, true);
  assert.equal((await db.collection("contentReports").doc("z-due-one").get()).exists, false);
  assert.equal((await db.collection("contentReports").doc("z-due-two").get()).exists, false);
});

test("paged collection-group scan reaches exact orphan audits behind a fresh protected prefix", async () => {
  const db = firestore();
  await db.collection("privacyRequests").doc("privacy-a").collection("audit").doc("a-protected").set({ expiresAt: past });
  await db.collection("securityIncidents").doc("security-b").collection("audit").doc("b-protected").set({ expiresAt: past });
  const orphanOne = db.collection("contentReports").doc("missing-one").collection("audit").doc("z-orphan-one");
  const orphanTwo = db.collection("contentReports").doc("missing-two").collection("audit").doc("z-orphan-two");
  await orphanOne.set({ expiresAt: past });
  await orphanTwo.set({ expiresAt: past });
  const first = await new RetentionPurgeService(db).run({ execute: true, pageSize: 2, maxDeletes: 1, now: runAt });
  assert.equal(first.audits.confirmed, 1);
  assert.equal(first.remainingDue, true);
  const second = await new RetentionPurgeService(db).run({ execute: true, pageSize: 2, maxDeletes: 1, now: runAt });
  assert.equal(second.audits.confirmed, 1);
  assert.equal(second.complete, true);
  assert.equal((await orphanOne.get()).exists, false);
  assert.equal((await orphanTwo.get()).exists, false);
});

test("final cutoff observation detects a due report inserted after the primary scan", async () => {
  const db = firestore();
  const injected = db.collection("contentReports").doc("due-after-primary-scan");
  const result = await new RetentionPurgeService(db, { afterPrimaryScan: async () => { await injected.set({ expiresAt: past }); } }).run({ execute: true, now: runAt });
  assert.equal(result.complete, false);
  assert.equal(result.remainingDue, true);
  assert.equal((await injected.get()).exists, true);
});

test("recursive deletion failure returns no success result and a normal retry remains idempotent", async () => {
  const db = firestore();
  const report = db.collection("contentReports").doc("recursive-delete-failure");
  await report.set({ expiresAt: past });
  const failingDb = new Proxy(db, { get(target, property) {
    if (property === "recursiveDelete") return async () => { throw new Error("simulated_recursive_delete_failure"); };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }) as unknown as Firestore;
  await assert.rejects(() => new RetentionPurgeService(failingDb).run({ execute: true, now: runAt }));
  assert.equal((await report.get()).exists, true);
  const retry = await new RetentionPurgeService(db).run({ execute: true, now: runAt });
  assert.equal(retry.complete, true);
  assert.equal((await report.get()).exists, false);
});

test("unexpired and missing or invalid expiry records are preserved and unresolved", async () => {
  const db = firestore();
  const unexpired = db.collection("contentReports").doc("unexpired");
  const missing = db.collection("contentReports").doc("missing-expiry");
  const invalid = db.collection("contentReports").doc("invalid-expiry");
  const invalidAudit = db.collection("contentReports").doc("unexpired").collection("audit").doc("invalid-expiry");
  await unexpired.set({ expiresAt: future });
  await missing.set({ status: "open" });
  await invalid.set({ expiresAt: "not-a-timestamp" });
  await invalidAudit.set({ expiresAt: "not-a-timestamp" });
  const result = await new RetentionPurgeService(db).run({ execute: true, now: runAt });
  assert.equal(result.unresolved, 3);
  assert.equal(result.complete, false);
  assert.equal((await unexpired.get()).exists, true);
  assert.equal((await missing.get()).exists, true);
  assert.equal((await invalid.get()).exists, true);
  assert.equal((await invalidAudit.get()).exists, true);
});
