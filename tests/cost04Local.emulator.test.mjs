import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { validateIsolatedEmulatorRuntime } from "../scripts/isolated-emulator-test-runner.mjs";
validateIsolatedEmulatorRuntime(process.env, "demo-patternly-cost04");
const frontendRoot = process.env.PATTERNLY_FRONTEND_ROOT;
if (!frontendRoot || execFileSync("git", ["-C", frontendRoot, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 }).trim() !== process.env.PATTERNLY_FRONTEND_EXPECTED_SHA) throw new Error("cost04_frontend_pin_mismatch");
const load = createRequire(resolve(frontendRoot, "package.json"));
const { createPatternlyApiClient } = load(resolve(frontendRoot, "src/infrastructure/clients/PatternlyApiClientAdapter.ts"));

test("real APP fetch preserves loopback 429 and bounded explicit retries for GET/POST", { timeout: 15_000 }, async () => {
  let calls = 0; let body = "No instances"; let retryAfter = "1"; let stall = false;
  const server = createServer((request, response) => {
    calls++;
    request.resume();
    response.writeHead(429, { "content-type": "text/plain", ...(retryAfter === null ? {} : { "retry-after": retryAfter }) });
    if (stall) { response.flushHeaders(); response.write("{"); } else response.end(body);
  });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const api = createPatternlyApiClient({ apiOrigin: `http://127.0.0.1:${server.address().port}`, allowLocalHttpForSimulator: true,
    getIdToken: async () => "local-fixture-id", getAppCheckToken: async () => "local-fixture-app-check", timeoutMs: 150 });
  const register = () => api.registerAccount({ termsVersion: "fixture", termsLocale: "en", privacyPolicyVersion: "fixture", privacyPolicyLocale: "en", privacyPolicyAcknowledged: true });
  try {
    for (const scenario of [
      { body: "No instances", retryAfter: "1" },
      { body: JSON.stringify({ error: { code: "recovery_rate_limited" } }), retryAfter: "1" },
      { body: "", retryAfter: null }, { body: "No instances", retryAfter: "invalid" },
      { body: "{", retryAfter: "1", stall: true },
    ]) {
      body = scenario.body; retryAfter = scenario.retryAfter; stall = scenario.stall ?? false;
      for (const operation of [() => api.getMe(), register]) {
        const before = calls;
        await assert.rejects(operation(), (error) => error.code === "server_error" && error.status === 429
          && error.retryAfterSeconds === (retryAfter === "1" ? 1 : undefined));
        assert.equal(calls, before + 1, "adapter does not automatically retry GET or non-idempotent registration");
      }
    }
    // The caller elects one retry after the supplied delay; never a mutation retry.
    body = "No instances"; retryAfter = "1"; stall = false;
    const before = calls;
    await assert.rejects(api.getMe(), (error) => error.status === 429 && error.retryAfterSeconds === 1);
    await new Promise((accept) => setTimeout(accept, 1_000));
    await assert.rejects(api.getMe(), (error) => error.status === 429);
    assert.equal(calls, before + 2);
    assert.equal(calls, 12, "fixed request budget");
    console.log(JSON.stringify({ stage: "loopback_http_429", requests: calls, automaticRetries: 0, explicitGetRetries: 1 }));
  } finally { server.closeAllConnections(); await new Promise((accept) => server.close(accept)); }
});
