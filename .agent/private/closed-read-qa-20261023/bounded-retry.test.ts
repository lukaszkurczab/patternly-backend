import assert from 'node:assert/strict';
import test from 'node:test';
import firestorePackage from '@google-cloud/firestore';
import type { Firestore as AdminFirestore, Transaction } from 'firebase-admin/firestore';
import { FirestoreProgressStore } from '../../../src/modules/progress/store.js';
import { createMergeRecordFingerprint } from '../../../src/modules/users/merge.js';
import { attemptState } from '../../../tests/progressFixtures.js';
import { validateIsolatedEmulatorRuntime } from '../../../scripts/isolated-emulator-test-runner.mjs';
const projectId = 'demo-patternly-closed-read-qa';
validateIsolatedEmulatorRuntime(process.env, projectId);
const db = new firestorePackage.Firestore({ projectId, host: process.env.FIRESTORE_EMULATOR_HOST!, ssl: false });
const trackId = 'coding-interview-dsa-problem-solving';
const targetId = 'bounded-read';
const state = attemptState(targetId, trackId);
const mutation = { mutationId: 'bounded-read-mutation', kind: 'item' as const, recordType: 'training_attempt' as const, targetId, trackId, expectedVersion: null, state, fingerprint: createMergeRecordFingerprint({ recordId: targetId, recordType: 'training_attempt', state, trackId }) };
test.after(async () => { await db.terminate(); });
for (const exactClosed of [true, false]) {
  test(`SDK bounds repeated ${exactClosed ? 'exact closed' : 'unrelated'} read failure`, async () => {
    let attempts = 0;
    let reads = 0;
    const original = Object.assign(new Error(exactClosed ? '3 INVALID_ARGUMENT: Transaction is invalid or closed.' : 'invalid argument'), { code: 3, details: exactClosed ? 'Transaction is invalid or closed.' : 'invalid argument' });
    const instrumented = new Proxy(db, { get(target, property) {
      if (property === 'runTransaction') return async (callback: (tx: Transaction) => Promise<unknown>) => target.runTransaction(async tx => {
        attempts++;
        const observed = new Proxy(tx, { get(actual, member) {
          if (member === 'get') return async () => { reads++; throw original; };
          const value: unknown = Reflect.get(actual, member, actual);
          return typeof value === 'function' ? value.bind(actual) : value;
        } });
        return callback(observed);
      });
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const store = new FirestoreProgressStore(instrumented as unknown as AdminFirestore);
    await assert.rejects(store.applyBatch('never-read-user', 1, 'device', 0, [mutation], { sessionId: 'bounded-session', batchId: 'bounded-batch', highWatermark: 1 }), (error: unknown) => {
      if (!exactClosed) return error === original;
      return (error as Error).cause === original && (error as { code?: unknown }).code === 10;
    });
    assert.equal(attempts, exactClosed ? 5 : 1);
    assert.equal(reads, attempts);
  });
}
