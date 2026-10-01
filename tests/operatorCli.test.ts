import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runOperatorCli, type OperatorCliIO } from "../scripts/operator-cli.js";
import { createTlsFixture } from "./operatorCliTestSupport.js";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const legalId = "lr_11111111-1111-4111-8111-111111111111";
const incidentId = "si_11111111-1111-4111-8111-111111111111";
const tokenPrompt = "Operator OIDC token (hidden): ";

function signedToken(overrides: Readonly<Record<string, unknown>> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: "https://issuer.example.test", aud: "operators", sub: "cli-fixture", iat: now - 1, exp: now + 300, ...overrides })).toString("base64url");
  const content = `${header}.${claims}`;
  return `${content}.${sign("RSA-SHA256", Buffer.from(content), pair.privateKey).toString("base64url")}`;
}

function legalDetails(requestId = legalId, revision = 0, legalHold = false) {
  return { item: { requestId, kind: "complaint", status: "received", receivedAt: "2026-10-01T00:00:00.000Z", responseDueAt: null, answeredAt: null, retentionUntil: null, legalHold, revision, narrative: "fixture context", transactionId: null } };
}

function createIo(options: Readonly<{ token?: string; payload?: string; confirmation?: string; inputIsTTY?: boolean; stdinIsTTY?: boolean }>) {
  let out = "";
  let error = "";
  let hiddenPrompts = 0;
  let linePrompts: string[] = [];
  let linePromptOutput: string[] = [];
  const io: OperatorCliIO = {
    inputIsTTY: options.inputIsTTY ?? true,
    stdinIsTTY: options.stdinIsTTY ?? false,
    writeOut: (text) => { out += text; },
    writeError: (text) => { error += text; },
    readPayload: async (fd) => {
      if (fd !== undefined) assert.equal(fd, 3);
      return options.payload ?? "";
    },
    readHidden: async (prompt) => { hiddenPrompts += 1; assert.equal(prompt, tokenPrompt); return options.token ?? ""; },
    readLine: async (prompt) => { linePrompts = [...linePrompts, prompt]; linePromptOutput = [...linePromptOutput, out]; return options.confirmation ?? ""; },
  };
  return { io, output: () => out + error, hiddenCount: () => hiddenPrompts, linePrompts: () => linePrompts, linePromptOutput: () => linePromptOutput };
}

async function withTrustedTls<T>(caPath: string, callback: () => Promise<T>): Promise<T> {
  const previous = getCACertificates("default");
  const ca = await readFile(caPath, "utf8");
  setDefaultCACertificates([...previous, ca]);
  try { return await callback(); }
  finally { setDefaultCACertificates(previous); }
}

async function configFile(origin: string): Promise<Readonly<{ path: string; cleanup(): Promise<void> }>> {
  const directory = await mkdtemp(join(tmpdir(), "patternly-operator-cli-config-"));
  const path = join(directory, "operator.json");
  await writeFile(path, JSON.stringify({ allowedOrigins: [origin] }));
  return Object.freeze({ path, cleanup: () => rm(directory, { recursive: true, force: true }) });
}

function args(origin: string, config: string, ...command: string[]): string[] {
  return [...command, "--config", config, "--origin", origin];
}

test("list and show use real HTTPS, hidden token input, and canonical response schemas", async () => {
  const token = signedToken();
  const detail = legalDetails();
  const fixture = await createTlsFixture((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/operator/legal-requests") response.end(JSON.stringify({ items: [{ requestId: legalId, kind: "complaint", status: "received", receivedAt: "2026-10-01T00:00:00.000Z", responseDueAt: null, answeredAt: null, retentionUntil: null, legalHold: false, revision: 0 }], truncated: true }));
    else if (request.url === `/v1/operator/legal-requests/${legalId}`) response.end(JSON.stringify(detail));
    else { response.statusCode = 404; response.end(JSON.stringify({ error: { code: "not_found" } })); }
  });
  const config = await configFile(fixture.origin);
  try {
    await withTrustedTls(fixture.caCertificatePath, async () => {
      const listIo = createIo({ token });
      const listCode = await runOperatorCli(args(fixture.origin, config.path, "list", "legal-requests"), listIo.io);
      assert.equal(listCode, 0, listIo.output());
      assert.match(listIo.output(), /truncated/iu);
      assert.match(listIo.output(), /100 items/iu);
      assert.equal(listIo.output().includes(token), false);

      const showIo = createIo({ token });
      const showCode = await runOperatorCli(args(fixture.origin, config.path, "show", "legal-requests", legalId), showIo.io);
      assert.equal(showCode, 0);
      assert.match(showIo.output(), /fixture context/u);
    });
  } finally { await fixture.close(); await config.cleanup(); }
});

