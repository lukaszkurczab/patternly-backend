#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOUR = 3600;
const DAY = 86400;
const GIB = 1024 ** 3;
const METRICS = [
  'requests', 'firestoreReadsObserved', 'firestoreReadsBillableEstimate', 'firestoreWrites',
  'firestoreDeletes', 'responseBytes', 'requestBytes', 'gcsDownloads', 'gcsDownloadBytes',
  'gcsClassAOperations', 'gcsClassBOperations'
];

function number(value, label, { min = 0, max = Infinity, nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a finite number in [${min}, ${max}]${nullable ? ' or null' : ''}`);
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}
function costTiers(units, tiers) {
  let previous = 0, remaining = units, total = 0;
  for (const tier of tiers) {
    if (remaining <= 0) break;
    const boundary = tier.through ?? tier.throughGiB ?? null;
    const cap = boundary === null ? remaining : Math.max(0, boundary - previous);
    const billed = Math.min(remaining, cap);
    total += billed * (tier.price ?? tier.pricePerMau ?? tier.pricePerGiB ?? 0);
    remaining -= billed;
    previous = boundary ?? previous;
  }
  if (remaining > 1e-8) throw new Error('Pricing tiers do not cover modeled usage');
  return total;
}
function normalizeFlow(f) {
  // Worker observations are totals across sampleCount trigger occurrences. The
  // explicit perEventOccurrence form is useful for hand examples and fixtures.
  const divisor = f.basis === 'perEventOccurrence' ? 1 : f.sampleCount;
  const source = f.metrics ?? f;
  const metrics = {};
  for (const key of METRICS) {
    const value = source[key] ?? 0;
    metrics[key] = value === null ? null : value / divisor;
  }
  metrics.httpServiceTimeMsSum = (source.httpServiceTimeMsSum ?? 0) / divisor;
  metrics.httpServiceTimeMsMax = source.httpServiceTimeMsMax ?? null;
  metrics.queryCount = (source.queryCount ?? 0) / divisor;
  metrics.emptyQueryCount = (source.emptyQueryCount ?? 0) / divisor;
  metrics.missingPointReads = (source.missingPointReads ?? 0) / divisor;
  metrics.indexEntryReads = source.indexEntryReads ?? 'NOT_MEASURED';
  // Preserve the worker's conversion explicitly; this is not inferred from SDK snapshots.
  metrics.firestoreReadsBillableEstimate = source.firestoreReadsBillableEstimate == null
    ? null : source.firestoreReadsBillableEstimate / divisor;
  return { ...f, metrics };
}
function validate(input) {
  object(input, 'input');
  if (input.schema !== 'cost02-model-input-v1') throw new Error('input.schema must be cost02-model-input-v1');
  if (!Array.isArray(input.flowObservations) || !input.flowObservations.length) throw new Error('flowObservations must contain measured observations');
  if (!Array.isArray(input.profiles) || !input.profiles.length) throw new Error('profiles must contain explicit scenarios');
  number(input.durationDays, 'durationDays', { min: 1, max: 31 });
  const ids = new Set();
  for (const [i, f] of input.flowObservations.entries()) {
    object(f, `flowObservations[${i}]`);
    for (const key of ['id', 'event', 'audience', 'evidenceRef']) if (typeof f[key] !== 'string' || !f[key]) throw new Error(`flowObservations[${i}].${key} is required`);
    if (!['account', 'guest', 'both'].includes(f.audience)) throw new Error(`${f.id}.audience must be account, guest, or both`);
    if (ids.has(f.id)) throw new Error(`duplicate flow id ${f.id}`);
    ids.add(f.id);
    if (f.basis === 'perEventOccurrence') {
      object(f.metrics ?? f, `${f.id}.metrics`);
    } else {
      number(f.sampleCount, `${f.id}.sampleCount`, { min: 1 });
    }
    const source = f.metrics ?? f;
    for (const key of METRICS) number(source[key] ?? 0, `${f.id}.${key}`, { nullable: key === 'firestoreReadsBillableEstimate' });
    number(source.httpServiceTimeMsSum ?? 0, `${f.id}.httpServiceTimeMsSum`);
    number(source.httpServiceTimeMsMax ?? null, `${f.id}.httpServiceTimeMsMax`, { nullable: true });
    if ((source.requests ?? 0) > 0 && (f.cloudRunServiceTimeMsAssumption ?? 0) <= 0) throw new Error(`${f.id} needs explicit positive cloudRunServiceTimeMsAssumption; local app.inject timing is diagnostic only`);
  }
  const profileKeys = ['dau', 'accountShare', 'sessionsPerDauDay', 'sessionDurationMinutes', 'foregroundReturnsPerSession', 'answersPerSession', 'completionsPerDauDay', 'premiumRefreshesPerSession', 'reconnectsPerDauDay', 'historyPagesPerSession', 'monthlyActiveAccounts', 'retryAttemptsPerRequest', 'packageDownloadsPerAccountMonth', 'packageBytes', 'retainedPackageGiB', 'historyAccountsStored', 'historyRecordsPerAccountAtStart', 'historyRecordBytes', 'historyRecordsAddedPerAccountMonth', 'historyRetentionDays', 'pitrGiB', 'activeWindowHoursPerDay', 'min0ColdStartsPerDay', 'min1ColdStartsPerDay', 'startupMs', 'shutdownMs', 'extraCpuBoostMsPerStart', 'cpuBoostMultiplier'];
  const knownFlowIds = ids;
  for (const [i, p] of input.profiles.entries()) {
    object(p, `profiles[${i}]`);
    for (const k of ['name', 'kind']) if (typeof p[k] !== 'string' || !p[k]) throw new Error(`profiles[${i}].${k} is required`);
    if (!['moderate', 'peak'].includes(p.kind)) throw new Error(`${p.name}.kind must be moderate or peak`);
    if (!Array.isArray(p.flowIds) || p.flowIds.length === 0) throw new Error(`${p.name}.flowIds must explicitly select measured flow observation IDs`);
    const selectedIds = new Set();
    for (const id of p.flowIds) {
      if (typeof id !== 'string' || !knownFlowIds.has(id)) throw new Error(`${p.name}.flowIds references unknown observation '${id}'`);
      if (selectedIds.has(id)) throw new Error(`${p.name}.flowIds contains duplicate observation '${id}'`);
      selectedIds.add(id);
    }
    for (const k of profileKeys) number(p[k], `${p.name}.${k}`, { min: k === 'cpuBoostMultiplier' ? 1 : 0 });
    number(p.concurrency, `${p.name}.concurrency`, { min: 1 });
    number(p.cpuVcpu, `${p.name}.cpuVcpu`, { min: 0.08 });
    number(p.memoryGiB, `${p.name}.memoryGiB`, { min: 0.5 });
    if (p.accountShare > 1) throw new Error(`${p.name}.accountShare must be <= 1`);
    if (p.activeWindowHoursPerDay > 24) throw new Error(`${p.name}.activeWindowHoursPerDay must be <= 24`);
    if (p.historyRetentionDays < 30) throw new Error(`${p.name}.historyRetentionDays must be >= 30 for the authorized 30-day model horizon; shorter expiry is not assumed`);
    if (!['directGcs', 'none'].includes(p.packageDelivery)) throw new Error(`${p.name}.packageDelivery must be directGcs or none for the current signed-URL flow`);
    if (p.packageDownloadsPerAccountMonth > 0 && p.packageDelivery === 'none') throw new Error(`${p.name} has package downloads but packageDelivery is none`);
  }
  object(input.sharedUsage, 'sharedUsage');
  if (typeof input.sharedUsage.applyFirestoreDailyFreeQuota !== 'boolean') throw new Error('sharedUsage.applyFirestoreDailyFreeQuota must be boolean');
  for (const k of ['firestoreReadsIncludedDaily', 'firestoreWritesIncludedDaily', 'firestoreDeletesIncludedDaily', 'artifactRegistryStoredGiB', 'secretManagerActiveVersions', 'secretManagerAccesses']) number(input.sharedUsage[k] ?? 0, `sharedUsage.${k}`);
}
function dailyTriggers(p) {
  return {
    session: p.sessionsPerDauDay,
    foreground: p.sessionsPerDauDay * p.foregroundReturnsPerSession,
    answer: p.sessionsPerDauDay * p.answersPerSession,
    completion: p.completionsPerDauDay,
    premiumRefresh: p.sessionsPerDauDay * p.premiumRefreshesPerSession,
    packageDownload: p.packageDownloadsPerAccountMonth / 30,
    reconnect: p.reconnectsPerDauDay,
    historyPage: p.sessionsPerDauDay * p.historyPagesPerSession
  };
}
function flowTotals(profile, rawFlows, days) {
  const flows = rawFlows.filter(f => profile.flowIds.includes(f.id)).map(normalizeFlow);
  const triggers = dailyTriggers(profile);
  const cohorts = { account: profile.dau * profile.accountShare, guest: profile.dau * (1 - profile.accountShare) };
  const t = Object.fromEntries(METRICS.map(k => [k, k === 'firestoreReadsBillableEstimate' ? 0 : 0]));
  Object.assign(t, { firestoreReadsUnknown: false, localHttpServiceTimeMsSum: 0, localHttpServiceTimeMsMax: 0, cloudRunServiceTimeMsSum: 0, cloudRunRoundingSlackSeconds: 0, queryCount: 0, emptyQueryCount: 0, missingPointReads: 0, flows: [], includedFlowIds: [] });
  for (const f of flows) {
    const perDay = triggers[f.event];
    if (perDay === undefined) throw new Error(`Unsupported event '${f.event}' (${f.id})`);
    const audience = f.event === 'packageDownload'
      ? (f.audience === 'both' || f.audience === 'account' ? profile.monthlyActiveAccounts : 0)
      : (f.audience === 'both' ? profile.dau : cohorts[f.audience]);
    const occurrences = audience * perDay * days;
    const retry = 1 + profile.retryAttemptsPerRequest;
    const m = f.metrics;
    const flowRequests = occurrences * m.requests * retry;
    for (const key of METRICS) {
      if (key === 'firestoreReadsBillableEstimate' && m[key] === null) {
        if (occurrences > 0 && (m.firestoreReadsObserved || m.emptyQueryCount || m.missingPointReads)) t.firestoreReadsUnknown = true;
      } else if (key !== 'httpServiceTimeMsSum') t[key] += occurrences * (m[key] ?? 0) * retry;
    }
    const localDurationMs = m.requests > 0 ? m.httpServiceTimeMsSum / m.requests : 0;
    const cloudRunDurationMs = f.cloudRunServiceTimeMsAssumption ?? 0;
    t.localHttpServiceTimeMsSum += flowRequests * localDurationMs;
    t.localHttpServiceTimeMsMax = Math.max(t.localHttpServiceTimeMsMax, m.httpServiceTimeMsMax ?? localDurationMs);
    t.cloudRunServiceTimeMsSum += flowRequests * cloudRunDurationMs;
    const roundedAssumedMs = Math.ceil(cloudRunDurationMs / 100) * 100;
    t.cloudRunRoundingSlackSeconds += flowRequests * Math.max(0, roundedAssumedMs - cloudRunDurationMs) / 1000;
    t.queryCount += occurrences * m.queryCount * retry;
    t.emptyQueryCount += occurrences * m.emptyQueryCount * retry;
    t.missingPointReads += occurrences * m.missingPointReads * retry;
    t.flows.push({ id: f.id, event: f.event, audience: f.audience, occurrences, requests: flowRequests, cloudRunServiceTimeMsAssumption: cloudRunDurationMs, localHttpServiceTimeMsDiagnostic: localDurationMs, evidenceRef: f.evidenceRef, indexEntryReads: m.indexEntryReads });
    if (occurrences > 0) t.includedFlowIds.push(f.id);
  }
  return { ...t, dailyTriggers: triggers, cohorts };
}
function cloudRun(p, totals, rates, days, minInstances) {
  const activeSecondsPerDay = p.activeWindowHoursPerDay * HOUR;
  const meanServiceSeconds = totals.requests ? totals.cloudRunServiceTimeMsSum / totals.requests / 1000 : 0;
  const requestsPerSecond = activeSecondsPerDay ? totals.requests / days / activeSecondsPerDay : 0;
  const offeredConcurrency = requestsPerSecond * meanServiceSeconds;
  const activeInstances = totals.requests ? Math.max(1, Math.ceil(offeredConcurrency / p.concurrency)) : 0;
  const perInstanceLoad = activeInstances ? offeredConcurrency / activeInstances : 0;
  const occupancy = 1 - Math.exp(-perInstanceLoad);
  const modeledActiveInstanceSeconds = activeInstances * activeSecondsPerDay * days * occupancy;
  const startsPerDay = minInstances === 0 ? p.min0ColdStartsPerDay : p.min1ColdStartsPerDay;
  const startupSec = startsPerDay * days * p.startupMs / 1000;
  const shutdownSec = startsPerDay * days * p.shutdownMs / 1000;
  const baseActiveSec = modeledActiveInstanceSeconds + startupSec + shutdownSec;
  const boostExtraVcpuSeconds = startsPerDay * days * p.extraCpuBoostMsPerStart / 1000 * p.cpuVcpu * (p.cpuBoostMultiplier - 1);
  const billedActiveLowerSec = Math.ceil(baseActiveSec / rates.billingIncrementSeconds) * rates.billingIncrementSeconds;
  const startupShutdownRoundingSlackSec = startsPerDay * days * rates.billingIncrementSeconds * 2;
  const billedActiveUpperSec = Math.ceil((baseActiveSec + totals.cloudRunRoundingSlackSeconds + startupShutdownRoundingSlackSec) / rates.billingIncrementSeconds) * rates.billingIncrementSeconds;
  // Price the upper end of the explicit per-request rounding range. It adds
  // each request's <=100ms rounding slack without pretending intervals do not overlap.
  const billedActiveSec = billedActiveUpperSec;
  // min=1 idle time is computed for the designated minimum instance only;
  // autoscaled instances' active seconds never erase that idle-hour floor.
  const minInstanceActive = Math.min(days * DAY, activeSecondsPerDay * days * occupancy + startupSec + shutdownSec);
  const minIdleSec = minInstances ? Math.max(0, days * DAY - minInstanceActive) : 0;
  const billedIdleSec = minIdleSec ? Math.ceil(minIdleSec / rates.billingIncrementSeconds) * rates.billingIncrementSeconds : 0;
  const cpuActive = billedActiveSec * p.cpuVcpu * rates.cpuActivePerVcpuSecond + boostExtraVcpuSeconds * rates.cpuActivePerVcpuSecond;
  const memActive = billedActiveSec * p.memoryGiB * rates.memoryActivePerGiBSecond;
  const cpuIdle = billedIdleSec * p.cpuVcpu * rates.cpuIdleMinInstancePerVcpuSecond;
  const memIdle = billedIdleSec * p.memoryGiB * rates.memoryIdleMinInstancePerGiBSecond;
  const requestCost = totals.requests / 1e6 * rates.requestsPerMillion;
  return {
    billing: 'request-based', minInstances, manualCount0: 'disabled; excluded from available-service comparison', concurrency: p.concurrency,
    requestServiceTimeMeanMsAssumption: meanServiceSeconds * 1000,
    activeWindowHoursPerDay: p.activeWindowHoursPerDay, requestsPerSecond: requestsPerSecond,
    offeredMeanConcurrency: offeredConcurrency, estimatedActiveInstances: activeInstances, occupancyApproximation: 'Poisson independent arrivals; 1-exp(-mean offered concurrency per instance)', occupancyFraction: occupancy,
    activeRequestWindowInstanceSeconds: modeledActiveInstanceSeconds, minInstanceActiveBilledSeconds: minInstanceActive,
    minInstanceIdleBilledSeconds: billedIdleSec, activeBilledSeconds: billedActiveSec,
    activeBillingRoundingRangeSeconds: { lower: billedActiveLowerSec, upperPriced: billedActiveUpperSec, perRequestRoundingSlackSeconds: totals.cloudRunRoundingSlackSeconds, startupShutdownRoundingSlackSeconds: startupShutdownRoundingSlackSec, incrementSeconds: rates.billingIncrementSeconds, note: 'Priced upper bound adds at most one 100ms rounding interval per request and one each for startup/shutdown per assumed start. This does not model provider interval unions or overlapping requests; Poisson active-window occupancy remains an approximation, not exact invoice billing.' },
    startupShutdownAssumptions: { startsPerDay: startsPerDay, startupMsEach: p.startupMs, shutdownMsEach: p.shutdownMs, startupShutdownBilledSeconds: startupSec + shutdownSec },
    cpuBoostAssumption: { extraDurationMsPerStart: p.extraCpuBoostMsPerStart, multiplier: p.cpuBoostMultiplier, extraVcpuSeconds: boostExtraVcpuSeconds, costedAtActiveCpuRate: true },
    cpuVcpuSeconds: billedActiveSec * p.cpuVcpu + boostExtraVcpuSeconds, memoryGiBSeconds: billedActiveSec * p.memoryGiB, requests: totals.requests,
    costUsd: { cpuActive, memoryActive: memActive, cpuIdle, memoryIdle: memIdle, requests: requestCost, total: cpuActive + memActive + cpuIdle + memIdle + requestCost }
  };
}
function firestore(p, t, rates, shared, days) {
  const reads = t.firestoreReadsUnknown ? null : t.firestoreReadsBillableEstimate;
  const includedRead = shared.applyFirestoreDailyFreeQuota ? shared.firestoreReadsIncludedDaily * days : 0;
  const includedWrite = shared.applyFirestoreDailyFreeQuota ? shared.firestoreWritesIncludedDaily * days : 0;
  const includedDelete = shared.applyFirestoreDailyFreeQuota ? shared.firestoreDeletesIncludedDaily * days : 0;
  const readCost = reads == null ? null : Math.max(0, reads - includedRead) / 100000 * rates.readsPer100000;
  const writeCost = Math.max(0, t.firestoreWrites - includedWrite) / 100000 * rates.writesPer100000;
  const deleteCost = Math.max(0, t.firestoreDeletes - includedDelete) / 100000 * rates.deletesPer100000;
  const matureGiB = p.historyAccountsStored * p.historyRecordsPerAccountAtStart * p.historyRecordBytes / GIB;
  const newRecords = p.dau * p.accountShare * p.historyRecordsAddedPerAccountMonth;
  const retentionInMonthDays = Math.min(days, p.historyRetentionDays);
  const retainedFractionOfMonth = days > 0 ? (retentionInMonthDays - retentionInMonthDays ** 2 / (2 * days)) / days : 0;
  const acquiredAverageGiB = newRecords * retainedFractionOfMonth * p.historyRecordBytes / GIB;
  const matureStorageCost = matureGiB * days * 24 * rates.storagePerGiBHour;
  const acquiredStorageCost = acquiredAverageGiB * days * 24 * rates.storagePerGiBHour;
  const storageCost = matureStorageCost + acquiredStorageCost;
  return { observedSdkDocumentSnapshots: t.firestoreReadsObserved, estimatedBillableDocumentReads: reads, estimatedCandidateMissingPointReads: t.missingPointReads, emptyQueries: t.emptyQueryCount, queryCount: t.queryCount, indexEntryReads: 'NOT_MEASURED', readsUnknown: t.firestoreReadsUnknown, writes: t.firestoreWrites, deletes: t.firestoreDeletes,
    storage: { matureStartingGiB: matureGiB, acquiredCohortAverageGiB: acquiredAverageGiB, retentionDaysAssumption: p.historyRetentionDays, matureStorageCost, acquiredStorageCost, storageCost },
    costUsd: { reads: readCost, writes: writeCost, deletes: deleteCost, storage: storageCost, total: readCost == null ? null : readCost + writeCost + deleteCost + storageCost } };
}
function calculateScenario(p, input, pricing, deriveMarginal = true) {
  const days = input.durationDays;
  const t = flowTotals(p, input.flowObservations, days);
  const run0 = cloudRun(p, t, pricing.rates.cloudRun, days, 0);
  const run1 = cloudRun(p, t, pricing.rates.cloudRun, days, 1);
  const fs = firestore(p, t, pricing.rates.firestore, input.sharedUsage, days);
  // Input contract: app HTTP responseBytes excludes direct GCS package delivery;
  // package bytes are carried separately in gcsDownloadBytes.
  const cloudRunAppResponseBytes = t.responseBytes;
  const cloudRunResponseGiB = cloudRunAppResponseBytes / GIB;
  const packageGiB = t.gcsDownloadBytes / GIB || p.dau * p.accountShare * p.packageDownloadsPerAccountMonth * p.packageBytes / GIB;
  const runEgressCost = costTiers(cloudRunResponseGiB, pricing.rates.cloudRun.internetEgressEurope);
  const packageEgressGiB = p.packageDelivery === 'directGcs' ? packageGiB : 0;
  const packageEgressCost = costTiers(packageEgressGiB, pricing.rates.cloudStorage.internetEgressEurope);
  const gcsStorageGiB = p.retainedPackageGiB;
  const gcsStorageCost = gcsStorageGiB * days * 24 * pricing.rates.cloudStorage.standardStoragePerGiBHour;
  const gcsA = t.gcsClassAOperations;
  const gcsB = t.gcsClassBOperations || t.gcsDownloads;
  const gcsOpsCost = gcsA / 1000 * pricing.rates.cloudStorage.classAOperationsPer1000 + gcsB / 1000 * pricing.rates.cloudStorage.classBOperationsPer1000;
  const authCost = costTiers(p.monthlyActiveAccounts, pricing.rates.identityPlatform.tier1Mau);
  const registryGiB = input.sharedUsage.artifactRegistryStoredGiB;
  const registryCost = registryGiB * days * 24 * pricing.rates.artifactRegistry.storagePerGiBHour;
  const secretCost = input.sharedUsage.secretManagerActiveVersions * days * 24 * pricing.rates.secretManager.activeVersionPerHour + input.sharedUsage.secretManagerAccesses / 10000 * pricing.rates.secretManager.accessPer10000;
  const runBase0 = run0.costUsd.total;
  const runBase1 = run1.costUsd.total;
  const fsCost = fs.costUsd.total;
  const pitrStorageCost = p.pitrGiB * days * 24 * pricing.rates.firestore.pitrStoragePerGiBHour;
  const pitrMatureGiB = Math.min(p.pitrGiB, fs.storage.matureStartingGiB);
  const pitrAcquiredGiB = Math.max(0, p.pitrGiB - pitrMatureGiB);
  const pitrMatureCost = pitrMatureGiB * days * 24 * pricing.rates.firestore.pitrStoragePerGiBHour;
  const pitrAcquiredCost = pitrAcquiredGiB * days * 24 * pricing.rates.firestore.pitrStoragePerGiBHour;
  const sharedFixed = authCost + registryCost + secretCost + pitrMatureCost;
  const matureFirestoreStorage = fs.storage.matureStorageCost;
  const variableOther = runEgressCost + packageEgressCost + gcsOpsCost + pitrAcquiredCost + (fsCost == null ? 0 : fsCost - matureFirestoreStorage);
  const runMarginal0 = run0.costUsd.cpuActive + run0.costUsd.memoryActive + run0.costUsd.requests;
  const runMarginal1 = run1.costUsd.cpuActive + run1.costUsd.memoryActive + run1.costUsd.requests;
  const serviceTimeSensitivity = [0.5, 5, 10].map(multiplier => {
    const adjusted = {
      ...t,
      cloudRunServiceTimeMsSum: t.cloudRunServiceTimeMsSum * multiplier,
      cloudRunRoundingSlackSeconds: t.flows.reduce((sum, f) => {
        const serviceMs = f.cloudRunServiceTimeMsAssumption * multiplier;
        return sum + f.requests * Math.max(0, Math.ceil(serviceMs / 100) * 100 - serviceMs) / 1000;
      }, 0)
    };
    const m0 = cloudRun(p, adjusted, pricing.rates.cloudRun, days, 0);
    const m1 = cloudRun(p, adjusted, pricing.rates.cloudRun, days, 1);
    return { multiplier, serviceTimeMs: t.flows.length ? Math.max(...t.flows.map(f => f.cloudRunServiceTimeMsAssumption)) * multiplier : 0, min0: { estimatedActiveInstances: m0.estimatedActiveInstances, activeBilledSeconds: m0.activeBilledSeconds, costUsd: m0.costUsd.total }, min1: { estimatedActiveInstances: m1.estimatedActiveInstances, minInstanceIdleBilledSeconds: m1.minInstanceIdleBilledSeconds, costUsd: m1.costUsd.total } };
  });
  const activeWindowSensitivity = [0.5, 1, 2].map(multiplier => {
    const adjusted = { ...p, activeWindowHoursPerDay: p.activeWindowHoursPerDay * multiplier };
    const m0 = cloudRun(adjusted, t, pricing.rates.cloudRun, days, 0);
    const m1 = cloudRun(adjusted, t, pricing.rates.cloudRun, days, 1);
    return { activeWindowHoursPerDay: adjusted.activeWindowHoursPerDay, min0: { estimatedActiveInstances: m0.estimatedActiveInstances, activeBilledSeconds: m0.activeBilledSeconds, costUsd: m0.costUsd.total }, min1: { estimatedActiveInstances: m1.estimatedActiveInstances, minInstanceIdleBilledSeconds: m1.minInstanceIdleBilledSeconds, costUsd: m1.costUsd.total } };
  });
  const total0 = fsCost == null ? null : runBase0 + variableOther + sharedFixed + gcsStorageCost;
  const total1 = fsCost == null ? null : runBase1 + variableOther + sharedFixed + gcsStorageCost;
  const sessions = p.dau * p.sessionsPerDauDay * days;
  const per1000 = value => sessions > 0 && value != null ? value * 1000 / sessions : null;
  const result = {
    scenario: p.name, kind: p.kind, durationDays: days, dau: p.dau, accountShare: p.accountShare,
    sessionsPerDauDay: p.sessionsPerDauDay, sessionDurationMinutes: p.sessionDurationMinutes,
    averageConcurrentUsers24h: p.dau * p.sessionsPerDauDay * p.sessionDurationMinutes / 1440,
    concurrentUsersInActiveWindow: p.activeWindowHoursPerDay > 0 ? p.dau * p.sessionsPerDauDay * p.sessionDurationMinutes / (p.activeWindowHoursPerDay * 60) : 0,
    foregroundReturnsPerSession: p.foregroundReturnsPerSession, answersPerSession: p.answersPerSession, packageDownloadsPerAccountMonth: p.packageDownloadsPerAccountMonth,
    completionsPerDauDay: p.completionsPerDauDay, premiumRefreshesPerSession: p.premiumRefreshesPerSession,
    monthlyActiveAccountsAssumption: p.monthlyActiveAccounts, historyAccountsStoredAssumption: p.historyAccountsStored, historyRetentionDaysAssumption: p.historyRetentionDays, pitrGiBAssumption: p.pitrGiB, retryAttemptsPerRequestAssumption: p.retryAttemptsPerRequest,
    monthlySessions: sessions, dailyTriggerRates: t.dailyTriggers, packageQuotaBasis: 'monthlyActiveAccounts × packageDownloadsPerAccountMonth; package delivery observations are account-only',
    flowCoverage: { selectedFlowIds: p.flowIds, includedFlowIds: t.includedFlowIds, excludedFlowIds: input.flowObservations.filter(f => !p.flowIds.includes(f.id)).map(f => f.id), missingBillableReadEstimate: t.firestoreReadsUnknown, measurementsArePerEventOccurrenceAfterSampleNormalization: true },
    flowRequests: t.flows,
    volumes: { requests: t.requests, firestoreReadsObserved: t.firestoreReadsObserved, firestoreReadsBillableEstimate: t.firestoreReadsUnknown ? null : t.firestoreReadsBillableEstimate, firestoreWrites: t.firestoreWrites, firestoreDeletes: t.firestoreDeletes, responseBytes: t.responseBytes, requestBytesInboundExcludedFromEgress: t.requestBytes, gcsDownloads: t.gcsDownloads, gcsDownloadBytes: t.gcsDownloadBytes, localHttpServiceTimeMsSumDiagnostic: t.localHttpServiceTimeMsSum, localHttpServiceTimeMsMaxDiagnostic: t.localHttpServiceTimeMsMax },
    cloudRun: { min0: run0, min1: run1 }, sensitivity: { cloudRunServiceTimeMultipliers: serviceTimeSensitivity, activeWindowHoursPerDay: activeWindowSensitivity, note: 'Sensitivity recalculates mean request occupancy, active-instance approximation, and designated min=1 idle. Active-window width is the reuse/burst assumption; no provider traces are inferred.' }, firestore: fs,
    network: { packageDelivery: p.packageDelivery, cloudRunAppResponseGiB: cloudRunResponseGiB, packageObjectGiB: packageGiB, directGcsPackageEgressGiB: packageEgressGiB, responseBytesContainsAppDescriptorOrJsonOnly: true, inboundRequestBytesExcluded: true, pricingMethod: 'current signed-URL flow: app descriptor/JSON egress and direct GCS payload egress are separate SKUs; GCS GET operation remains separate', costUsd: { cloudRunEgress: runEgressCost, packageEgress: packageEgressCost } },
    cloudStorage: { retainedPackageGiB: gcsStorageGiB, classAOperations: gcsA, classBOperations: gcsB, costUsd: { storage: gcsStorageCost, operations: gcsOpsCost, egress: packageEgressCost, total: gcsStorageCost + gcsOpsCost + packageEgressCost } },
    identityPlatform: { monthlyActiveUsers: p.monthlyActiveAccounts, costUsd: authCost },
    artifactRegistry: { storedGiB: registryGiB, costUsd: registryCost }, secretManager: { activeVersions: input.sharedUsage.secretManagerActiveVersions, accesses: input.sharedUsage.secretManagerAccesses, costUsd: secretCost },
    pitr: { retainedGiBAssumption: p.pitrGiB, quantityBasis: 'explicit profile input; configured state is not refreshed by this model', matureStartingGiB: pitrMatureGiB, acquiredCohortAverageGiB: pitrAcquiredGiB, costUsd: pitrStorageCost, costUsdBreakdown: { matureFixed: pitrMatureCost, acquiredCohort: pitrAcquiredCost } },
    storageRetentionSensitivity: [30, 90, 365].map(retentionDays => {
      const extraHistoricalMonths = Math.max(0, retentionDays - 30) / 30;
      const monthlyNewRecords = p.dau * p.accountShare * p.historyRecordsAddedPerAccountMonth;
      const matureGiB = p.historyAccountsStored * p.historyRecordsPerAccountAtStart * p.historyRecordBytes / GIB;
      const acquiredAverageRecords = monthlyNewRecords * (extraHistoricalMonths + Math.min(days, 30) / 30 / 2);
      const databaseGiB = matureGiB + acquiredAverageRecords * p.historyRecordBytes / GIB;
      const averageRecordsPerAccount = p.historyAccountsStored > 0 ? databaseGiB * GIB / (p.historyAccountsStored * p.historyRecordBytes) : 0;
      return { retentionDays, hypotheticalOnly: retentionDays !== p.historyRetentionDays, expiryWithinModeled30Days: false, extraHistoricalMonths, averageRecordsPerAccount, databaseGiB, firestoreStorageCostUsd: databaseGiB * days * 24 * pricing.rates.firestore.storagePerGiBHour, pitrCostUsd: databaseGiB * days * 24 * pricing.rates.firestore.pitrStoragePerGiBHour, note: 'Cost sensitivity only; no deletion/TTL/policy change is performed or recommended.' };
    }),
    fixedAndMarginal: { fixedAssumptionsUsd: { min1Idle: run1.costUsd.cpuIdle + run1.costUsd.memoryIdle, matureFirestoreStorage, retainedPackageStorage: gcsStorageCost, identityPlatform: authCost, artifactRegistry: registryCost, secretManager: secretCost, maturePitrStorage: pitrMatureCost }, usageComponentAtScenarioUsd: { min0: variableOther + runMarginal0, min1: variableOther + runMarginal1 }, note: 'Usage component is an attribution at the scenario point; only marginalCostPer1000SessionsUsd below is a finite difference. Fixed daily startup/shutdown assumptions are held constant in that finite difference.' },
    totalCostUsd: { min0: total0, min1: total1 }, monthlyCostPer1000SessionsUsd: { min0: per1000(total0), min1: per1000(total1) }, averageVariableCostPer1000SessionsUsd: { min0: per1000(variableOther + runMarginal0), min1: per1000(variableOther + runMarginal1) },
    scope: fsCost == null ? 'PARTIAL: billable Firestore read estimate missing; totals unavailable' : 'MODELED: explicit scenario inputs and official list prices; not invoice or provider measurement'
  };
  if (deriveMarginal && sessions > 0 && total0 != null && total1 != null) {
    const ratio = (sessions + 1000) / sessions;
    const increased = {
      ...p,
      sessionsPerDauDay: p.sessionsPerDauDay * ratio,
      completionsPerDauDay: p.completionsPerDauDay * ratio,
      historyRecordsAddedPerAccountMonth: p.historyRecordsAddedPerAccountMonth * ratio,
      pitrGiB: pitrMatureGiB + pitrAcquiredGiB * ratio
    };
    const plus = calculateScenario(increased, input, pricing, false);
    result.marginalCostPer1000SessionsUsd = {
      addedSessions: 1000,
      method: 'finite difference: totalCost(profile plus 1,000 monthly sessions) - totalCost(profile); DAU, account mix, MAU, mature history, package quota, registry, secrets and daily starts held fixed; session-derived traffic/completions/history growth scale with sessions; reconnects/day stays fixed.',
      min0: plus.totalCostUsd.min0 - total0,
      min1: plus.totalCostUsd.min1 - total1,
      comparisonScenario: `${p.name}+1000 monthly sessions`
    };
  } else {
    result.marginalCostPer1000SessionsUsd = { addedSessions: 1000, min0: null, min1: null, method: 'unavailable: scenario has no monthly sessions or complete modeled total' };
  }
  return result;
}
export function calculate(input, pricing) {
  validate(input);
  object(pricing, 'pricing');
  if (pricing.schema !== 'cost02-price-input-v1' || pricing.currency !== 'USD') throw new Error('pricing must be cost02-price-input-v1 in USD');
  return {
    schema: 'cost02-model-output-v1', generatedAtUtc: new Date().toISOString(), durationDays: input.durationDays,
    pricing: { verifiedOn: pricing.pricingVerifiedOn, region: pricing.region, sourceUrls: pricing.sources, currency: 'USD', firestoreDailyFreeQuotaApplied: input.sharedUsage.applyFirestoreDailyFreeQuota, pricesAreListRates: true },
    assumptions: input.assumptions,
    scenarios: input.profiles.map(p => calculateScenario(p, input, pricing)),
    limitations: [
      'Traffic, audience mix, CCU shape, session/event rates, retry rate, package downloads, history maturity and retention are scenario assumptions unless their evidenceRef points to measured observations.',
      'Local HTTP service time is diagnostic only. Cloud Run service time requires a separately supplied cloudRunServiceTimeMsAssumption per measured app request flow; client-side Auth SDK RPC and local JS cold mount are not Cloud Run app request service time.',
      'Cloud Run instance occupancy is a Poisson approximation with supplied active window and concurrency; actual autoscaling, queues, startup, shutdown, min instance routing, CPU and billing need provider-side measurements.',
      'Startup/shutdown and CPU boost amounts and frequencies are explicit inputs, not measured defaults. Local emulator latency and CPU are not substituted for Cloud Run values.',
      'Firestore SDK snapshots, candidate missing point reads, empty-query counts and billed-read estimates are separate. Index entry reads are NOT_MEASURED; query shape, rules and document returns can change billable reads.',
      'Firestore daily operation quota defaults off because other same-project usage is unknown. Cloud Run, Registry and Secret Manager shared free tiers are also not applied; outputs are gross list-price estimates. No FX conversion, VAT, tax, negotiated discounts, billing export, authenticated inventory or provider measurement is included.',
      'Retention storage distinguishes matured starting history from a uniformly acquired 30-day cohort; shorter expiry is rejected, and 90/365-day cases are storage-only sensitivities. Firestore PITR is priced from an explicit assumed GiB quantity, not a refreshed provider configuration; backup storage, Cloud Build, logs, monitoring, SMS, support and other unprovided SKUs are excluded. HistoryRecordBytes is payload only and omits physical Firestore metadata/index overhead.'
    ]
  };
}
function main() {
  if (process.argv.length !== 3) throw new Error('usage: node cost02-model.mjs <input.json>');
  const inputPath = path.resolve(process.argv[2]);
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const pricing = JSON.parse(fs.readFileSync(path.resolve(path.dirname(inputPath), input.pricingFile ?? 'cost02-prices.json'), 'utf8'));
  process.stdout.write(`${JSON.stringify(calculate(input, pricing), null, 2)}\n`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main(); } catch (error) { process.stderr.write(`COST02_MODEL_INPUT_ERROR: ${error.message}\n`); process.exitCode = 2; }
}
