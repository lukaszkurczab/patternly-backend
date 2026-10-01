import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTlsFixture } from "./operatorCliTestSupport.js";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bridgePath = join(backendRoot, "tests/fixtures/operator-cli-pty.py");
const tokenPrompt = "Operator OIDC token (hidden): ";
const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

function fixtureToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "native-fixture-key", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "https://fixture-issuer.invalid", aud: "patternly-operators", sub: "fixture-operator", iat: now - 5, exp: now + 300 })).toString("base64url");
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key).toString("base64url")}`;
}

type TerminalResult = Readonly<{
  exitCode: number | null;
  output: string;
  secretEchoed: boolean;
  matchedSteps: number;
  echoRestored: boolean;
  reason?: string;
}>;

async function runNative(
  command: readonly string[],
  origin: string,
  caCertificatePath: string,
  steps: readonly Readonly<{ expect: string; send: string }>[],
  secrets: readonly string[],
  payload = "",
  payloadOnStdin = false,
): Promise<TerminalResult> {
  const directory = await mkdtemp(join(tmpdir(), "patternly-cli-native-"));
  try {
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({ allowedOrigins: [origin] }));
    const child = spawn("python3", [bridgePath], { cwd: backendRoot, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    // The bridge emits only a sanitized JSON result, including on input errors.
    child.stderr.resume();
    const finished = new Promise<number | null>((accept, reject) => {
      child.once("error", reject);
      child.once("exit", accept);
    });
    child.stdin.end(JSON.stringify({
      argv: [process.execPath, "--import", "tsx", join(backendRoot, "scripts/operator-cli.ts"), ...command, "--config", configPath, "--origin", origin],
      cwd: backendRoot,
      env: { NODE_EXTRA_CA_CERTS: caCertificatePath },
      payload, payloadOnStdin, steps, secrets,
    }));
    assert.equal(await finished, 0, "native fixture bridge failed");
    const result = JSON.parse(output) as TerminalResult;
    assert.equal(result.reason, undefined, `native CLI did not complete its terminal flow: ${result.output}`);
    assert.equal(result.secretEchoed, false, "CLI exposed token or mutation body in its terminal output");
    assert.equal(result.echoRestored, true, "CLI did not restore terminal echo");
    assert.equal(result.matchedSteps, steps.length, `CLI omitted a required input prompt: ${result.output}`);
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function legalDetails(requestId: string, revision = 0, legalHold = false) {
  return {
    requestId, kind: "complaint", status: "received", receivedAt: "2026-10-01T00:00:00.000Z",
    responseDueAt: null, answeredAt: null, retentionUntil: null, legalHold, revision,
    narrative: "Readable fixture context", transactionId: null,
  };
}

test("standalone CLI reads through verified TLS and a hidden real terminal token", async () => {
  const token = fixtureToken();
  let reads = 0;
  let authorizationMatched = true;
  const fixture = await createTlsFixture((request, response) => {
    reads += 1;
    authorizationMatched &&= request.headers.authorization === `Bearer ${token}`;
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/v1/operator/legal-requests");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ items: [], truncated: false }));
  });
  try {
    const result = await runNative(["list", "legal-requests"], fixture.origin, fixture.caCertificatePath, [{ expect: tokenPrompt, send: `${token}\n` }], [token]);
    assert.equal(result.exitCode, 0);
    assert.equal(reads, 1);
    assert.equal(authorizationMatched, true);
  } finally { await fixture.close(); }
});

for (const payloadOnStdin of [false, true]) {
test(`standalone CLI cancellation sends no mutation after reading payload from ${payloadOnStdin ? "piped stdin" : "FD3"}`, async () => {
  const token = fixtureToken();
  const id = `lr_${randomUUID()}`;
  const reason = "native-private-body-marker";
  let reads = 0;
  let writes = 0;
  const fixture = await createTlsFixture((request, response) => {
    if (request.method === "GET") reads += 1;
    else writes += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ item: legalDetails(id) }));
  });
  try {
    const phrase = `apply legal-requests set_legal_hold to ${id}`;
    const result = await runNative(["action", "legal-requests", id, ...(payloadOnStdin ? [] : ["--payload-fd", "3"])], fixture.origin, fixture.caCertificatePath, [
      { expect: tokenPrompt, send: `${token}\n` },
      { expect: `Type "${phrase}" to confirm: `, send: "no\n" },
    ], [token, reason], JSON.stringify({ action: "set_legal_hold", expectedRevision: 0, active: true, reason }), payloadOnStdin);
    assert.match(result.output, /cancel/iu);
    assert.equal(reads, 1);
    assert.equal(writes, 0);
  } finally { await fixture.close(); }
});

}

test("standalone CLI lost mutation response makes one write and one reconciliation read", async () => {
  const token = fixtureToken();
  const id = `lr_${randomUUID()}`;
  const reason = "native-private-body-marker";
  let reads = 0;
  let writes = 0;
  let held = false;
  const fixture = await createTlsFixture((request, response) => {
    if (request.method === "PATCH") {
      writes += 1;
      held = true;
      request.resume();
      response.socket?.destroy();
      return;
    }
    reads += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ item: legalDetails(id, held ? 1 : 0, held) }));
  });
  try {
    const phrase = `apply legal-requests set_legal_hold to ${id}`;
    const result = await runNative(["action", "legal-requests", id, "--payload-fd", "3"], fixture.origin, fixture.caCertificatePath, [
      { expect: tokenPrompt, send: `${token}\n` },
      { expect: `Type "${phrase}" to confirm: `, send: `${phrase}\n` },
    ], [token, reason], JSON.stringify({ action: "set_legal_hold", expectedRevision: 0, active: true, reason }));
    assert.equal(result.exitCode, 2);
    assert.match(result.output, /AMBIGUOUS.*RECONCILIATION REQUIRED/iu);
    assert.equal(writes, 1);
    assert.equal(reads, 2);
  } finally { await fixture.close(); }
});

test("standalone CLI Ctrl+C restores terminal and stops before any HTTP request", async () => {
  let requests = 0;
  const fixture = await createTlsFixture((_request, response) => {
    requests += 1;
    response.end("{}");
  });
  try {
    const result = await runNative(["list", "legal-requests"], fixture.origin, fixture.caCertificatePath, [{ expect: tokenPrompt, send: "\u0003" }], []);
    assert.equal(result.exitCode, 130);
    assert.equal(requests, 0);
  } finally { await fixture.close(); }
});