test("action validates payload and current CAS state before typed confirmation and one PATCH", async () => {
  const token = signedToken();
  let reads = 0;
  let writes = 0;
  let requestBody = "";
  const fixture = await createTlsFixture((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") { reads += 1; response.end(JSON.stringify(legalDetails())); return; }
    writes += 1;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { requestBody += chunk; });
    request.on("end", () => response.end(JSON.stringify({ item: { requestId: legalId, status: "received", revision: 1 }, action: "set_legal_hold" })));
  });
  const config = await configFile(fixture.origin);
  const phrase = `apply legal-requests set_legal_hold to ${legalId}`;
  const payload = JSON.stringify({ action: "set_legal_hold", expectedRevision: 0, active: true, reason: "legal hold required" });
  try {
    await withTrustedTls(fixture.caCertificatePath, async () => {
      const cli = createIo({ token, payload, confirmation: phrase });
      const code = await runOperatorCli(args(fixture.origin, config.path, "action", "legal-requests", legalId, "--payload-fd", "3"), cli.io);
      assert.equal(code, 0);
      assert.equal(reads, 1);
      assert.equal(writes, 1);
      assert.deepEqual(JSON.parse(requestBody), JSON.parse(payload));
      assert.deepEqual(cli.linePrompts(), [`Type "${phrase}" to confirm: `]);
      assert.equal(cli.output().includes(payload), false);
      assert.match(cli.output(), /proposedEffect.*legalHold.*true/iu);
    });
  } finally { await fixture.close(); await config.cleanup(); }
});

test("inherited insecure TLS configuration is rejected before an HTTPS request", async () => {
  let requests = 0;
  const fixture = await createTlsFixture((_request, response) => { requests += 1; response.end(JSON.stringify({ items: [], truncated: false })); });
  const config = await configFile(fixture.origin);
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const cli = createIo({ token: signedToken() });
    const code = await runOperatorCli(args(fixture.origin, config.path, "list", "legal-requests"), cli.io);
    assert.equal(code, 1);
    assert.match(cli.output(), /insecure_tls_configuration/u);
    assert.equal(requests, 0);
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    await fixture.close();
    await config.cleanup();
  }
});

test("an untrusted TLS certificate is rejected without reaching the handler", async () => {
  let requests = 0;
  const fixture = await createTlsFixture((_request, response) => { requests += 1; response.end(JSON.stringify({ items: [], truncated: false })); });
  const config = await configFile(fixture.origin);
  try {
    const cli = createIo({ token: signedToken() });
    const code = await runOperatorCli(args(fixture.origin, config.path, "list", "legal-requests"), cli.io);
    assert.equal(code, 1);
    assert.match(cli.output(), /request_transport_failed/u);
    assert.equal(requests, 0);
  } finally { await fixture.close(); await config.cleanup(); }
});

test("a redirect is rejected without forwarding credentials to its target", async () => {
  let originRequests = 0;
  let targetRequests = 0;
  const target = await createTlsFixture((request, response) => { targetRequests += 1; response.end(JSON.stringify({ items: [], truncated: false })); });
  const origin = await createTlsFixture((_request, response) => {
    originRequests += 1;
    response.statusCode = 302;
    response.setHeader("location", `${target.origin}/collect`);
    response.end();
  });
  const config = await configFile(origin.origin);
  try {
    await withTrustedTls(origin.caCertificatePath, () => withTrustedTls(target.caCertificatePath, async () => {
      const token = signedToken();
      const cli = createIo({ token });
      const code = await runOperatorCli(args(origin.origin, config.path, "list", "legal-requests"), cli.io);
      assert.equal(code, 1);
      assert.match(cli.output(), /request_transport_failed/u);
      assert.equal(cli.output().includes(token), false);
      assert.equal(originRequests, 1);
      assert.equal(targetRequests, 0);
    }));
  } finally { await origin.close(); await target.close(); await config.cleanup(); }
});

