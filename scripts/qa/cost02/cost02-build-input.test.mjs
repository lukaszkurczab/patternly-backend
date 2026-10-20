import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildInput, parseMatrixInput } from './cost02-build-input.mjs';

function row(id, overrides = {}) {
  return {
    id, event: 'session', audience: 'account', sampleCount: 1,
    requests: 0, firestoreReadsObserved: 0, firestoreReadsBillableEstimate: 0,
    missingPointReads: 0, queryCount: 0, emptyQueryCount: 0,
    firestoreWrites: 0, firestoreDeletes: 0, requestBytes: 0, responseBytes: 0,
    gcsDownloads: 0, gcsDownloadBytes: 0, httpServiceTimeMsSum: 0, httpServiceTimeMsMax: 0,
    evidenceRef: `matrix#/flowObservations/${id}`, ...overrides
  };
}
function fixtureMatrix() {
  const rows = [
    row('cold_start_account', { requests: 3, firestoreReadsObserved: 23, firestoreReadsBillableEstimate: 23, responseBytes: 3877, httpServiceTimeMsSum: 42 }),
    row('account_retry_account_data_sync_current', { requests: 1, firestoreReadsObserved: 11, firestoreReadsBillableEstimate: 11, responseBytes: 3220, httpServiceTimeMsSum: 20 }),
    row('account_changed_sync_retry_success', { requests: 2, firestoreReadsObserved: 24, firestoreReadsBillableEstimate: 24, firestoreWrites: 8, responseBytes: 6435, httpServiceTimeMsSum: 50 }),
    row('background_foreground_account', { requests: 2, firestoreReadsObserved: 12, firestoreReadsBillableEstimate: 12 }),
    row('reconnect_account', { requests: 1, firestoreReadsObserved: 6, firestoreReadsBillableEstimate: 6 }),
    row('account_entitlements_refresh', { requests: 1, firestoreReadsObserved: 6, firestoreReadsBillableEstimate: 6 }),
    row('account_local_answer_commit'), row('account_local_completion_commit'),
    row('cold_start_guest'), row('background_foreground_guest'), row('reconnect_guest'),
    row('guest_local_answer_commit'), row('guest_local_completion_commit'),
    row('account_content_package_download', { requests: 1, firestoreReadsObserved: 14, firestoreReadsBillableEstimate: 14, responseBytes: 73021, gcsDownloads: 1, gcsDownloadBytes: 71523, httpServiceTimeMsSum: 31 }),
    row('account_history_0', { requests: 1, firestoreReadsObserved: 8, firestoreReadsBillableEstimate: 9, responseBytes: 70 }),
    row('account_history_100', { requests: 1, firestoreReadsObserved: 108, firestoreReadsBillableEstimate: 108, responseBytes: 116071 }),
    row('account_history_1000', { requests: 10, firestoreReadsObserved: 1089, firestoreReadsBillableEstimate: 1089, responseBytes: 1163105 }),
    row('account_history_10000', { requests: 100, firestoreReadsObserved: 10899, firestoreReadsBillableEstimate: 10899, responseBytes: 11633634 })
  ];
  return { schema: 'cost02-client-matrix-v1', flowObservations: rows, source: { backendHead: 'fixture-head' } };
}

test('input builder derives app flows, keeps GCS payload separate, and binds six profiles to one history size', () => {
  const input = buildInput(fixtureMatrix(), 'a'.repeat(64), '2026-10-20T00:00:00.000Z');
  const session = input.flowObservations.find(flow => flow.id === 'account_session_base');
  const completion = input.flowObservations.find(flow => flow.id === 'account_completion_sync_base');
  const moderateCompletion = input.flowObservations.find(flow => flow.id === 'account_completion_sync_12records');
  const peakCompletion = input.flowObservations.find(flow => flow.id === 'account_completion_sync_22records');
  const packageFlow = input.flowObservations.find(flow => flow.id === 'account_package_download');
  assert.equal(session.metrics.requests, 2);
  assert.equal(session.metrics.firestoreReadsBillableEstimate, 12);
  assert.equal(session.metrics.responseBytes, 657);
  assert.equal(session.metrics.httpServiceTimeMsSum, undefined);
  assert.equal(completion.metrics.requests, 1);
  assert.equal(completion.metrics.firestoreWrites, 8);
  assert.equal(completion.metrics.responseBytes, 3215);
  assert.equal(moderateCompletion.metrics.firestoreReadsBillableEstimate, 31);
  assert.equal(moderateCompletion.metrics.firestoreWrites, 26);
  assert.equal(peakCompletion.metrics.firestoreReadsBillableEstimate, 51);
  assert.equal(peakCompletion.metrics.firestoreWrites, 46);
  assert.equal(packageFlow.metrics.responseBytes, 1498);
  assert.equal(packageFlow.metrics.gcsDownloadBytes, 71523);
  assert.equal(packageFlow.metrics.gcsClassBOperations, 1);
  assert.equal(input.profiles.length, 6);
  assert.equal(input.profiles[0].flowIds.includes('history_1000_session'), true);
  assert.equal(input.profiles[0].flowIds.includes('account_completion_sync_12records'), true);
  assert.equal(input.profiles[3].flowIds.includes('history_10000_session'), true);
  assert.equal(input.profiles[3].flowIds.includes('account_completion_sync_22records'), true);
  assert.equal(input.assumptions.sourceMatrixSha256, 'a'.repeat(64));
});

test('input builder fails closed if derivation subtraction would hide negative work', () => {
  const matrix = fixtureMatrix();
  matrix.flowObservations.find(r => r.id === 'account_retry_account_data_sync_current').requests = 9;
  assert.throws(() => buildInput(matrix, 'b'.repeat(64)), /makes requests negative/);
});

test('matrix input parser binds either exact JSON bytes or one matrix line in runner log', () => {
  const matrix = fixtureMatrix();
  const line = JSON.stringify(matrix);
  const rawLog = Buffer.from(`runner started\n${line}\nrunner finished\n`);
  const parsedLog = parseMatrixInput(rawLog);
  assert.equal(parsedLog.sourceInputKind, 'runner-log-single-matrix-line');
  assert.equal(parsedLog.matrixSha256, createHash('sha256').update(line).digest('hex'));
  assert.equal(parsedLog.sourceInputSha256, createHash('sha256').update(rawLog).digest('hex'));
  const direct = Buffer.from(line);
  const parsedJson = parseMatrixInput(direct);
  assert.equal(parsedJson.sourceInputKind, 'matrix-json');
  assert.equal(parsedJson.matrixSha256, createHash('sha256').update(direct).digest('hex'));
  assert.throws(() => parseMatrixInput(Buffer.from('noise\n')), /found 0/);
  assert.throws(() => parseMatrixInput(Buffer.from(`${line}\n${line}\n`)), /found 2/);
});
