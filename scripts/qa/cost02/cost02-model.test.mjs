import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculate } from './cost02-model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const input = JSON.parse(fs.readFileSync(path.join(here, 'cost02-example-input.json'), 'utf8'));
const prices = JSON.parse(fs.readFileSync(path.join(here, 'cost02-prices.json'), 'utf8'));

test('hand example scales trigger counts and prices Firestore reads at Warsaw list rates', () => {
  const result = calculate(input, prices).scenarios[0];
  assert.equal(result.monthlySessions, 45_000);
  assert.equal(result.volumes.requests, 45_000);
  assert.equal(result.volumes.firestoreReadsBillableEstimate, 180_000);
  assert.equal(result.firestore.observedSdkDocumentSnapshots, 135_000);
  assert.equal(result.firestore.estimatedCandidateMissingPointReads, 45_000);
  assert.equal(result.firestore.costUsd.reads, 0.0702);
  assert.notEqual(result.firestore.observedSdkDocumentSnapshots, result.firestore.estimatedBillableDocumentReads);
  assert.ok(Math.abs(result.network.cloudRunAppResponseGiB - (256 * 45_000) / (1024 ** 3)) < 1e-12);
  assert.equal(result.network.inboundRequestBytesExcluded, true);
  assert.match(result.scope, /^MODELED:/);
});

test('automatic min=1 bills its designated instance idle floor; manual count zero is excluded', () => {
  const result = calculate(input, prices).scenarios[0];
  const run0 = result.cloudRun.min0;
  const run1 = result.cloudRun.min1;
  assert.equal(run0.manualCount0.includes('disabled'), true);
  assert.equal(run0.minInstanceIdleBilledSeconds, 0);
  assert.ok(run1.minInstanceIdleBilledSeconds > 29 * 86400);
  assert.ok(run1.minInstanceIdleBilledSeconds < 30 * 86400);
  assert.ok(run1.costUsd.cpuIdle > 0);
});

test('local app.inject timing stays diagnostic; provider service time is a separate explicit input', () => {
  const changed = structuredClone(input);
  changed.flowObservations[0].sampleCount = 2;
  changed.flowObservations[0].requests = 2;
  changed.flowObservations[0].httpServiceTimeMsSum = 1800;
  changed.flowObservations[0].httpServiceTimeMsMax = 1000;
  const result = calculate(changed, prices).scenarios[0];
  assert.equal(result.flowRequests[0].localHttpServiceTimeMsDiagnostic, 900);
  assert.equal(result.cloudRun.min0.requestServiceTimeMeanMsAssumption, 100);
  assert.equal(result.sensitivity.cloudRunServiceTimeMultipliers.length, 3);
});

test('unknown billable reads fail closed rather than pricing SDK observations as billing units', () => {
  const changed = structuredClone(input);
  changed.flowObservations[0].firestoreReadsBillableEstimate = null;
  const result = calculate(changed, prices).scenarios[0];
  assert.equal(result.firestore.readsUnknown, true);
  assert.equal(result.totalCostUsd.min0, null);
  assert.match(result.scope, /^PARTIAL:/);
});

test('profiles must select mutually alternative measured flow observations explicitly', () => {
  const changed = structuredClone(input);
  changed.flowObservations.push({
    ...structuredClone(input.flowObservations[0]),
    id: 'alternative-history-size',
    requests: 100,
    responseBytes: 9000,
    evidenceRef: 'alternate measured cardinality, not simultaneous with hand-session-example'
  });
  const result = calculate(changed, prices).scenarios[0];
  assert.equal(result.volumes.requests, 45_000);
  assert.deepEqual(result.flowCoverage.excludedFlowIds, ['alternative-history-size']);
  changed.profiles[0].flowIds.push('not-a-flow');
  assert.throws(() => calculate(changed, prices), /unknown observation/);
});

test('finite-difference marginal excludes daily one-time cold-start assumptions', () => {
  const changed = structuredClone(input);
  changed.flowObservations[0].requests = 0;
  changed.flowObservations[0].firestoreReadsObserved = 0;
  changed.flowObservations[0].firestoreReadsBillableEstimate = 0;
  changed.flowObservations[0].responseBytes = 0;
  const result = calculate(changed, prices).scenarios[0];
  assert.equal(result.cloudRun.min0.startupShutdownAssumptions.startsPerDay, 1);
  assert.equal(result.marginalCostPer1000SessionsUsd.min0, 0);
  assert.equal(result.marginalCostPer1000SessionsUsd.min1, 0);
  assert.match(result.marginalCostPer1000SessionsUsd.method, /finite difference/);
});