test("expired, overlong, and future-issued tokens fail locally before HTTP", async () => {
  let requests = 0;
  const fixture = await createTlsFixture((_request, response) => { requests += 1; response.end(JSON.stringify({ items: [], truncated: false })); });
  const config = await configFile(fixture.origin);
  try {
    const now = Math.floor(Date.now() / 1000);
    const invalidTokens = [
      signedToken({ iat: now - 600, exp: now - 1 }),
      signedToken({ iat: now - 1, exp: now + 3601 }),
      signedToken({ iat: now + 31, exp: now + 300 }),
    ];
    for (const token of invalidTokens) {
      const cli = createIo({ token });
      const code = await runOperatorCli(args(fixture.origin, config.path, "list", "legal-requests"), cli.io);
      assert.equal(code, 1);
      assert.match(cli.output(), /token_invalid/u);
      assert.equal(cli.output().includes(token), false);
    }
    assert.equal(requests, 0);
  } finally { await fixture.close(); await config.cleanup(); }
});

test("a denied origin fails before token prompt or network", async () => {
  let requests = 0;
  const fixture = await createTlsFixture((_request, response) => { requests += 1; response.end(JSON.stringify({ items: [], truncated: false })); });
  const config = await configFile(fixture.origin);
  try {
    const cli = createIo({ token: signedToken() });
    const code = await runOperatorCli(args("https://denied.example.test", config.path, "list", "legal-requests"), cli.io);
    assert.equal(code, 1);
    assert.match(cli.output(), /origin_not_allowed/u);
    assert.equal(cli.hiddenCount(), 0);
    assert.equal(requests, 0);
  } finally { await fixture.close(); await config.cleanup(); }
});

test("unknown options and schema-invalid payloads fail before token prompt or network", async () => {
  let requests = 0;
  const fixture = await createTlsFixture((_request, response) => { requests += 1; response.end("{}"); });
  const config = await configFile(fixture.origin);
  try {
    const unknownIo = createIo({ token: signedToken(), payload: "{}" });
    const unknown = await runOperatorCli(args(fixture.origin, config.path, "list", "legal-requests", "--unsafe"), unknownIo.io);
    assert.equal(unknown, 1);
    assert.equal(unknownIo.hiddenCount(), 0);

    const invalidIo = createIo({ token: signedToken(), payload: JSON.stringify({ action: "answer", expectedRevision: 0, response: "not allowed" }) });
    const invalid = await runOperatorCli(args(fixture.origin, config.path, "action", "legal-requests", legalId, "--payload-fd", "3"), invalidIo.io);
    assert.equal(invalid, 1);
    assert.equal(invalidIo.hiddenCount(), 0);
    assert.equal(requests, 0);
  } finally { await fixture.close(); await config.cleanup(); }
});

test("piped JSON stdin is accepted when prompts use a separate controlling terminal", async () => {
  const token = signedToken();
  let reads = 0;
  let writes = 0;
  const fixture = await createTlsFixture((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") { reads += 1; response.end(JSON.stringify(legalDetails())); return; }
    writes += 1;
    request.resume();
    response.end(JSON.stringify({ item: { requestId: legalId, status: "closed", revision: 1 }, action: "close" }));
  });
  const config = await configFile(fixture.origin);
  const phrase = `apply legal-requests close to ${legalId}`;
  try {
    await withTrustedTls(fixture.caCertificatePath, async () => {
      const cli = createIo({ token, payload: JSON.stringify({ action: "close", expectedRevision: 0 }), confirmation: phrase, inputIsTTY: true, stdinIsTTY: false });
      const code = await runOperatorCli(args(fixture.origin, config.path, "action", "legal-requests", legalId), cli.io);
      assert.equal(code, 0, cli.output());
      assert.equal(cli.hiddenCount(), 1);
      assert.deepEqual(cli.linePrompts(), [`Type "${phrase}" to confirm: `]);
      assert.equal(reads, 1);
      assert.equal(writes, 1);
    });
  } finally { await fixture.close(); await config.cleanup(); }
});

