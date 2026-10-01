import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, randomBytes, randomUUID, sign, type JsonWebKey } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import test from "node:test";
import { deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { createFirestoreRuntime } from "../src/infrastructure/firestore/client.js";
import { createFirestoreStores } from "../src/infrastructure/firestore/stores.js";
import { createFirebaseTokenVerifier } from "../src/infrastructure/firebase/verifier.js";
import { createOperatorTokenVerifier } from "../src/infrastructure/operator/oidcVerifier.js";
import { loadEnvironment } from "../src/config/environment.js";
import { buildApplication } from "../src/api/app.js";
import { OPERATOR_ACTIONS } from "../src/modules/operator-access/contracts.js";
import { runOperatorCli, type OperatorCliIO } from "../scripts/operator-cli.js";
import { createTlsFixture } from "./operatorCliTestSupport.js";

const enabled = process.env.OPS_B4_EMULATOR_TESTS === "1";
const PROJECT_ID = "demo-patternly-ops-b4";
const FIRESTORE_HOST = "127.0.0.1:18119";
const AUTH_HOST = "127.0.0.1:19119";
const ISSUER = "https://ops-b4.synthetic.example.test";
const AUDIENCE = "patternly-ops-b4-acceptance";
const APP_CHECK = "ops-b4-synthetic-app-check";
const OPERATOR_SUBJECT = "ops-b4-acceptance-operator";
const READONLY_SUBJECT = "ops-b4-acceptance-readonly";
const REPORT_SECRET = "ops-b4-report-rate-limit-hmac-secret-0123456789";
const AUDIT_SECRET = "ops-b4-privacy-audit-hmac-secret-0123456789";
const PRIVACY_KEY = randomBytes(32);
const PSEUDONYM_KEY = randomBytes(32);
const operatorKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = {
  ...(operatorKeyPair.publicKey.export({ format: "jwk" }) as JsonWebKey),
  kid: "ops-b4-fixture-key", kty: "RSA", use: "sig", alg: "RS256",
};
const operatorActions = [...OPERATOR_ACTIONS];
const readonlyActions = ["content_reports:read", "privacy_requests:read", "legal_requests:read", "security_incidents:read"] as const;

function expectedOperatorActor(subject: string): string {
  return createHmac("sha256", AUDIT_SECRET).update(`operator:${ISSUER}\0${subject}`, "utf8").digest("base64url");
}

function alphabeticMarker(value: string): string {
  return value.replaceAll("-", "").replace(/[0-9]/gu, (digit) => String.fromCharCode(103 + Number(digit)));
}

function buildOperatorToken(subject: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "ops-b4-fixture-key", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: subject, iat: now - 1, exp: now + 300 })).toString("base64url");
  const content = `${header}.${claims}`;
  return `${content}.${sign("RSA-SHA256", Buffer.from(content, "ascii"), operatorKeyPair.privateKey).toString("base64url")}`;
}

function createAcceptanceIo(options: Readonly<{ token: string; payload?: string; confirmation?: string }>): Readonly<{ io: OperatorCliIO; output(): string; prompts(): readonly string[] }> {
  let out = "";
  let error = "";
  const prompts: string[] = [];
  return Object.freeze({
    io: Object.freeze({
      inputIsTTY: true,
      stdinIsTTY: false,
      writeOut: (value: string) => { out += value; },
      writeError: (value: string) => { error += value; },
      readPayload: async (fd?: number) => { if (fd !== undefined) assert.equal(fd, 3); return options.payload ?? ""; },
      readHidden: async (prompt: string) => { assert.equal(prompt, "Operator OIDC token (hidden): "); return options.token; },
      readLine: async (prompt: string) => { prompts.push(prompt); return options.confirmation ?? ""; },
    }),
    output: () => out + error,
    prompts: () => prompts,
  });
}

function countRequests(requests: readonly Readonly<{ method: string; path: string }>[], method: string, path: string): number {
  return requests.filter((request) => request.method === method && request.path === path).length;
}

