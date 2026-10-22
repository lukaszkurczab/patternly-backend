import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { progressDocumentId } from "../src/infrastructure/firestore/paths.js";
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

test("billing postcheck detects a due payload introduced after the scan without false complete", async () => {
  const db = firestore();
  const ref = db.collection("revenueCatTransactions").doc("late-billing-payload");
  const result = await new RetentionPurgeService(db, { afterPrimaryScan: async () => { await ref.set({ ownerAccountId: "fixture", status: "closed_unresolved", payloadUntil: Timestamp.fromMillis(0) }); } }).run({ execute: true, now: new Date() });
  assert.equal(result.complete, false);
  assert.equal(result.remainingDue, true);
  const retry = await new RetentionPurgeService(db).run({ execute: true, now: new Date() });
  assert.equal(retry.complete, true);
  assert.equal((await ref.get()).get("compacted"), true);
});

const adoptionCreated = Timestamp.fromMillis(past.toMillis() - 24 * 60 * 60 * 1000);
async function seedAbandonedGeneration(id: string, count = 2, generation = 1, active = 0) {
  const db = firestore();
  const user = db.collection("users").doc(id);
  const parent = user.collection("progressGenerations").doc(String(generation));
  await user.collection("syncMetadata").doc("account").set({ ...(active ? { generation: active, activeGeneration: active } : {}), adoptionGenerationCounter: Math.max(generation, active) });
  await parent.set({ userId: id, generation, sourceSessionId: `session-${id}`, state: "building", createdAt: adoptionCreated, expiresAt: past });
  const records = [];
  for (let index = 0; index < count; index += 1) {
    const row = { kind: "item" as const, recordType: "training_attempt" as const, trackId: "coding", targetId: `attempt-${index}`, generation, sourceSessionId: `session-${id}` };
    const record = parent.collection("records").doc(progressDocumentId(row));
    await record.set(row);
    records.push(record);
  }
  return { parent, records, metadata: user.collection("syncMetadata").doc("account") };
}

test("abandoned adoption dry-run is immutable and budget one converges without renewing its original fence", async () => {
  const { parent, records, metadata } = await seedAbandonedGeneration("budget-one");
  const before = (await parent.get()).data();
  const dry = await new RetentionPurgeService(firestore()).run({ now: runAt, pageSize: 1 });
  assert.equal(dry.adoptions.eligible, 1); assert.equal(dry.complete, false);
  assert.deepEqual((await parent.get()).data(), before);
  const metadataBefore = (await metadata.get()).data();
  const results = [];
  for (let index = 0; index < 4; index += 1) {
    const result = await new RetentionPurgeService(firestore()).run({ execute: true, now: runAt, maxDeletes: 1, pageSize: 1000 });
    results.push(result);
    if (index < 3) {
      const data = (await parent.get()).data()!;
      assert.equal(data.state, "purging"); assert.equal(data.expiresAt.toMillis(), past.toMillis()); assert.equal(data.createdAt.toMillis(), adoptionCreated.toMillis());
      assert.equal(result.complete, false); assert.equal(result.remainingDue, true);
    }
  }
  assert.deepEqual(results.map(result => [result.adoptions.claimed, result.adoptions.recordsDeleted, result.adoptions.confirmed]), [[1, 0, 0], [0, 1, 0], [0, 1, 0], [0, 0, 1]]);
  assert.equal(results[3]!.complete, true); assert.equal((await parent.get()).exists, false);
  for (const record of records) assert.equal((await record.get()).exists, false);
  assert.deepEqual((await metadata.get()).data(), metadataBefore);
});

test("adoption cleanup caps transaction child pages at 200 and reaches expired suffix behind active and fresh parents", async () => {
  const db = firestore();
  const active = await seedAbandonedGeneration("a-active", 1); await active.parent.update({ state: "active" });
  const fresh = await seedAbandonedGeneration("b-fresh", 1); await fresh.parent.update({ createdAt: Timestamp.fromMillis(future.toMillis() - 86400000), expiresAt: future });
  const due = await seedAbandonedGeneration("z-expired", 205, 2, 1);
  const pageSizes: number[] = [];
  const measured = new Proxy(db, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property !== "runTransaction") return typeof value === "function" ? value.bind(target) : value;
    return async (callback: Parameters<Firestore["runTransaction"]>[0]) => target.runTransaction(async transaction => {
      let deletes = 0;
      const observed = new Proxy(transaction, { get(tx, key) {
        const method = Reflect.get(tx, key, tx);
        if (key === "delete") return (...args: Parameters<typeof tx.delete>) => { if (args[0].path.includes("/records/")) deletes += 1; return method.apply(tx, args); };
        return typeof method === "function" ? method.bind(tx) : method;
      } });
      const result = await callback(observed); if (deletes) pageSizes.push(deletes); return result;
    });
  } }) as Firestore;
  const result = await new RetentionPurgeService(measured).run({ execute: true, now: runAt, pageSize: 1000, maxDeletes: 1000 });
  assert.equal(result.complete, true); assert.equal(result.adoptions.examined, 3); assert.equal(result.adoptions.recordsDeleted, 205); assert.equal(result.adoptions.confirmed, 1);
  assert.deepEqual(pageSizes, [200, 5]); assert.equal((await due.parent.get()).exists, false);
  assert.equal((await active.records[0]!.get()).exists, true); assert.equal((await fresh.records[0]!.get()).exists, true);
});