test('Warsaw min=1 idle-only hand example matches the independent 30-day price arithmetic', () => {
  const changed = structuredClone(input);
  changed.profiles[0].sessionsPerDauDay = 0;
  changed.profiles[0].min1ColdStartsPerDay = 0;
  changed.profiles[0].min0ColdStartsPerDay = 0;
  const result = calculate(changed, prices).scenarios[0];
  assert.equal(result.cloudRun.min1.minInstanceIdleBilledSeconds, 30 * 86400);
  assert.ok(Math.abs(result.cloudRun.min1.costUsd.cpuIdle + result.cloudRun.min1.costUsd.memoryIdle - 13.608) < 1e-12);
  assert.equal(result.cloudRun.min0.costUsd.total, 0);
  const historicalHoursRate = 55.7 * 3600 * (prices.rates.cloudRun.cpuIdleMinInstancePerVcpuSecond + 0.5 * prices.rates.cloudRun.memoryIdleMinInstancePerGiBSecond);
  assert.ok(Math.abs(historicalHoursRate - 1.05273) < 1e-5);
});

test('pricing regression guard locks Firestore to the extracted Warsaw row, not the Iowa default', () => {
  assert.equal(prices.region, 'europe-central2');
  assert.equal(prices.rates.firestore.readsPer100000, 0.039);
  assert.equal(prices.rates.firestore.writesPer100000, 0.117);
  assert.equal(prices.rates.firestore.deletesPer100000, 0.013);
  assert.equal(prices.rates.firestore.storagePerGiBHour, 0.000267123);
  assert.equal(prices.rates.firestore.pitrStoragePerGiBHour, 0.000267123);
  assert.match(prices.sources.firestoreEvidence.fetchedHtmlSha256, /^[a-f0-9]{64}$/);
});

test('PITR is an explicit priced quantity and shorter retention cannot imply history expiry', () => {
  const changed = structuredClone(input);
  changed.profiles[0].pitrGiB = 0.25;
  const result = calculate(changed, prices).scenarios[0];
  assert.ok(Math.abs(result.pitr.costUsd - 0.25 * 30 * 24 * prices.rates.firestore.pitrStoragePerGiBHour) < 1e-12);
  assert.deepEqual(result.storageRetentionSensitivity.map(x => x.retentionDays), [30, 90, 365]);
  assert.ok(result.storageRetentionSensitivity.every(x => x.expiryWithinModeled30Days === false));
  changed.profiles[0].historyRetentionDays = 7;
  assert.throws(() => calculate(changed, prices), /must be >= 30/);
});

test('signed-URL package bytes use GCS egress and Class B; descriptor uses Cloud Run egress', () => {
  const direct = structuredClone(input);
  direct.profiles[0].packageDelivery = 'directGcs';
  direct.profiles[0].packageDownloadsPerAccountMonth = 1;
  direct.profiles[0].packageBytes = 71523;
  direct.flowObservations.push({
    id: 'historical-package-size-example', event: 'packageDownload', audience: 'account', sampleCount: 1,
    requests: 0, gcsDownloads: 1, gcsDownloadBytes: 71523,
    evidenceRef: 'historical local representative package size 71523 B; size reference only, not download-frequency evidence'
  });
  direct.profiles[0].flowIds.push('historical-package-size-example');
  const directResult = calculate(direct, prices).scenarios[0];
  assert.ok(Math.abs(directResult.cloudStorage.classBOperations - 800) < 1e-9);
  assert.ok(directResult.network.directGcsPackageEgressGiB > 0);
  assert.equal(directResult.cloudRun.min0.costUsd.requests, input.profiles[0].dau * input.profiles[0].sessionsPerDauDay * 30 / 1e6 * prices.rates.cloudRun.requestsPerMillion);
  assert.ok(directResult.network.cloudRunAppResponseGiB > 0);
});


test('schema accepts measured and explicit hand inputs while rejecting missing measured lineage', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(here, 'cost02-model-input.schema.json'), 'utf8'));
  const validate = new Ajv2020({ strict: false, formats: { 'date-time': value => Number.isFinite(Date.parse(value)) } }).compile(schema);
  const measured = JSON.parse(fs.readFileSync(path.join(here, 'cost02-calibrated-input.json'), 'utf8'));
  assert.equal(validate(input), true, JSON.stringify(validate.errors));
  assert.equal(validate(measured), true, JSON.stringify(validate.errors));
  delete measured.assumptions.sourceMatrixSha256;
  assert.equal(validate(measured), false);
});