test("interactive stdin still requires an explicit payload descriptor", async () => {
  let requests = 0;
  const fixture = await createTlsFixture((_request, response) => { requests += 1; response.end("{}"); });
  const config = await configFile(fixture.origin);
  try {
    const cli = createIo({ token: signedToken(), inputIsTTY: true, stdinIsTTY: true, payload: JSON.stringify({ action: "close", expectedRevision: 0 }) });
    const code = await runOperatorCli(args(fixture.origin, config.path, "action", "legal-requests", legalId), cli.io);
    assert.equal(code, 1);
    assert.match(cli.output(), /payload_fd_required_for_interactive_input/u);
    assert.equal(cli.hiddenCount(), 0);
    assert.equal(requests, 0);
  } finally { await fixture.close(); await config.cleanup(); }
});

test("token prompt still rejects when no controlling terminal is available", async () => {
  let requests = 0;
  const fixture = await createTlsFixture((_request, response) => { requests += 1; response.end(JSON.stringify({ items: [], truncated: false })); });
  const config = await configFile(fixture.origin);
  try {
    const cli = createIo({ inputIsTTY: false, stdinIsTTY: false });
    const code = await runOperatorCli(args(fixture.origin, config.path, "list", "legal-requests"), cli.io);
    assert.equal(code, 1);
    assert.match(cli.output(), /token_prompt_requires_tty/u);
    assert.equal(cli.hiddenCount(), 0);
    assert.equal(requests, 0);
  } finally { await fixture.close(); await config.cleanup(); }
});

test("revision mismatch is rejected before confirmation or mutation", async () => {
  let reads = 0;
  let writes = 0;
  const fixture = await createTlsFixture((request, response) => {
    if (request.method === "GET") { reads += 1; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(legalDetails(legalId, 4))); }
    else { writes += 1; response.end("{}"); }
  });
  const config = await configFile(fixture.origin);
  try {
    await withTrustedTls(fixture.caCertificatePath, async () => {
      const cli = createIo({ token: signedToken(), payload: JSON.stringify({ action: "close", expectedRevision: 0 }) });
      const code = await runOperatorCli(args(fixture.origin, config.path, "action", "legal-requests", legalId, "--payload-fd", "3"), cli.io);
      assert.equal(code, 1);
      assert.match(cli.output(), /revision_precondition_conflict/u);
      assert.equal(cli.linePrompts().length, 0);
      assert.equal(reads, 1);
      assert.equal(writes, 0);
    });
  } finally { await fixture.close(); await config.cleanup(); }
});

test("a lost mutation response is ambiguous and triggers one state read without retry", async () => {
  const token = signedToken();
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
    response.end(JSON.stringify(legalDetails(legalId, held ? 1 : 0, held)));
  });
  const config = await configFile(fixture.origin);
  const phrase = `apply legal-requests set_legal_hold to ${legalId}`;
  try {
    await withTrustedTls(fixture.caCertificatePath, async () => {
      const cli = createIo({ token, confirmation: phrase, payload: JSON.stringify({ action: "set_legal_hold", expectedRevision: 0, active: true, reason: "fixture" }) });
      const code = await runOperatorCli(args(fixture.origin, config.path, "action", "legal-requests", legalId, "--payload-fd", "3"), cli.io);
      assert.equal(code, 2);
      assert.match(cli.output(), /AMBIGUOUS.*RECONCILIATION REQUIRED/iu);
      assert.equal(writes, 1);
      assert.equal(reads, 2);
    });
  } finally { await fixture.close(); await config.cleanup(); }
});