test("adoption cleanup preserves unproven parents and children, live leases and unrelated promotion metadata", async () => {
  const db = firestore();
  const malformed = [];
  for (const [id, update] of [
    ["wrong-user", { userId: "foreign" }], ["wrong-generation", { generation: "1" }], ["wrong-expiry", { expiresAt: "invalid" }],
    ["renewed-expiry", { expiresAt: Timestamp.fromMillis(past.toMillis() + 1) }], ["missing-session", { sourceSessionId: "" }],
  ] as const) { const seeded = await seedAbandonedGeneration(id, 1); await seeded.parent.update(update); malformed.push(seeded); }
  const missing = await seedAbandonedGeneration("missing-metadata", 1); await missing.metadata.delete(); malformed.push(missing);
  const pointer = await seedAbandonedGeneration("pointer-mismatch", 1); await pointer.metadata.update({ generation: 0, activeGeneration: 2 }); malformed.push(pointer);
  const counter = await seedAbandonedGeneration("invalid-counter", 1); await counter.metadata.update({ adoptionGenerationCounter: 0 }); malformed.push(counter);
  const unknown = db.collection("foreign").doc("owner").collection("progressGenerations").doc("1"); await unknown.set({ state: "building", expiresAt: past });
  const foreign = await seedAbandonedGeneration("foreign-child", 1); await foreign.records[0]!.update({ sourceSessionId: "other" });
  const unexpected = await seedAbandonedGeneration("unknown-subcollection", 1); await unexpected.parent.collection("unexpected").doc("child").set({ value: true });
  const live = await seedAbandonedGeneration("live-lease", 1);
  await live.metadata.update({ adoptionPromotionSessionId: "session-live-lease", adoptionPromotionTargetGeneration: 1, adoptionPromotionSourceGeneration: 0, adoptionPromotionSourceRevision: 0, adoptionPromotionLeaseExpiresAt: future });
  const current = await seedAbandonedGeneration("current-pointer", 1, 1, 1);
  const unrelated = await seedAbandonedGeneration("unrelated-lease", 1);
  await unrelated.metadata.update({ adoptionGenerationCounter: 2, adoptionPromotionSessionId: "another-session", adoptionPromotionTargetGeneration: 2, adoptionPromotionSourceGeneration: 0, adoptionPromotionSourceRevision: 0, adoptionPromotionLeaseExpiresAt: future });
  const metadataBefore = (await unrelated.metadata.get()).data();
  const result = await new RetentionPurgeService(db).run({ execute: true, now: runAt });
  assert.ok(result.unresolved >= 11); assert.equal(result.complete, false); assert.equal(result.remainingDue, true);
  for (const item of [...malformed, foreign, unexpected, live, current]) {
    assert.equal((await item.parent.get()).exists, true);
    assert.equal((await item.records[0]!.get()).exists, true);
  }
  assert.equal((await unknown.get()).exists, true); assert.equal((await unrelated.parent.get()).exists, false);
  assert.deepEqual((await unrelated.metadata.get()).data(), metadataBefore);
});

test("adoption cleanup rereads pointer on each destructive page and parent-last transaction", async () => {
  const db = firestore();
  for (const changeBefore of [2, 3]) {
    const seeded = await seedAbandonedGeneration(`pointer-race-${changeBefore}`, 1);
    let transactions = 0;
    const raced = new Proxy(db, { get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "runTransaction") return typeof value === "function" ? value.bind(target) : value;
      return async (callback: Parameters<Firestore["runTransaction"]>[0]) => {
        transactions += 1;
        if (transactions === changeBefore) await seeded.metadata.update({ generation: 1, activeGeneration: 1 });
        return target.runTransaction(callback);
      };
    } }) as Firestore;
    const result = await new RetentionPurgeService(raced).run({ execute: true, now: runAt });
    assert.equal(result.adoptions.confirmed, 0); assert.equal((await seeded.parent.get()).exists, true);
    assert.equal((await seeded.records[0]!.get()).exists, changeBefore === 2);
  }
});

test("competing adoption cleaners settle exactly once and retain malformed child fence for retry", async () => {
  const seeded = await seedAbandonedGeneration("concurrent-cleaners", 3);
  const results = await Promise.all([1, 2].map(() => new RetentionPurgeService(firestore()).run({ execute: true, now: runAt, pageSize: 1 })));
  assert.equal(results.reduce((sum, result) => sum + result.adoptions.claimed, 0), 1);
  assert.equal(results.reduce((sum, result) => sum + result.adoptions.recordsDeleted, 0), 3);
  assert.equal(results.reduce((sum, result) => sum + result.adoptions.confirmed, 0), 1);
  assert.equal((await seeded.parent.get()).exists, false);
});

