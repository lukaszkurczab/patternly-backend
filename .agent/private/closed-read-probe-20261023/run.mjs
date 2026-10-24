import { runIsolatedEmulatorTests } from '../../../scripts/isolated-emulator-test-runner.mjs';
process.exitCode = await runIsolatedEmulatorTests({ backendRoot: process.cwd(), projectId: 'demo-patternly-closed-read', command: 'node .agent/private/closed-read-probe-20261023/probe.mjs', environment: { PATTERNLY_ISOLATED_TEST_PORT_BASE: '19519' }, timeoutMs: 120000 });