test("HTTP 500 and malformed 200 mutation responses reconcile once without leaking bodies", async (context) => {
  for (const failureMode of ["server_error", "malformed_success"] as const) {
    await context.test(`${failureMode} is ambiguous after one mutation`, async () => {
      const token = signedToken();
      const privateMarker = `private-${failureMode}-body-marker`;
      let reads = 0;
      let writes = 0;
      const fixture = await createTlsFixture((request, response) => {
        response.setHeader("content-type", "application/json");
        if (request.method === "GET") {
          reads += 1;
          response.end(JSON.stringify(legalDetails(legalId, reads > 1 ? 1 : 0, reads > 1)));
          return;
        }
        writes += 1;
        request.resume();
        if (failureMode === "server_error") {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: { code: "internal_error" }, detail: privateMarker, token }));
        } else {
          response.statusCode = 200;
          response.end(JSON.stringify({ item: { requestId: legalId, status: "received", revision: 1 }, privateMarker, token }));
        }
      });
      const config = await configFile(fixture.origin);
      const phrase = `apply legal-requests set_legal_hold to ${legalId}`;
      try {
        await withTrustedTls(fixture.caCertificatePath, async () => {
          const cli = createIo({ token, confirmation: phrase, payload: JSON.stringify({ action: "set_legal_hold", expectedRevision: 0, active: true, reason: "private mutation reason" }) });
          const code = await runOperatorCli(args(fixture.origin, config.path, "action", "legal-requests", legalId, "--payload-fd", "3"), cli.io);
          assert.equal(code, 2);
          assert.match(cli.output(), /AMBIGUOUS.*RECONCILIATION REQUIRED/u);
          assert.equal(cli.output().includes(token), false);
          assert.equal(cli.output().includes(privateMarker), false);
          assert.equal(cli.output().includes("private mutation reason"), false);
          assert.equal(writes, 1);
          assert.equal(reads, 2);
        });
      } finally { await fixture.close(); await config.cleanup(); }
    });
  }
});

test("incident create prints and uses one stable ID before confirmation", async () => {
  const token = signedToken();
  const id = "si_22222222-2222-4222-8222-222222222222";
  let writes = 0;
  let requestedUrl = "";
  const fixture = await createTlsFixture((request, response) => {
    writes += 1;
    requestedUrl = request.url ?? "";
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ item: { incidentId: id, classification: "triage", authorityDecision: "undecided", authorityDeliveryStatus: "not_started", subjectDecision: "undecided", subjectNotificationStatus: "not_started", awarenessAt: null, authorityDeadlineAt: null, closedAt: null, revision: 0, legalHold: false, nextAction: "acknowledge_awareness" } }));
  });
  const config = await configFile(fixture.origin);
  const payload = { title: "incident-private-payload-marker", details: "details", detectedAt: "2026-10-01T00:00:00.000Z", categories: "availability", dataSubjectCount: "1", recordCount: "1", specialData: false, confidentialityImpact: "none", integrityImpact: "none", availabilityImpact: "low", consequences: "none", likelihood: "low", severity: "low", containment: "contained", remediation: "done", prevention: "updated", postmortem: "complete" };
  try {
    await withTrustedTls(fixture.caCertificatePath, async () => {
      const phrase = `create incident ${id}`;
      const cli = createIo({ token, payload: JSON.stringify(payload), confirmation: phrase });
      const code = await runOperatorCli(args(fixture.origin, config.path, "create-incident", "--id", id, "--payload-fd", "3"), cli.io);
      assert.equal(code, 0);
      assert.match(cli.output(), new RegExp(id));
      assert.deepEqual(cli.linePrompts(), [`Type "${phrase}" to confirm: `]);
      assert.match(cli.linePromptOutput()[0] ?? "", /create_or_replay_incident.*triage.*not_started/iu);
      assert.match(cli.linePromptOutput()[0] ?? "", /exact-payload replay may return the existing incident in its current state; this does not reset it/iu);
      assert.equal(cli.linePromptOutput()[0]?.includes("incident-private-payload-marker"), false);
      assert.equal(requestedUrl, `/v1/operator/security-incidents/${id}`);
      assert.equal(writes, 1);
    });
  } finally { await fixture.close(); await config.cleanup(); }
});

test("authority export uses its exact read-only route and canonical schema", async () => {
  const token = signedToken();
  let requestUrl = "";
  const fixture = await createTlsFixture((request, response) => {
    requestUrl = request.url ?? "";
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ payload: "fixture-authority-export", digest: "a".repeat(43), version: 3 }));
  });
  const config = await configFile(fixture.origin);
  try {
    await withTrustedTls(fixture.caCertificatePath, async () => {
      const cli = createIo({ token });
      const code = await runOperatorCli(args(fixture.origin, config.path, "authority-export", incidentId, "3"), cli.io);
      assert.equal(code, 0);
      assert.equal(requestUrl, `/v1/operator/security-incidents/${incidentId}/authority-exports/3`);
      assert.match(cli.output(), /fixture-authority-export/u);
      assert.equal(cli.linePrompts().length, 0);
    });
  } finally { await fixture.close(); await config.cleanup(); }
});