async function withTrustedCertificate<T>(certificate: string, callback: () => Promise<T>): Promise<T> {
  const previous = getCACertificates("default");
  setDefaultCACertificates([...previous, certificate]);
  try { return await callback(); }
  finally { setDefaultCACertificates(previous); }
}

async function readAudit(db: FirebaseFirestore.Firestore, collection: string, id: string): Promise<readonly Record<string, unknown>[]> {
  const snapshot = await db.collection(collection).doc(id).collection("audit").get();
  return snapshot.docs.map((document) => document.data());
}

test("OPS-B4 synthetic acceptance drives public intake, audited operator actions, and replay safety over HTTPS", { skip: enabled ? false : "run only through npm run test:operator:acceptance" }, async () => {
  assert.equal(process.env.FIREBASE_PROJECT_ID, PROJECT_ID, "acceptance requires its dedicated demo project");
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, FIRESTORE_HOST, "acceptance requires the isolated Firestore loopback port");
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, AUTH_HOST, "acceptance requires the isolated Auth loopback port");

  const environment = loadEnvironment({
    NODE_ENV: "test", HOST: "127.0.0.1", PORT: "8080", LOG_LEVEL: "silent",
    FIREBASE_PROJECT_ID: PROJECT_ID, FIREBASE_AUTH_EMULATOR_HOST: AUTH_HOST, FIRESTORE_EMULATOR_HOST: FIRESTORE_HOST,
    REPORT_RATE_LIMIT_HASH_SECRET: REPORT_SECRET,
    DELETION_PSEUDONYM_KEYS_JSON: JSON.stringify([{ version: "acceptance", status: "active", keyBase64: PSEUDONYM_KEY.toString("base64") }]),
    PRIVACY_RESPONSE_KEY_BASE64: PRIVACY_KEY.toString("base64"),
    PRIVACY_AUDIT_HMAC_SECRET: AUDIT_SECRET,
    OPERATOR_OIDC_ISSUER: ISSUER,
    OPERATOR_OIDC_AUDIENCE: AUDIENCE,
    OPERATOR_OIDC_JWKS_URL: "https://ops-b4.synthetic.example.test/jwks",
    OPERATOR_ALLOWLIST_JSON: JSON.stringify([
      { subject: OPERATOR_SUBJECT, role: "operator", actions: operatorActions },
      { subject: READONLY_SUBJECT, role: "operator", actions: readonlyActions },
    ]),
  });

  const runtime = createFirestoreRuntime(environment);
  const stores = createFirestoreStores(runtime, environment);
  const mail = { privacy: [] as Array<Readonly<{ recipient: string; requestId: string; code: string }>>, legal: [] as Array<Readonly<{ recipient: string; requestId: string }>> };
  const operatorTokenVerifier = createOperatorTokenVerifier(environment, {
    fetch: async (input, init) => {
      assert.equal(String(input), environment.operatorAccess?.jwksUrl);
      assert.equal(init?.redirect, "manual");
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { "cache-control": "max-age=300" } });
    },
  });
  assert.ok(operatorTokenVerifier);
  const app = buildApplication({
    environment,
    firestore: runtime,
    verifier: createFirebaseTokenVerifier(environment),
    appCheckVerifier: { verify: async (token) => { if (token !== APP_CHECK) throw new Error("app_check_invalid"); } },
    operatorTokenVerifier,
    stores,
    privacyRequestEmailSender: { send: async ({ recipient, requestId, code }) => { mail.privacy.push(Object.freeze({ recipient, requestId, code })); } },
    legalRequestEmailSender: { send: async ({ recipient, requestId }) => { mail.legal.push(Object.freeze({ recipient, requestId })); } },
  });

  let appUrl: string | undefined;
  let tls: Awaited<ReturnType<typeof createTlsFixture>> | undefined;
  const seenRequests: Array<Readonly<{ method: string; path: string }>> = [];
  let dropNextResponse: string | null = null;
  let temporaryConfig: string | undefined;
  let configDirectory: string | undefined;
  const mainToken = buildOperatorToken(OPERATOR_SUBJECT);
  const readOnlyToken = buildOperatorToken(READONLY_SUBJECT);

  try {
    appUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    const upstreamPort = Number(new URL(appUrl).port);
    tls = await createTlsFixture((incoming: IncomingMessage, outgoing: ServerResponse) => {
      const method = incoming.method ?? "GET";
      const path = incoming.url ?? "/";
      seenRequests.push(Object.freeze({ method, path }));
      const upstream = httpRequest({
        hostname: "127.0.0.1", port: upstreamPort, method, path,
        headers: { ...incoming.headers, host: `127.0.0.1:${upstreamPort}` },
      }, (upstreamResponse) => {
        const shouldDrop = dropNextResponse === `${method} ${path}`;
        if (shouldDrop) {
          dropNextResponse = null;
          upstreamResponse.resume();
          upstreamResponse.once("end", () => outgoing.socket?.destroy());
          return;
        }
        outgoing.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(outgoing);
      });
      upstream.once("error", () => { if (!outgoing.headersSent) { outgoing.statusCode = 502; outgoing.end(); } });
      incoming.pipe(upstream);
    });

    const appCheckHeaders = { "x-firebase-appcheck": APP_CHECK };
    const requestJson = async (path: string, method = "GET", body?: unknown, token?: string) => {
      const response = await fetch(`${tls!.origin}${path}`, {
        method, redirect: "error",
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...appCheckHeaders,
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let json: unknown;
      try { json = JSON.parse(text) as unknown; } catch { json = null; }
      return Object.freeze({ response, json, text });
    };
    const invokeCli = async (args: readonly string[], options: Readonly<{ payload?: unknown; confirmation?: string; token?: string }> = {}) => {
      const io = createAcceptanceIo({
        token: options.token ?? mainToken,
        ...(options.payload === undefined ? {} : { payload: JSON.stringify(options.payload) }),
        ...(options.confirmation === undefined ? {} : { confirmation: options.confirmation }),
      });
      const code = await runOperatorCli([
        ...args,
        ...(options.payload === undefined ? [] : ["--payload-fd", "3"]),
        "--config", temporaryConfig!, "--origin", tls!.origin,
      ], io.io);
      return Object.freeze({ code, output: io.output(), prompts: io.prompts() });
    };

    configDirectory = await mkdtemp(join(tmpdir(), "patternly-ops-b4-cli-"));
    temporaryConfig = join(configDirectory, "operator.json");
    await writeFile(temporaryConfig, JSON.stringify({ allowedOrigins: [tls.origin] }));

    await withTrustedCertificate(tls.caCertificate, async () => {
      // Confirm both Admin SDK emulator connections and the real HTTP/TLS route before any intake write.
      const [firestoreCollections, authUsers] = await Promise.all([runtime.db.listCollections(), getAuth(runtime.app).listUsers(1)]);
      assert.ok(Array.isArray(firestoreCollections));
      assert.ok(Array.isArray(authUsers.users));
      const [health, ready] = await Promise.all([fetch(`${tls!.origin}/health`), fetch(`${tls!.origin}/ready`)]);
      assert.equal(health.status, 200);
      assert.equal(ready.status, 200);
      const readyBody = await ready.json() as { status: string; checks: { database: boolean; authentication: boolean } };
      assert.equal(readyBody.status, "ready");
      assert.equal(readyBody.checks.database, true);
      assert.equal(readyBody.checks.authentication, true);

      const namespace = randomUUID();
      const textMarker = alphabeticMarker(namespace);
      const privateSubject = `ops-b4-subject-${textMarker}`;
      const privacyEmail = `ops-b4-privacy-${namespace}@example.test`;
      const legalEmail = `ops-b4-legal-${namespace}@example.test`;
      const privateContentDescription = `ops-b4-private-content-${textMarker}`;
      const privatePrivacyNarrative = `ops-b4-private-privacy-${textMarker}`;
      const privateLegalNarrative = `ops-b4-private-legal-${textMarker}`;
      const contentId = randomUUID();

      const contentCreate = await requestJson("/v1/content/reports", "POST", {
        clientSubmissionId: contentId,
        trackId: "coding-interview", contentVersion: "v1", itemId: "question-ops-b4",
        reason: "incorrect_answer", description: privateContentDescription,
        context: { releasePackageId: "ops-b4", trackNode: null, modeRoute: "answer_review", locale: "en", appBuild: "ops-b4", platform: "ios", occurredAt: new Date().toISOString() },
        linkAccount: false,
      });
      assert.equal(contentCreate.response.status, 201, contentCreate.text);
      assert.equal((contentCreate.json as { report: { status: string } }).report.status, "open");

      const privacyCreate = await requestJson("/v1/guest/privacy-requests", "POST", {
        clientRequestId: randomUUID(), email: privacyEmail, right: "access", narrative: privatePrivacyNarrative, reportSubmissionIds: [contentId],
      });
      assert.equal(privacyCreate.response.status, 202, privacyCreate.text);
      const privacyRequestId = (privacyCreate.json as { requestId: string }).requestId;
      const emailCode = mail.privacy.find((message) => message.requestId === privacyRequestId)?.code;
      assert.equal(typeof emailCode, "string");
      const verified = await requestJson("/v1/guest/privacy-requests/verify", "POST", { code: emailCode });
      assert.equal(verified.response.status, 200, verified.text);

      const legalCreate = await requestJson("/v1/public/legal-requests", "POST", {
        email: legalEmail, kind: "complaint", narrative: privateLegalNarrative, transactionId: `ops-b4-transaction-${textMarker}`,
      });
      assert.equal(legalCreate.response.status, 201, legalCreate.text);
      const legalRequestId = (legalCreate.json as { request: { requestId: string } }).request.requestId;
      assert.ok(mail.legal.some((message) => message.requestId === legalRequestId && message.recipient === legalEmail));

      const incidentId = `si_${randomUUID()}`;
      const incidentPayload = {
        title: `ops-b4-incident-title-${textMarker}`, details: `ops-b4-incident-details-${textMarker}`,
        detectedAt: new Date().toISOString(), categories: "availability", dataSubjectCount: "1", recordCount: "1", specialData: false,
        confidentialityImpact: "none", integrityImpact: "none", availabilityImpact: "minor", consequences: "synthetic acceptance fixture",
        likelihood: "low", severity: "low", containment: "contained", remediation: "complete", prevention: "complete", postmortem: "complete",
      };
      const createPhrase = `create incident ${incidentId}`;
      const incidentCreate = await invokeCli(["create-incident", "--id", incidentId], { payload: incidentPayload, confirmation: createPhrase });
      assert.equal(incidentCreate.code, 0, incidentCreate.output);
      assert.match(incidentCreate.output, new RegExp(incidentId));

      const contentReportRef = runtime.db.collection("contentReports").doc(contentId);
      const privacyRequestRef = runtime.db.collection("privacyRequests").doc(privacyRequestId);
      const legalRequestRef = runtime.db.collection("legalRequests").doc(legalRequestId);
      const incidentRef = runtime.db.collection("securityIncidents").doc(incidentId);
      const operatorActor = expectedOperatorActor(OPERATOR_SUBJECT);
      const expectedAuditActor = {
        content: createHmac("sha256", REPORT_SECRET).update(`content-report-actor\0${operatorActor}`, "utf8").digest("base64url"),
        privacy: createHmac("sha256", AUDIT_SECRET).update(`actor:${operatorActor}`, "utf8").digest("hex"),
        legal: createHmac("sha256", AUDIT_SECRET).update(`legal-request-actor\0${operatorActor}`, "utf8").digest("base64url"),
        security: createHmac("sha256", AUDIT_SECRET).update(operatorActor, "utf8").digest("base64url"),
      };

      const denied = await requestJson(`/v1/operator/content-reports/${contentId}`, "PATCH", { expectedStatus: "open", status: "in_review" }, readOnlyToken);
      assert.equal(denied.response.status, 401);
      assert.equal((await contentReportRef.get()).get("status"), "open");
      assert.equal((await readAudit(runtime.db, "contentReports", contentId)).length, 0);
      const staleBefore = await readAudit(runtime.db, "contentReports", contentId);
      const stale = await requestJson(`/v1/operator/content-reports/${contentId}`, "PATCH", { expectedStatus: "in_review", status: "resolved" }, mainToken);
      assert.equal(stale.response.status, 409);
      assert.equal((await contentReportRef.get()).get("status"), "open");
      assert.equal((await readAudit(runtime.db, "contentReports", contentId)).length, staleBefore.length);
      const deniedPrivacy = await requestJson(`/v1/operator/privacy-requests/${privacyRequestId}`, "PATCH", { action: "start_review", expectedRevision: 1 }, readOnlyToken);
      assert.equal(deniedPrivacy.response.status, 401);
      const deniedPrivacyAudit = await readAudit(runtime.db, "privacyRequests", privacyRequestId);
      assert.equal((await privacyRequestRef.get()).get("revision"), 1);
      assert.equal(deniedPrivacyAudit.filter((entry) => entry.event === "start_review").length, 0);
      const stalePrivacy = await requestJson(`/v1/operator/privacy-requests/${privacyRequestId}`, "PATCH", { action: "verify_subject", expectedRevision: 0, reason: "Synthetic stale revision probe" }, mainToken);
      assert.equal(stalePrivacy.response.status, 409);
      assert.equal((await privacyRequestRef.get()).get("revision"), 1);
      assert.equal((await readAudit(runtime.db, "privacyRequests", privacyRequestId)).length, deniedPrivacyAudit.length);
      const deniedLegal = await requestJson(`/v1/operator/legal-requests/${legalRequestId}`, "PATCH", { action: "start_review", expectedRevision: 0 }, readOnlyToken);
      assert.equal(deniedLegal.response.status, 401);
      assert.equal((await legalRequestRef.get()).get("status"), "received");
      assert.equal((await readAudit(runtime.db, "legalRequests", legalRequestId)).length, 0);
      const staleLegal = await requestJson(`/v1/operator/legal-requests/${legalRequestId}`, "PATCH", { action: "start_review", expectedRevision: 1 }, mainToken);
      assert.equal(staleLegal.response.status, 409);
      assert.equal((await legalRequestRef.get()).get("status"), "received");
      assert.equal((await legalRequestRef.get()).get("revision"), 0);
      assert.equal((await readAudit(runtime.db, "legalRequests", legalRequestId)).length, 0);
      const deniedIncident = await requestJson(`/v1/operator/security-incidents/${incidentId}`, "PATCH", { action: "acknowledge_awareness", expectedRevision: 0 }, readOnlyToken);
      assert.equal(deniedIncident.response.status, 401);
      assert.equal((await incidentRef.get()).get("revision"), 0);
      assert.equal((await readAudit(runtime.db, "securityIncidents", incidentId)).filter((entry) => entry.event === "acknowledge_awareness").length, 0);
      const staleIncidentAuditCount = (await readAudit(runtime.db, "securityIncidents", incidentId)).length;
      const staleIncident = await requestJson(`/v1/operator/security-incidents/${incidentId}`, "PATCH", { action: "acknowledge_awareness", expectedRevision: 1 }, mainToken);
      assert.equal(staleIncident.response.status, 409);
      assert.equal((await incidentRef.get()).get("revision"), 0);
      assert.equal((await readAudit(runtime.db, "securityIncidents", incidentId)).length, staleIncidentAuditCount);

      const contentList = await invokeCli(["list", "content-reports"]);
      assert.equal(contentList.code, 0, contentList.output);
      assert.match(contentList.output, new RegExp(contentId));
      assert.equal(contentList.output.includes(privateContentDescription), false);
      const contentShow = await invokeCli(["show", "content-reports", contentId]);
      assert.equal(contentShow.code, 0, contentShow.output);
      assert.match(contentShow.output, new RegExp(privateContentDescription));
      const contentPath = `/v1/operator/content-reports/${contentId}`;
      const contentActionStartGet = countRequests(seenRequests, "GET", contentPath);
      const contentActionStartPatch = countRequests(seenRequests, "PATCH", contentPath);
      dropNextResponse = `PATCH ${contentPath}`;
      const contentAction = await invokeCli(["action", "content-reports", contentId], {
        payload: { expectedStatus: "open", status: "in_review" },
        confirmation: `apply content-reports transition to ${contentId}`,
      });
      assert.equal(contentAction.code, 2, contentAction.output);
      assert.match(contentAction.output, /AMBIGUOUS.*RECONCILIATION REQUIRED/iu);
      assert.equal(contentAction.output.includes(mainToken), false);
      assert.equal(countRequests(seenRequests, "PATCH", contentPath) - contentActionStartPatch, 1);
      assert.equal(countRequests(seenRequests, "GET", contentPath) - contentActionStartGet, 2, "content lost response has one precondition read and one reconciliation read");
      assert.equal((await contentReportRef.get()).get("status"), "in_review");
      assert.equal((await readAudit(runtime.db, "contentReports", contentId)).filter((entry) => entry.toStatus === "in_review").length, 1);

      const privacyList = await invokeCli(["list", "privacy-requests"]);
      assert.equal(privacyList.code, 0, privacyList.output);
      assert.match(privacyList.output, new RegExp(privacyRequestId));
      assert.equal(privacyList.output.includes(privacyEmail), false);
      const privacyShow = await invokeCli(["show", "privacy-requests", privacyRequestId]);
      assert.equal(privacyShow.code, 0, privacyShow.output);
      assert.match(privacyShow.output, new RegExp(privatePrivacyNarrative));
      assert.equal(privacyShow.output.includes(privacyEmail), false);
      const privacyVerifySubject = await invokeCli(["action", "privacy-requests", privacyRequestId], {
        payload: { action: "verify_subject", expectedRevision: 1, reason: "Synthetic email possession verification completed" },
        confirmation: `apply privacy-requests verify_subject to ${privacyRequestId}`,
      });
      assert.equal(privacyVerifySubject.code, 0, privacyVerifySubject.output);
      assert.equal((await privacyRequestRef.get()).get("revision"), 2);
      const privacyPath = `/v1/operator/privacy-requests/${privacyRequestId}`;
      const privacyActionStartGet = countRequests(seenRequests, "GET", privacyPath);
      const privacyActionStartPatch = countRequests(seenRequests, "PATCH", privacyPath);
      dropNextResponse = `PATCH ${privacyPath}`;
      const privacyAction = await invokeCli(["action", "privacy-requests", privacyRequestId], {
        payload: { action: "start_review", expectedRevision: 2 },
        confirmation: `apply privacy-requests start_review to ${privacyRequestId}`,
      });
      assert.equal(privacyAction.code, 2, privacyAction.output);
      assert.match(privacyAction.output, /AMBIGUOUS.*RECONCILIATION REQUIRED/iu);
      assert.equal(privacyAction.output.includes(mainToken), false);
      assert.equal(privacyAction.output.includes(privacyEmail), false);
      assert.equal(countRequests(seenRequests, "PATCH", privacyPath) - privacyActionStartPatch, 1);
      assert.equal(countRequests(seenRequests, "GET", privacyPath) - privacyActionStartGet, 2, "privacy lost response has one precondition read and one reconciliation read");
      assert.equal((await privacyRequestRef.get()).get("status"), "in_review");
      assert.equal((await privacyRequestRef.get()).get("revision"), 3);
      assert.equal((await readAudit(runtime.db, "privacyRequests", privacyRequestId)).filter((entry) => entry.event === "start_review").length, 1);

      const legalList = await invokeCli(["list", "legal-requests"]);
      assert.equal(legalList.code, 0, legalList.output);
      assert.match(legalList.output, new RegExp(legalRequestId));
      assert.equal(legalList.output.includes(legalEmail), false);
      const legalShow = await invokeCli(["show", "legal-requests", legalRequestId]);
      assert.equal(legalShow.code, 0, legalShow.output);
      assert.match(legalShow.output, new RegExp(privateLegalNarrative));
      assert.equal(legalShow.output.includes(legalEmail), false);
      const legalPath = `/v1/operator/legal-requests/${legalRequestId}`;
      const priorGetCount = countRequests(seenRequests, "GET", legalPath);
      const priorPatchCount = countRequests(seenRequests, "PATCH", legalPath);
      dropNextResponse = `PATCH ${legalPath}`;
      const legalAction = await invokeCli(["action", "legal-requests", legalRequestId], {
        payload: { action: "start_review", expectedRevision: 0 },
        confirmation: `apply legal-requests start_review to ${legalRequestId}`,
      });
      assert.equal(legalAction.code, 2, legalAction.output);
      assert.match(legalAction.output, /AMBIGUOUS.*RECONCILIATION REQUIRED/iu);
      assert.equal(legalAction.output.includes(legalEmail), false);
      assert.equal(legalAction.output.includes(mainToken), false);
      assert.equal(countRequests(seenRequests, "PATCH", legalPath) - priorPatchCount, 1);
      assert.equal(countRequests(seenRequests, "GET", legalPath) - priorGetCount, 2, "one precondition read and one reconciliation read");
      assert.equal((await legalRequestRef.get()).get("status"), "in_review");
      assert.equal((await legalRequestRef.get()).get("revision"), 1);
      assert.equal((await readAudit(runtime.db, "legalRequests", legalRequestId)).filter((entry) => entry.action === "start_review").length, 1);

      const incidentList = await invokeCli(["list", "security-incidents"]);
      assert.equal(incidentList.code, 0, incidentList.output);
      assert.match(incidentList.output, new RegExp(incidentId));
      const incidentShow = await invokeCli(["show", "security-incidents", incidentId]);
      assert.equal(incidentShow.code, 0, incidentShow.output);
      assert.match(incidentShow.output, /ops-b4-incident-title-/u);
      assert.equal(incidentShow.output.includes("snapshot"), false);
      assert.equal(incidentShow.output.includes("ciphertext"), false);
      const incidentPath = `/v1/operator/security-incidents/${incidentId}`;
      const incidentActionStartGet = countRequests(seenRequests, "GET", incidentPath);
      const incidentActionStartPatch = countRequests(seenRequests, "PATCH", incidentPath);
      dropNextResponse = `PATCH ${incidentPath}`;
      const incidentAction = await invokeCli(["action", "security-incidents", incidentId], {
        payload: { action: "acknowledge_awareness", expectedRevision: 0 },
        confirmation: `apply security-incidents acknowledge_awareness to ${incidentId}`,
      });
      assert.equal(incidentAction.code, 2, incidentAction.output);
      assert.match(incidentAction.output, /AMBIGUOUS.*RECONCILIATION REQUIRED/iu);
      assert.equal(incidentAction.output.includes(mainToken), false);
      assert.equal(countRequests(seenRequests, "PATCH", incidentPath) - incidentActionStartPatch, 1);
      assert.equal(countRequests(seenRequests, "GET", incidentPath) - incidentActionStartGet, 2, "security lost response has one precondition read and one reconciliation read");
      assert.equal((await incidentRef.get()).get("revision"), 1);
      assert.ok((await incidentRef.get()).get("awarenessAt"));
      assert.equal((await readAudit(runtime.db, "securityIncidents", incidentId)).filter((entry) => entry.event === "acknowledge_awareness").length, 1);

      const exactReplay = await requestJson(`/v1/operator/security-incidents/${incidentId}`, "PUT", incidentPayload, mainToken);
      assert.equal(exactReplay.response.status, 200, exactReplay.text);
      assert.equal((exactReplay.json as { item: { revision: number } }).item.revision, 1, "exact replay returns current state without resetting it");
      const changedReplay = await requestJson(`/v1/operator/security-incidents/${incidentId}`, "PUT", { ...incidentPayload, title: "changed-payload" }, mainToken);
      assert.equal(changedReplay.response.status, 409);
      assert.equal((await incidentRef.get()).get("revision"), 1);
      assert.equal((await readAudit(runtime.db, "securityIncidents", incidentId)).filter((entry) => entry.event === "incident_created").length, 1);

      const privacySecret = (await runtime.db.collection("privacyRequestSecrets").doc(privacyRequestId).get()).data();
      const incidentSecret = (await runtime.db.collection("securityIncidentSecrets").doc(incidentId).get()).data();
      const completeOutput = [contentList.output, contentShow.output, contentAction.output, privacyList.output, privacyShow.output, privacyVerifySubject.output, privacyAction.output, legalList.output, legalShow.output, legalAction.output, incidentList.output, incidentShow.output, incidentAction.output].join("\n");
      const contentAudits = await readAudit(runtime.db, "contentReports", contentId);
      const privacyAudits = await readAudit(runtime.db, "privacyRequests", privacyRequestId);
      const legalAudits = await readAudit(runtime.db, "legalRequests", legalRequestId);
      const securityAudits = await readAudit(runtime.db, "securityIncidents", incidentId);
      const allAudits = [
        ...contentAudits,
        ...privacyAudits,
        ...legalAudits,
        ...securityAudits,
      ];
      const serializedAudits = JSON.stringify(allAudits);
      const queueOutput = [contentList.output, privacyList.output, legalList.output, incidentList.output].join("\n");
      for (const secret of [privacyEmail, legalEmail, privateSubject]) {
        assert.equal(completeOutput.includes(secret), false, "operator projection leaked a private identity");
      }
      for (const token of [mainToken, readOnlyToken]) {
        assert.equal(completeOutput.includes(token), false, "CLI output leaked a bearer token");
        assert.equal(queueOutput.includes(token), false, "queue output leaked a bearer token");
        assert.equal(serializedAudits.includes(token), false, "audit record leaked a bearer token");
      }
      for (const privateValue of [privacyEmail, legalEmail, privateSubject, privateContentDescription, privatePrivacyNarrative, privateLegalNarrative, incidentPayload.title, incidentPayload.details]) assert.equal(serializedAudits.includes(privateValue), false, "audit record leaked a private value");
      for (const privateValue of [privacyEmail, legalEmail, privateSubject, privateContentDescription, privatePrivacyNarrative, privateLegalNarrative]) assert.equal(queueOutput.includes(privateValue), false, "queue projection leaked a private value");
      assert.equal(completeOutput.includes(JSON.stringify(privacySecret)), false, "privacy encrypted secret document reached the CLI");
      assert.equal(completeOutput.includes(JSON.stringify(incidentSecret)), false, "incident encrypted secret document reached the CLI");
      assert.ok(allAudits.every((entry) => typeof entry.actorPseudonym === "string" && entry.actorPseudonym !== OPERATOR_SUBJECT && entry.actorPseudonym !== privacyEmail && entry.actorPseudonym !== legalEmail), "audits do not store raw operator or subject identity");
      assert.ok(contentAudits.length > 0 && contentAudits.every((entry) => entry.actorPseudonym === expectedAuditActor.content), "content operator audit uses its exact domain-separated actor HMAC");
      const privacyOperatorAudits = privacyAudits.filter((entry) => ["operator_queue_read", "operator_details_read", "state_transition"].includes(String(entry.reasonCode)));
      assert.ok(privacyOperatorAudits.length > 0 && privacyOperatorAudits.every((entry) => entry.actorPseudonym === expectedAuditActor.privacy), "privacy operator audit uses its exact actor HMAC");
      assert.ok(legalAudits.length > 0 && legalAudits.every((entry) => entry.actorPseudonym === expectedAuditActor.legal), "legal operator audit uses its exact domain-separated actor HMAC");
      assert.ok(securityAudits.length > 0 && securityAudits.every((entry) => entry.actorPseudonym === expectedAuditActor.security), "security operator audit uses its exact actor HMAC");
      assert.equal(mail.privacy.length, 1);
      assert.equal(mail.legal.length, 1);
    });
  } finally {
    if (tls) await tls.close();
    await app.close();
    await runtime.close();
    await deleteApp(runtime.app);
    if (configDirectory) await rm(configDirectory, { recursive: true, force: true });
  }
});
