import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { report, updatedInput, instanceLifetimeCost, instancePrices } from "./model.mjs";
const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
test("COST04 preserves first sweeps and writes; completion-only reuse keeps guarded revalidation", () => {
  const base = read("../cost02/cost02-calibrated-input.json");
  const observations = read("cost03-observations.json");
  const next = updatedInput(base, observations, 1);
  for (const history of [1000, 10000]) {
    const lookup = (input, suffix) => input.flowObservations.find((f) => f.id === `history_${history}_${suffix}`);
    assert.deepEqual(lookup(next, "session"), lookup(base, "session"));
    assert.equal(lookup(next, "completion").metrics.requests, 1);
    assert.equal(lookup(next, "completion").metrics.firestoreReadsBillableEstimate, 8);
    const records = history === 1000 ? 12 : 22;
    const sync = next.flowObservations.find((f) => f.id === `account_completion_sync_${records}records`);
    assert.equal(sync.metrics.firestoreReadsBillableEstimate, 7 + 2 * records);
    assert.equal(sync.metrics.firestoreWrites, 2 * records + 2);
  }
  assert.throws(() => updatedInput(base, observations, NaN), /invalid_reuse/);
  const bad = structuredClone(observations); bad.flows[0].requests = 2;
  assert.throws(() => updatedInput(base, bad, 1), /contract_mismatch/);
});
test("whole-lifetime mode includes idle/60s minimum and has no request charge", () => {
  assert.ok(Math.abs(instanceLifetimeCost({ lifetimeSeconds: 30 * 86400, starts: 1, cpu: 1, memory: .5 }).totalUsd - 59.0976) < 1e-10);
  assert.equal(instanceLifetimeCost({ lifetimeSeconds: 1, starts: 2, cpu: 1, memory: .5 }).billedSeconds, 120);
  assert.equal(instanceLifetimeCost({ lifetimeSeconds: 0, starts: 0, cpu: 1, memory: .5 }).totalUsd, 0);
  assert.throws(() => instanceLifetimeCost({ lifetimeSeconds: -1, starts: 0, cpu: 1, memory: .5 }), /invalid_lifetime/);
});
test("instance rates bind the extracted Warsaw record, rather than the static Iowa default", () => {
  const record = instancePrices.regionalRecordStrings;
  assert.equal(record.at(-1), "Warsaw (europe-central2)");
  assert.equal(instancePrices.cpuPerSecond, Number(record[record.indexOf("<p>CPU (per vCPU-second)</p>") + 1].slice(1)));
  assert.equal(instancePrices.memoryPerGiBSecond, Number(record[record.indexOf("<p>Memory (per GiB-second)</p>") + 1].slice(1)));
  assert.equal(instancePrices.cpuPerSecond, .0000216);
  assert.equal(instancePrices.memoryPerGiBSecond, .0000024);
});
test("six workloads have resource/reuse alternatives and retain unknown capacity boundary", () => {
  const result = report(); assert.equal(result.cases.length, 48);
  assert.equal(new Set(result.cases.map((r) => r.profile)).size, 6);
  for (const row of result.cases) {
    assert.match(row.profile, /^dau-/);
    for (const mode of Object.values(row.modes)) {
      assert.ok(Number.isFinite(mode.totalModeledUsd));
      assert.ok(Number.isFinite(mode.marginalUsdPer1000Sessions));
      assert.match(mode.capacityBoundary, /NOT_MEASURED/);
    }
  }
  for (const profile of new Set(result.cases.map((r) => r.profile))) {
    const rows = result.cases.filter((r) => r.profile === profile && r.configuration.id === "candidate");
    assert.ok(rows[0].modes.min0.totalModeledUsd > rows[2].modes.min0.totalModeledUsd);
  }
  const peak = result.cases.find((r) => r.profile === "dau-10000-peak" && r.configuration.id === "candidate" && r.reuseFraction === 1);
  assert.equal(peak.modes.min0.serviceMax2MeanOverload, true, "max2 is a probe bound, not sufficient for the highest workload");
});
