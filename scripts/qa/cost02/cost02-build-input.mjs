#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const GIB = 1024 ** 3;
const USED = [
  'requests', 'firestoreReadsObserved', 'firestoreReadsBillableEstimate', 'missingPointReads',
  'queryCount', 'emptyQueryCount', 'firestoreWrites', 'firestoreDeletes',
  'requestBytes', 'responseBytes', 'gcsDownloads', 'gcsDownloadBytes'
];
function fail(message) { throw new Error(message); }
function loadJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function roundMetric(value) { return Math.abs(value) < 1e-12 ? 0 : value; }

export function buildInput(matrix, matrixSha256, generatedAtUtc = new Date().toISOString()) {
  if (!Array.isArray(matrix.flowObservations)) fail('matrix must include flowObservations[]');
  if (!/^[a-f0-9]{64}$/.test(matrixSha256)) fail('matrix sha256 is required');
  const byId = new Map(matrix.flowObservations.map(row => [row.id, row]));
  const get = id => byId.get(id) ?? fail(`matrix observation missing: ${id}`);
  const perEvent = row => {
    const n = row.sampleCount ?? 1;
    if (!(Number.isFinite(n) && n >= 1)) fail(`${row.id}.sampleCount invalid`);
    const out = {};
    for (const field of USED) out[field] = row[field] == null ? null : row[field] / n;
    // The matrix responseBodyBytes includes a signed GCS fixture response for
    // package flow. The input contract keeps app JSON and GCS object bytes apart.
    out.responseBytes = roundMetric(out.responseBytes - out.gcsDownloadBytes);
    if (out.responseBytes < 0) fail(`${row.id}: GCS response exceeds total response bytes`);
    out.gcsClassAOperations = 0;
    out.gcsClassBOperations = out.gcsDownloads;
    return out;
  };
  const selected = (id, event, audience, metrics, sourceRows, { includeLocalTiming = false, serviceMs = 100 } = {}) => {
    const flows = sourceRows.map(get);
    const evidenceRef = flows.map(row => `${row.evidenceRef}#matrixSha256=${matrixSha256}`).join(' + ');
    const result = {
      id, event, audience, basis: 'perEventOccurrence', evidenceRef,
      metrics: { ...metrics, indexEntryReads: 'NOT_MEASURED' },
      transformation: 'Per-sample normalized counters; no private logs or identifiers included.'
    };
    if (result.metrics.requests > 0) result.cloudRunServiceTimeMsAssumption = serviceMs;
    if (includeLocalTiming) {
      result.metrics.httpServiceTimeMsSum = flows.reduce((sum, row) => sum + (row.httpServiceTimeMsSum ?? 0) / (row.sampleCount ?? 1), 0);
      result.metrics.httpServiceTimeMsMax = Math.max(0, ...flows.map(row => (row.httpServiceTimeMsMax ?? 0)));
    }
    return result;
  };
  const sourceFlow = (id, event, audience, sourceId, opts = {}) => selected(id, event, audience, perEvent(get(sourceId)), [sourceId], { includeLocalTiming: true, ...opts });
  const deltaFlow = (id, event, audience, minuendId, subtrahendId) => {
    const a = perEvent(get(minuendId));
    const b = perEvent(get(subtrahendId));
    const metrics = {};
    for (const field of USED) {
      if (field === 'firestoreReadsBillableEstimate' && (a[field] === null || b[field] === null)) fail(`${id}: billable reads cannot be derived from null`);
      metrics[field] = roundMetric(a[field] - b[field]);
      if (metrics[field] < 0) fail(`${id}: subtracting ${subtrahendId} makes ${field} negative`);
    }
    metrics.gcsClassAOperations = 0;
    metrics.gcsClassBOperations = metrics.gcsDownloads;
    return selected(id, event, audience, metrics, [minuendId, subtrahendId]);
  };

  const flows = [
    // Remove the separately modeled account-data refresh from cold startup.
    deltaFlow('account_session_base', 'session', 'account', 'cold_start_account', 'account_retry_account_data_sync_current'),
    deltaFlow('account_completion_sync_base', 'completion', 'account', 'account_changed_sync_retry_success', 'account_retry_account_data_sync_current'),
    sourceFlow('account_foreground', 'foreground', 'account', 'background_foreground_account'),
    sourceFlow('account_reconnect', 'reconnect', 'account', 'reconnect_account'),
    sourceFlow('account_extra_entitlement_refresh', 'premiumRefresh', 'account', 'account_entitlements_refresh'),
    sourceFlow('account_answer_local', 'answer', 'account', 'account_local_answer_commit'),
    sourceFlow('account_completion_local', 'completion', 'account', 'account_local_completion_commit'),
    sourceFlow('guest_session_local', 'session', 'guest', 'cold_start_guest'),
    sourceFlow('guest_foreground_local', 'foreground', 'guest', 'background_foreground_guest'),
    sourceFlow('guest_reconnect_local', 'reconnect', 'guest', 'reconnect_guest'),
    sourceFlow('guest_answer_local', 'answer', 'guest', 'guest_local_answer_commit'),
    sourceFlow('guest_completion_local', 'completion', 'guest', 'guest_local_completion_commit'),
    sourceFlow('account_package_download', 'packageDownload', 'account', 'account_content_package_download')
  ];
  for (const historyN of [0, 100, 1000, 10000]) {
    const sourceId = `account_history_${historyN}`;
    get(sourceId);
    flows.push(sourceFlow(`history_${historyN}_session`, 'session', 'account', sourceId));
    flows.push(sourceFlow(`history_${historyN}_completion`, 'completion', 'account', sourceId));
  }
  const completionBase = flows.find(flow => flow.id === 'account_completion_sync_base');
  for (const records of [12, 22]) {
    const scale = records / 3;
    const metrics = {
      ...completionBase.metrics,
      firestoreReadsObserved: 7 + 2 * records,
      firestoreReadsBillableEstimate: 7 + 2 * records,
      firestoreWrites: 2 * records + 2,
      responseBytes: completionBase.metrics.responseBytes * scale
    };
    flows.push({
      ...completionBase,
      id: `account_completion_sync_${records}records`,
      metrics,
      transformation: `Derived from the successful measured 3-record sync by verified store.applyBatch formula: 7+2N read units and 2N+2 committed writes for N=${records} source records; response bytes scaled by N/3 as a labeled payload-envelope approximation. The separate trailing progress sweep is modeled as history_completion.`,
      evidenceRef: `${completionBase.evidenceRef}; source shape from patternly-backend/src/modules/progress/store.ts FirestoreProgressStore.applyBatch`
    });
  }
  const profileDefs = [
    { kind: 'moderate', dau: 100, accountShare: .7, sessionsPerDauDay: 2, sessionDurationMinutes: 10, foregroundReturnsPerSession: .5, reconnectsPerDauDay: .2, answersPerSession: 10, completionsPerDauDay: 2, premiumRefreshesPerSession: .1, historyN: 1000, activeWindowHoursPerDay: 12, monthlyActiveFactor: 3, packageDownloadsPerAccountMonth: 2, retryAttemptsPerRequest: .01, min0ColdStartsPerDay: 24 },
    { kind: 'moderate', dau: 1000, accountShare: .7, sessionsPerDauDay: 2, sessionDurationMinutes: 10, foregroundReturnsPerSession: .5, reconnectsPerDauDay: .2, answersPerSession: 10, completionsPerDauDay: 2, premiumRefreshesPerSession: .1, historyN: 1000, activeWindowHoursPerDay: 12, monthlyActiveFactor: 3, packageDownloadsPerAccountMonth: 2, retryAttemptsPerRequest: .01, min0ColdStartsPerDay: 24 },
    { kind: 'moderate', dau: 10000, accountShare: .7, sessionsPerDauDay: 2, sessionDurationMinutes: 10, foregroundReturnsPerSession: .5, reconnectsPerDauDay: .2, answersPerSession: 10, completionsPerDauDay: 2, premiumRefreshesPerSession: .1, historyN: 1000, activeWindowHoursPerDay: 12, monthlyActiveFactor: 3, packageDownloadsPerAccountMonth: 2, retryAttemptsPerRequest: .01, min0ColdStartsPerDay: 24 },
    { kind: 'peak', dau: 100, accountShare: .9, sessionsPerDauDay: 4, sessionDurationMinutes: 20, foregroundReturnsPerSession: 2, reconnectsPerDauDay: 1, answersPerSession: 20, completionsPerDauDay: 4, premiumRefreshesPerSession: .5, historyN: 10000, activeWindowHoursPerDay: 4, monthlyActiveFactor: 5, packageDownloadsPerAccountMonth: 8, retryAttemptsPerRequest: .05, min0ColdStartsPerDay: 72 },
    { kind: 'peak', dau: 1000, accountShare: .9, sessionsPerDauDay: 4, sessionDurationMinutes: 20, foregroundReturnsPerSession: 2, reconnectsPerDauDay: 1, answersPerSession: 20, completionsPerDauDay: 4, premiumRefreshesPerSession: .5, historyN: 10000, activeWindowHoursPerDay: 4, monthlyActiveFactor: 5, packageDownloadsPerAccountMonth: 8, retryAttemptsPerRequest: .05, min0ColdStartsPerDay: 72 },
    { kind: 'peak', dau: 10000, accountShare: .9, sessionsPerDauDay: 4, sessionDurationMinutes: 20, foregroundReturnsPerSession: 2, reconnectsPerDauDay: 1, answersPerSession: 20, completionsPerDauDay: 4, premiumRefreshesPerSession: .5, historyN: 10000, activeWindowHoursPerDay: 4, monthlyActiveFactor: 5, packageDownloadsPerAccountMonth: 8, retryAttemptsPerRequest: .05, min0ColdStartsPerDay: 72 }
  ];
  const profiles = profileDefs.map(d => {
    const historySource = `account_history_${d.historyN}`;
    get(historySource);
    const accountPackage = flows.find(f => f.id === 'account_package_download');
    const isPackageBytesValid = accountPackage.metrics.gcsDownloadBytes === 71523;
    if (!isPackageBytesValid) fail('fixture package size changed from the historical 71,523-byte local representative; review the explicit package size assumption');
    const recordsAdded = (d.answersPerSession + 2) * d.completionsPerDauDay * 30;
    const activeAccounts = d.dau * d.accountShare * d.monthlyActiveFactor;
    const dauAccounts = d.dau * d.accountShare;
    const pitrGiB = (activeAccounts * d.historyN + dauAccounts * recordsAdded / 2) * 1135 / GIB;
    const flowIds = [
      'account_session_base', `history_${d.historyN}_session`, `account_completion_sync_${d.answersPerSession + 2}records`, `history_${d.historyN}_completion`,
      'account_foreground', 'account_reconnect', 'account_extra_entitlement_refresh',
      'account_answer_local', 'account_completion_local', 'guest_session_local',
      'guest_foreground_local', 'guest_reconnect_local', 'guest_answer_local',
      'guest_completion_local', 'account_package_download'
    ];
    return {
      name: `dau-${d.dau}-${d.kind}`, kind: d.kind, flowIds, packageDelivery: 'directGcs',
      dau: d.dau, accountShare: d.accountShare, sessionsPerDauDay: d.sessionsPerDauDay,
      sessionDurationMinutes: d.sessionDurationMinutes, foregroundReturnsPerSession: d.foregroundReturnsPerSession,
      answersPerSession: d.answersPerSession, completionsPerDauDay: d.completionsPerDauDay,
      premiumRefreshesPerSession: d.premiumRefreshesPerSession, reconnectsPerDauDay: d.reconnectsPerDauDay,
      historyPagesPerSession: 0, monthlyActiveAccounts: activeAccounts,
      retryAttemptsPerRequest: d.retryAttemptsPerRequest, packageDownloadsPerAccountMonth: d.packageDownloadsPerAccountMonth,
      packageBytes: 71523, retainedPackageGiB: .1, historyAccountsStored: activeAccounts,
      historyRecordsPerAccountAtStart: d.historyN, historyRecordBytes: 1135,
      historyRecordsAddedPerAccountMonth: recordsAdded, historyRetentionDays: 30,
      pitrGiB, activeWindowHoursPerDay: d.activeWindowHoursPerDay,
      min0ColdStartsPerDay: d.min0ColdStartsPerDay, min1ColdStartsPerDay: 1,
      startupMs: 3000, shutdownMs: 1000, extraCpuBoostMsPerStart: 13000,
      cpuBoostMultiplier: 2, concurrency: 80, cpuVcpu: 1, memoryGiB: .5
    };
  });
  const versionInfo = matrix.source ?? {};
  return {
    schema: 'cost02-model-input-v1', pricingFile: 'cost02-prices.json', durationDays: 30,
    assumptions: {
      generatedAtUtc, sourceMatrixSha256: matrixSha256,
      sourceInputKind: matrix.sourceInputKind ?? 'matrix-json',
      sourceInputSha256: matrix.sourceInputSha256 ?? matrixSha256,
      sourceBackendHead: versionInfo.backendHead ?? null,
      sourceBackendHarnessSha256: versionInfo.backendHarnessSha256 ?? null,
      sourceFrontendSha: versionInfo.frontendSha ?? null,
      sourceLifecycleHelperSha256: versionInfo.lifecycleHelperSha256 ?? null,
      trafficIsScenarioAssumption: true,
      sessionColdMountPerModeledSession: 'Every modeled session includes account cold JS/SDK mount as an upper workload; foreground returns are separately counted. Warm rerender is measured zero but is not used as an expected traffic frequency.',
      accountSessionDerivation: 'account_session_base = cold_start_account - account_retry_account_data_sync_current; trailing account-data read is modeled separately only where selected.',
      completionSyncDerivation: 'account_completion_sync_base = account_changed_sync_retry_success - account_retry_account_data_sync_current; successful retry sequence retained, standalone failure observation excluded.',
      completionSyncScaling: 'The successful measured completion sync is a 3-record unit. For Q=answersPerSession+2 terminal records, reads are 7+2Q and committed writes are 2Q+2 from verified store.applyBatch mapping; response bytes scale Q/3 as a conservative payload-envelope approximation. Incoming bytes are excluded from egress costs.',
      historySweepSelection: 'Select one full-sweep cardinality equal to historyRecordsPerAccountAtStart; count once at session and once after completion. Full sweep is not multiplied by historyPagesPerSession.',
      retryRates: '0.01 extra attempts per request moderate; 0.05 peak. Conservative scenario multiplier, not measured failure probability.',
      premiumRefreshFrequency: '0.1 moderate / 0.5 peak is an assumed fraction of account sessions with an additional premium-entry/admission/manual/SDK entitlement refresh; not measured behavior. Production authorizePremiumSessionStart can refresh/getEntitlements; native SDK subscription refresh frequency is unmeasured.',
      cloudRunServiceTime: '100ms assumed service time per app HTTP request for base case; sensitivity runs at 50ms, 500ms, 1,000ms. Local emulator/service timings are diagnostics only.',
      packageSize: '71,523B historical local representative gzip artifact; size only, not current content candidate or download-frequency evidence.',
      historyRecordBytes: '1,135B modeled record payload assumption; not provider physical stored size and excludes metadata/index overhead.',
      historyPolicy: '30-day cost horizon; retention assumption >=30 days and no history expiry/deletion within modeled month. 90/365-day outputs are hypothetical storage sensitivities only.',
      pitr: 'Explicit quantity set equal to estimated mean primary history GiB under each scenario; historical COST01 note records PITR enabled but there is no fresh provider inventory/configuration read.',
      coldStarts: 'min=0 24/day moderate or 72/day peak; min=1 one/day; startup 3s and shutdown 1s each; additional 13s CPU boost at 2x for a 1-vCPU instance (official behavior, assumed frequency).',
      sharedCharges: 'Registry 0.4GiB, Secret Manager 3 active versions and 3,000 accesses/month per profile are explicit scenario assumptions; not refreshed inventory. Free shared allowances remain unapplied.'
    },
    flowObservations: flows,
    profiles,
    sharedUsage: {
      applyFirestoreDailyFreeQuota: false, firestoreReadsIncludedDaily: 50000,
      firestoreWritesIncludedDaily: 20000, firestoreDeletesIncludedDaily: 20000,
      artifactRegistryStoredGiB: .4, secretManagerActiveVersions: 3,
      secretManagerAccesses: 3000
    }
  };
}