test("adoption cleanup final observation reports late due or unproven parents without false complete", async () => {
  const result = await new RetentionPurgeService(firestore(), { afterPrimaryScan: async () => { await seedAbandonedGeneration("late-generation", 1); } }).run({ execute: true, now: runAt });
  assert.equal(result.remainingDue, true); assert.equal(result.complete, false);
  const retry = await new RetentionPurgeService(firestore()).run({ execute: true, now: runAt }); assert.equal(retry.complete, true);
  const unknown = await new RetentionPurgeService(firestore(), { afterPrimaryScan: async () => {
    await firestore().collection("other").doc("owner").collection("progressGenerations").doc("1").set({ state: "building" });
  } }).run({ execute: true, now: runAt });
  assert.ok(unknown.unresolved > 0); assert.equal(unknown.complete, false);
});

test("adoption cleanup preserves nested unknown data and a changed source fence", async () => {
  const db = firestore();
  const nested = await seedAbandonedGeneration("nested-child", 1);
  await nested.records[0]!.collection("unknown").doc("keep").set({ value: true });
  const result = await new RetentionPurgeService(db).run({ execute: true, now: runAt });
  assert.ok(result.unresolved > 0); assert.equal((await nested.parent.get()).exists, true); assert.equal((await nested.records[0]!.get()).exists, true);
  const changed = await seedAbandonedGeneration("changed-source", 1);
  let transactions = 0;
  const racedDb = new Proxy(db, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property !== "runTransaction") return typeof value === "function" ? value.bind(target) : value;
    return async (callback: Parameters<Firestore["runTransaction"]>[0]) => {
      transactions += 1;
      if (transactions === 2) await changed.parent.update({ sourceSessionId: "replaced-source" });
      return target.runTransaction(callback);
    };
  } }) as Firestore;
  const changedResult = await new RetentionPurgeService(racedDb).run({ execute: true, now: runAt });
  assert.ok(changedResult.unresolved > 0); assert.equal((await changed.parent.get()).exists, true); assert.equal((await changed.records[0]!.get()).exists, true);
});

test("adoption cleanup transaction failure preserves durable claim and retry can finish", async () => {
  const db = firestore(); const seeded = await seedAbandonedGeneration("interrupted-page", 2);
  let transactions = 0;
  const interrupted = new Proxy(db, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property !== "runTransaction") return typeof value === "function" ? value.bind(target) : value;
    return async (callback: Parameters<Firestore["runTransaction"]>[0]) => {
      transactions += 1;
      if (transactions === 3) throw new Error("controlled_failure_after_first_child_page");
      return target.runTransaction(callback);
    };
  } }) as Firestore;
  await assert.rejects(new RetentionPurgeService(interrupted).run({ execute: true, now: runAt, pageSize: 1 }), /controlled_failure_after_first_child_page/u);
  assert.equal((await seeded.parent.get()).get("state"), "purging"); assert.equal((await seeded.parent.collection("records").get()).size, 1);
  const resumed = await new RetentionPurgeService(db).run({ execute: true, now: runAt });
  assert.equal(resumed.adoptions.claimed, 0); assert.equal(resumed.adoptions.recordsDeleted, 1); assert.equal(resumed.adoptions.confirmed, 1); assert.equal(resumed.complete, true);
});

test("adoption cleanup preserves missing-record descendants instead of deleting their parent fence", async () => {
  const seeded = await seedAbandonedGeneration("missing-record-descendant", 1);
  const descendant = seeded.records[0]!.collection("unknown").doc("keep");
  await descendant.set({ value: true }); await seeded.records[0]!.delete();
  assert.equal((await seeded.parent.collection("records").get()).empty, true);
  assert.ok((await seeded.parent.listCollections()).some(collection => collection.id === "records"), "real SDK lists a collection containing missing-record descendants");
  const result = await new RetentionPurgeService(firestore()).run({ execute: true, now: runAt });
  assert.ok(result.unresolved > 0); assert.equal(result.complete, false); assert.equal(result.adoptions.confirmed, 0);
  assert.equal((await seeded.parent.get()).get("state"), "purging"); assert.equal((await descendant.get()).exists, true);
});

test("paged adoption discovery repeatedly reaches due work after fresh and active prefixes", async () => {
  const active = await seedAbandonedGeneration("a-active-prefix", 1); await active.parent.update({ state: "active" });
  const fresh = await seedAbandonedGeneration("b-fresh-prefix", 1); await fresh.parent.update({ createdAt: Timestamp.fromMillis(future.toMillis() - 86400000), expiresAt: future });
  const due = await seedAbandonedGeneration("z-due-suffix", 1);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const result = await new RetentionPurgeService(firestore()).run({ execute: true, now: runAt, pageSize: 1, maxDeletes: 1 });
    assert.equal(result.adoptions.examined, 3); assert.equal(result.complete, iteration === 2);
  }
  assert.equal((await due.parent.get()).exists, false);
  assert.equal((await active.records[0]!.get()).exists, true); assert.equal((await fresh.records[0]!.get()).exists, true);
});
