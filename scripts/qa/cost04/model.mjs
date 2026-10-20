import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { calculate } from "../cost02/cost02-model.mjs";
const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
export const instancePrices = Object.freeze(read("instance-prices.json"));

export function updatedInput(base, observations, reuseFraction) {
  if (!Number.isFinite(reuseFraction) || reuseFraction < 0 || reuseFraction > 1) throw new Error("cost04_invalid_reuse");
  if (observations.schema !== "cost04-cost03-observations-v1") throw new Error("cost04_invalid_observations");
  const input = structuredClone(base);
  for (const history of [1000, 10000]) {
    const unchanged = observations.flows.find((row) => row.id === `account_history_${history}_unchanged`);
    const changed = observations.flows.find((row) => row.id === `account_history_${history}_changed_sync`);
    if (!unchanged || !changed || unchanged.requests !== 1 || unchanged.firestoreReadsBillableEstimate !== 8 || changed.requests !== 2 || changed.firestoreReadsBillableEstimate !== 17 || changed.firestoreWrites !== 4) throw new Error("cost04_observation_contract_mismatch");
    const flow = input.flowObservations.find((row) => row.id === `history_${history}_completion`);
    const metrics = flow.metrics;
    // Reuse applies ONLY to the post-completion read. Each modeled session
    // retains its full initial sweep. Missing/incomplete proof gets the full read.
    for (const field of ["requests", "firestoreReadsObserved", "firestoreReadsBillableEstimate", "responseBytes", "requestBytes", "missingPointReads", "queryCount", "emptyQueryCount"]) {
      metrics[field] = (1 - reuseFraction) * metrics[field] + reuseFraction * unchanged[field];
    }
    flow.evidenceRef = `cost04/cost03-observations.json#${unchanged.id}; matrixSha256=${observations.matrixSha256}`;
    flow.transformation = `Completion-only proof reuse fraction ${reuseFraction}; other clients/cache loss/oversize fall back to full sweep. Frequency is assumed.`;
    const records = history === 1000 ? 12 : 22;
    const sync = input.flowObservations.find((row) => row.id === `account_completion_sync_${records}records`);
    // Preserve accepted reads=7+2N, writes=2N+2. Replace historical ACK estimate
    // with measured N=1 ACK bytes scaled N times: conservative envelope estimate,
    // not a measured N=12/22 response and not a guaranteed byte upper bound.
    sync.metrics.responseBytes = (changed.responseBytes - unchanged.responseBytes) * records;
    sync.evidenceRef = `cost04/cost03-observations.json#${changed.id}; matrixSha256=${observations.matrixSha256}`;
  }
  input.assumptions.cost04 = { reuseFraction, sessionCacheReuse: 0, completionAckBytes: "measured N=1 ACK bytes times N; estimated envelope", serviceTime: "100ms/request inherited assumption, held fixed across resource choices; no speedup claimed" };
  return input;
}

export function instanceLifetimeCost({ lifetimeSeconds, starts, cpu, memory, extraBoostVcpuSeconds = 0 }) {
  for (const value of [lifetimeSeconds, starts, cpu, memory, extraBoostVcpuSeconds]) if (!Number.isFinite(value) || value < 0) throw new Error("cost04_invalid_lifetime");
  const billedSeconds = Math.max(lifetimeSeconds, starts * 60);
  return { lifetimeSecondsAssumption: lifetimeSeconds, startsAssumption: starts, billedSeconds,
    totalUsd: (billedSeconds * cpu + extraBoostVcpuSeconds) * instancePrices.cpuPerSecond + billedSeconds * memory * instancePrices.memoryPerGiBSecond };
}