export function parseMatrixInput(bytes) {
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const text = raw.toString('utf8');
  const inputSha256 = createHash('sha256').update(raw).digest('hex');
  try {
    const parsed = JSON.parse(text);
    if (parsed?.schema === 'cost02-client-matrix-v1' && Array.isArray(parsed.flowObservations)) {
      parsed.sourceInputKind = 'matrix-json';
      parsed.sourceInputSha256 = inputSha256;
      return { matrix: parsed, matrixSha256: inputSha256, sourceInputKind: 'matrix-json', sourceInputSha256: inputSha256 };
    }
  } catch { /* Runner logs are not necessarily JSON documents. */ }

  const candidates = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.schema === 'cost02-client-matrix-v1' && Array.isArray(parsed.flowObservations)) candidates.push({ parsed, line });
    } catch { /* Ignore non-JSON progress lines. */ }
  }
  if (candidates.length !== 1) fail(`runner log must contain exactly one cost02-client-matrix-v1 JSON line; found ${candidates.length}`);
  const { parsed, line } = candidates[0];
  const matrixSha256 = createHash('sha256').update(line, 'utf8').digest('hex');
  parsed.sourceInputKind = 'runner-log-single-matrix-line';
  parsed.sourceInputSha256 = inputSha256;
  return { matrix: parsed, matrixSha256, sourceInputKind: 'runner-log-single-matrix-line', sourceInputSha256: inputSha256 };
}

function main() {
  if (process.argv.length !== 4) fail('usage: node cost02-build-input.mjs <client-matrix.json|client-matrix-run.log> <output.json>');
  const [matrixPath, outputPath] = process.argv.slice(2).map(p => path.resolve(p));
  const bytes = fs.readFileSync(matrixPath);
  const source = parseMatrixInput(bytes);
  const output = buildInput(source.matrix, source.matrixSha256);
  output.assumptions.sourceInputKind = source.sourceInputKind;
  output.assumptions.sourceInputSha256 = source.sourceInputSha256;
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`input written: ${outputPath}\nsource kind: ${source.sourceInputKind}\nsource input sha256: ${source.sourceInputSha256}\nmatrix sha256: ${source.matrixSha256}\n`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main(); } catch (error) { process.stderr.write(`COST02_BUILD_INPUT_ERROR: ${error.message}\n`); process.exitCode = 2; }
}
