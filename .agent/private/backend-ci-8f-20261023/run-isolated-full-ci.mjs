import { spawnSync } from 'node:child_process';
import { runIsolatedEmulatorTests } from '../../../scripts/isolated-emulator-test-runner.mjs';

const backendRoot = process.cwd();
const isolatedEnv = { PATTERNLY_ISOLATED_TEST_PORT_BASE: '19419' };
const steps = [
  ['lint', () => npm('run', 'lint')],
  ['typecheck', () => npm('run', 'typecheck')],
  ['firestore:ttl:check', () => npm('run', 'firestore:ttl:check')],
  ['test:emulator (demo isolation)', () => runIsolatedEmulatorTests({ backendRoot, projectId: 'demo-patternly-ci-8f-20261023', command: 'npm test', environment: isolatedEnv })],
  ['test:progress-paging:client', () => npm('run', 'test:progress-paging:client')],
  ['test:operator:emulator', () => npm('run', 'test:operator:emulator')],
  ['test:operator:acceptance', () => npm('run', 'test:operator:acceptance')],
  ['openapi:check', () => npm('run', 'openapi:check')],
  ['frontend:client:check', () => npm('run', 'frontend:client:check')],
  ['build', () => npm('run', 'build')],
];
function npm(...args) {
  const result = spawnSync('npm', args, { cwd: backendRoot, env: process.env, stdio: 'inherit' });
  return result.status ?? 1;
}
for (const [name, run] of steps) {
  console.log(`\n=== CI stage: ${name} ===`);
  let code;
  try { code = await run(); }
  catch (error) { console.error(`CI stage error: ${name}: ${error instanceof Error ? error.message : 'unknown'}`); code = 1; }
  if (code !== 0) {
    console.error(`CI stopped at ${name} (exit ${code}); no retry.`);
    process.exitCode = code;
    break;
  }
}