export function report() {
  const base = read("../cost02/cost02-calibrated-input.json");
  const prices = read("../cost02/cost02-prices.json");
  const observations = read("cost03-observations.json");
  const baseline = calculate(base, prices).scenarios;
  const cases = [];
  const configurations = [
    { id: "candidate", cpu: 1, memory: .5, concurrency: 8, boost: true },
    { id: "concurrency1", cpu: 1, memory: .5, concurrency: 1, boost: true },
    { id: "historicalConcurrency80", cpu: 1, memory: .5, concurrency: 80, boost: true },
    { id: "ram1GiB", cpu: 1, memory: 1, concurrency: 8, boost: true },
    { id: "cpu2ram1GiB", cpu: 2, memory: 1, concurrency: 8, boost: true },
    { id: "boostOff", cpu: 1, memory: .5, concurrency: 8, boost: false },
  ];
  for (const reuseFraction of [0, .5, 1]) for (const configuration of configurations) {
    if (reuseFraction !== 1 && configuration.id !== "candidate") continue;
    const input = updatedInput(base, observations, reuseFraction);
    for (const p of input.profiles) Object.assign(p, { cpuVcpu: configuration.cpu, memoryGiB: configuration.memory, concurrency: configuration.concurrency,
      cpuBoostMultiplier: configuration.boost ? 2 : 1 });
    const result = calculate(input, prices);
    for (const [i, row] of result.scenarios.entries()) {
      const p = input.profiles[i];
      const modes = {};
      for (const min of [0, 1]) {
        const run = row.cloudRun[`min${min}`];
        const starts = (min === 0 ? p.min0ColdStartsPerDay : p.min1ColdStartsPerDay) * input.durationDays;
        // Explicit lifetime scenario, NOT inferred provider lifetime. The whole
        // active window is provisioned at modeled mean instance count + a 15min
        // idle tail per start, capped by a full month of those instances.
        const totalSeconds = input.durationDays * 86400 * Math.max(1, run.estimatedActiveInstances);
        const lifetime = min === 1 ? totalSeconds : Math.min(totalSeconds, Math.max(1, run.estimatedActiveInstances) * p.activeWindowHoursPerDay * 3600 * input.durationDays + starts * 900);
        const instance = instanceLifetimeCost({ lifetimeSeconds: lifetime, starts, cpu: p.cpuVcpu, memory: p.memoryGiB, extraBoostVcpuSeconds: run.cpuBoostAssumption.extraVcpuSeconds });
        modes[`min${min}`] = { requestRunUsd: run.costUsd.total, totalModeledUsd: row.totalCostUsd[`min${min}`],
          marginalUsdPer1000Sessions: row.marginalCostPer1000SessionsUsd[`min${min}`], idleReadyUsd: run.costUsd.cpuIdle + run.costUsd.memoryIdle,
          instanceLifetimeScenario: { ...instance, totalWithOtherServicesUsd: row.totalCostUsd[`min${min}`] - run.costUsd.total + instance.totalUsd },
          rpsMeanAssumption: run.requestsPerSecond, offeredConcurrency: run.offeredMeanConcurrency,
          meanInstancesArithmetic: run.estimatedActiveInstances,
          serviceMax2SlotUtilization: run.offeredMeanConcurrency / (2 * configuration.concurrency),
          serviceMax2MeanOverload: run.offeredMeanConcurrency > 2 * configuration.concurrency,
          capacityBoundary: "Mean slot arithmetic only. CPU/memory, bursts, request shape, DB/RC latency and autoscaling are NOT_MEASURED; max2 and concurrency do not establish capacity or a cost cap." };
      }
      cases.push({ profile: row.scenario, reuseFraction, configuration, acceptedCost02Usd: baseline[i].totalCostUsd, modes,
        requestTimeSensitivity: row.sensitivity.cloudRunServiceTimeMultipliers,
        activeWindowSensitivity: row.sensitivity.activeWindowHoursPerDay });
    }
  }
  return { schema: "cost04-model-v1", durationDays: 30, inputSha256: Object.fromEntries(["../cost02/cost02-calibrated-input.json", "../cost02/cost02-prices.json", "cost03-observations.json", "instance-prices.json"].map((name) => [name, createHash("sha256").update(readFileSync(new URL(name, import.meta.url))).digest("hex")])),
    instancePrices, readinessWithoutRequestsUsd: { automaticRequestMin0: 0, automaticRequestMin1: 13.608, instanceOneContinuouslyAlive: 59.0976, manualCount0: "disabled; retained services/storage and delayed charges remain" },
    boundary: "USD gross scenario estimate, no FX/VAT/discounts/shared free tiers. Existing COST02 limitations apply. First full history sweep retained at every session; only completion reuse varied. N=12/22 write counters formula, ACK bytes estimated. Instance mode uses explicit whole-lifetime scenario including idle, 60s minimum, no request charge; no prediction of actual residency. No cloud measurement or authorization.",
    cases };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(JSON.stringify(report(), null, 2) + "\n");
