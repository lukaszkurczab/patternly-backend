import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import firestorePackage from '@google-cloud/firestore';
import { grpc } from 'google-gax';
import { validateIsolatedEmulatorRuntime } from '../../../scripts/isolated-emulator-test-runner.mjs';
const { Firestore, setLogFunction, v1 } = firestorePackage;

const projectId = 'demo-patternly-closed-read';
validateIsolatedEmulatorRuntime(process.env, projectId);
const host = process.env.FIRESTORE_EMULATOR_HOST;
assert.equal(host, '127.0.0.1:19520');
const endpoint = new URL(`http://${host}`);
assert.equal(endpoint.hostname, '127.0.0.1');
const database = `projects/${projectId}/databases/(default)`;
const db = new Firestore({ projectId, host, ssl: false });
const rpc = new v1.FirestoreClient({ projectId, servicePath: endpoint.hostname, port: Number(endpoint.port), sslCreds: grpc.credentials.createInsecure() });
const fixture = db.collection('closedReadProbe').doc(randomUUID());
const result = { kind: 'closed_read_sdk_boundary', project: projectId, control: null, adapted: null, cleanup: null };
const tokens = [];
let capturedToken;
const emit = value => process.stdout.write(`CLOSED_READ_PROBE ${JSON.stringify(value)}\n`);
const isClosed = error => error?.code === 3 && (error.details === 'Transaction is invalid or closed.' || (error.details === undefined && ['3 INVALID_ARGUMENT: Transaction is invalid or closed.', 'Transaction is invalid or closed.'].includes(error.message)));
const safe = error => ({ code: typeof error?.code === 'number' ? error.code : null, exactClosedDetails: error?.details === 'Transaction is invalid or closed.', exactClosedMessage: ['3 INVALID_ARGUMENT: Transaction is invalid or closed.', 'Transaction is invalid or closed.'].includes(error?.message), category: isClosed(error) ? 'transaction_invalid_or_closed' : 'other' });
setLogFunction(message => {
  const match = /\[Firestore.requestStream\]: Received response: ([\s\S]*)$/u.exec(message);
  if (!match) return;
  let parsed;
  try { parsed = JSON.parse(match[1]); } catch { return; }
  const value = parsed.transaction;
  let token;
  if (typeof value === 'string' && value.length > 0) token = Buffer.from(value, 'base64');
  else if (Array.isArray(value?.data) && value.data.length > 0) token = Buffer.from(value.data);
  else if (Array.isArray(value) && value.length > 0) token = Buffer.from(value);
  if (token?.length) capturedToken = token;
});
const read = async (operation, adapt) => {
  try { return await operation(); }
  catch (error) {
    if (!adapt || !isClosed(error)) throw error;
    throw Object.assign(new Error('progress_transaction_closed', { cause: error }), { code: 10 });
  }
};
async function scenario(name, adapt) {
  const root = fixture.collection('scenarios').doc(name);
  const metadata = root.collection('metadata').doc('account');
  const record = root.collection('records').doc('item');
  const receipt = root.collection('receipts').doc('mutation');
  await root.create({ active: true });
  await metadata.create({ revision: 0 });
  let attempts = 0;
  let injected = false;
  const attemptTokens = [];
  let outcome;
  try {
    const value = await db.runTransaction(async tx => {
      attempts++;
      capturedToken = undefined;
      await read(() => tx.get(root), adapt);
      assert.ok(capturedToken?.length, 'probe_public_logger_token_unavailable');
      const token = Buffer.from(capturedToken);
      attemptTokens.push(token);
      tokens.push(token);
      if (!injected) {
        injected = true;
        await rpc.rollback({ database, transaction: token }, { otherArgs: { headers: { authorization: 'Bearer owner' } } });
        emit({ scenario: name, stage: 'one_shot_public_rollback_complete', attempt: attempts });
      }
      const current = await read(() => tx.get(metadata), adapt);
      const prior = await read(() => tx.get(receipt), adapt);
      if (prior.exists) return prior.get('result');
      assert.equal(current.get('revision'), 0);
      const value = { revision: 1, version: 1 };
      tx.create(record, { version: 1 });
      tx.create(receipt, { result: value });
      tx.update(metadata, { revision: 1 });
      return value;
    });
    outcome = { status: 'fulfilled', value };
  } catch (error) { outcome = { status: 'rejected', ...safe(error) }; }
  const [meta, storedRecord, storedReceipt] = await db.getAll(metadata, record, receipt);
  const observation = { attempts, injected, freshTransaction: attemptTokens.length === 2 ? !attemptTokens[0].equals(attemptTokens[1]) : null, outcome, revision: meta.get('revision'), recordExists: storedRecord.exists, receiptExists: storedReceipt.exists };
  emit({ scenario: name, observation });
  return observation;
}
let failed = false;
try {
  await fixture.create({ synthetic: true });
  assert.equal((await fixture.get()).exists, true);
  emit({ stage: 'guarded_real_sdk_seed_read_confirmed' });
  result.control = await scenario('control', false);
  assert.equal(result.control.attempts, 1);
  assert.equal(result.control.outcome.status, 'rejected');
  assert.equal(result.control.outcome.code, 3);
  assert.equal(result.control.outcome.exactClosedDetails || result.control.outcome.exactClosedMessage, true);
  assert.equal(result.control.revision, 0);
  assert.equal(result.control.recordExists, false);
  assert.equal(result.control.receiptExists, false);
  result.adapted = await scenario('adapted', true);
  assert.equal(result.adapted.attempts, 2);
  assert.equal(result.adapted.freshTransaction, true);
  assert.equal(result.adapted.outcome.status, 'fulfilled');
  assert.equal(result.adapted.revision, 1);
  assert.equal(result.adapted.recordExists, true);
  assert.equal(result.adapted.receiptExists, true);
  result.status = 'PASS';
} catch (error) {
  failed = true;
  result.status = 'FAIL';
  result.failure = { stage: result.control === null ? 'control_or_setup' : 'adapted_or_contract', ...safe(error) };
} finally {
  try { await db.recursiveDelete(fixture); result.cleanup = 'own_synthetic_fixture_deleted'; }
  catch { failed = true; result.cleanup = 'own_synthetic_fixture_cleanup_failed'; }
  setLogFunction(null);
  capturedToken = undefined;
  tokens.length = 0;
  const channels = await Promise.allSettled([db.terminate(), rpc.close()]);
  result.channelsClosed = channels.every(channel => channel.status === 'fulfilled');
  if (!result.channelsClosed) failed = true;
  if (failed) result.status = 'FAIL';
  await writeFile(new URL('./result.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
  emit({ stage: 'complete', status: result.status, cleanup: result.cleanup, limitation: 'fault_injection_boundary_only_not_natural_ci_cause' });
  process.exitCode = failed ? 1 : 0;
}
