import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { buildApplication } from "../src/api/app.js";
import { loadEnvironment } from "../src/config/environment.js";
import { createOperatorTokenVerifier } from "../src/infrastructure/operator/oidcVerifier.js";
import type { BackendStores } from "../src/infrastructure/firestore/stores.js";

const issuer = "https://operator-routes.example.test";
const audience = "patternly-operator-routes";
const subject = "operator-routes-private-subject";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "k1", kty: "RSA", use: "sig", alg: "RS256" };
const actions = ["content_reports:read", "content_reports:transition", "privacy_requests:read", "privacy_requests:action", "legal_requests:read", "legal_requests:action", "security_incidents:create", "security_incidents:read", "security_incidents:action"];

function makeDependencies(stores: unknown, allow = actions, configure = true) {
  const environment = loadEnvironment({
    NODE_ENV: "test", HOST: "127.0.0.1", PORT: "8080", LOG_LEVEL: "silent",
    REPORT_RATE_LIMIT_HASH_SECRET: "operator-routes-rate-limit-secret-0123456789",
    DELETION_PSEUDONYM_KEYS_JSON: "[]",
    PRIVACY_RESPONSE_KEY_BASE64: "operator-routes-privacy-key",
    PRIVACY_AUDIT_HMAC_SECRET: "operator-routes-privacy-audit-secret-0123456789",
    OPERATOR_OIDC_ISSUER: issuer,
    OPERATOR_OIDC_AUDIENCE: audience,
    OPERATOR_OIDC_JWKS_URL: "https://operator-routes.example.test/jwks",
    OPERATOR_ALLOWLIST_JSON: JSON.stringify([{ subject, role: "privacy_operator", actions: allow }]),
  });
  return {
    environment, firestore: null, verifier: null, appCheckVerifier: null, stores: stores as BackendStores,
    legalRequestEmailSender: { send: async () => { throw new Error("unexpected_operator_email_send"); } },
    operatorTokenVerifier: configure ? createOperatorTokenVerifier(environment, {
      fetch: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "cache-control": "max-age=300" } }),
    }) : null,
  };
}

function makeToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, sub: subject, iat: now - 1, exp: now + 300 })).toString("base64url");
  const content = header + "." + claims;
  return content + "." + sign("RSA-SHA256", Buffer.from(content, "ascii"), pair.privateKey).toString("base64url");
}

const auth = { authorization: "Bearer " + makeToken() };
const reportId = "11111111-1111-4111-8111-111111111111";
const privacyId = "pr_11111111-1111-4111-8111-111111111111";
const legalId = "lr_11111111-1111-4111-8111-111111111111";
const incidentId = "si_11111111-1111-4111-8111-111111111111";
const contentItem = { clientSubmissionId: reportId, trackId: "certification", contentVersion: "v1", itemId: "item-1", reason: "incorrect_answer", status: "open", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } as const;
const incidentItem = { incidentId, classification: "triage", authorityDecision: "undecided", authorityDeliveryStatus: "not_started", subjectDecision: "undecided", subjectNotificationStatus: "not_started", awarenessAt: null, authorityDeadlineAt: null, closedAt: null, revision: 0, legalHold: false, nextAction: "acknowledge_awareness" };

test("operator routes use the production verifier for exact-scope authorization before stores", async () => {
  let calls = 0;
  const app = buildApplication(makeDependencies({ contentReports: { listOperatorQueue: async (actorId: string) => { calls += 1; assert.match(actorId, /^[A-Za-z0-9_-]{40,}$/u); assert.notEqual(actorId, subject); return { items: [contentItem], truncated: false }; } } }, ["content_reports:read"]));
  try {
    const allowed = await app.inject({ method: "GET", url: "/v1/operator/content-reports", headers: auth });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.json(), { items: [contentItem], truncated: false });
    assert.equal(allowed.headers["cache-control"], "private, no-store");
    const denied = await app.inject({ method: "PATCH", url: "/v1/operator/content-reports/" + reportId, headers: auth, payload: { expectedStatus: "open", status: "in_review" } });
    assert.equal(denied.statusCode, 401);
    assert.deepEqual(denied.json(), { error: { code: "operator_token_invalid" } });
    assert.equal(denied.headers["cache-control"], "private, no-store");
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

test("unconfigured operator access is explicit and no-store", async () => {
  const app = buildApplication(makeDependencies({}, actions, false));
  try {
    const response = await app.inject({ method: "GET", url: "/v1/operator/privacy-requests" });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: { code: "operator_unavailable" } });
    assert.equal(response.headers["cache-control"], "private, no-store");
  } finally { await app.close(); }
});

test("operator queue and mutation projections stay minimal while audited details expose only allowlisted context", async () => {
  const actorIds: string[] = [];
  const stores = {
    contentReports: { listOperatorQueue: async (actor: string) => { actorIds.push(actor); return { items: [contentItem], truncated: true }; }, readOperator: async (_id: string, actor: string) => { actorIds.push(actor); return { ...contentItem, description: "allowed report detail", context: { releasePackageId: "release-1", trackNode: "node-1", modeRoute: "answer_review", locale: "en", appBuild: "1.2.3", platform: "ios", occurredAt: "2026-01-01T00:00:00.000Z", email: "private@example.test" }, linkage: "unlinked", id: "forbidden-id", accountId: "forbidden-account", contactEmail: "private@example.test" }; } },
    privacyRequests: {
      listOperatorQueue: async (actor: string) => { actorIds.push(actor); return { items: [{ requestId: privacyId, right: "access", channel: "account", status: "in_review", outcome: null, receivedAt: "2026-01-01T00:00:00.000Z", deadlineAt: "2026-02-01T00:00:00.000Z", deliveredAt: null, extendedAt: null, revision: 2 }], truncated: false }; },
      readAdmin: async (_id: string, actor: string) => { actorIds.push(actor); return { requestId: privacyId, right: "access", channel: "account", status: "in_review", outcome: null, receivedAt: "2026-01-01T00:00:00.000Z", deadlineAt: "2026-02-01T00:00:00.000Z", deliveredAt: null, extendedAt: null, revision: 2, narrative: "allowed privacy narrative", reportSubmissionIds: [reportId], reason: "allowed privacy reason", executionEvidence: "account_export", responseAvailableUntil: "2026-03-01T00:00:00.000Z", subjectVerified: true, extensionNoticeStatus: "available_in_app", email: "private@example.test", response: "forbidden response", sessionToken: "forbidden-token", cipher: "forbidden-cipher" }; },
    },
    legalRequests: {
      listOperatorQueue: async (actor: string) => { actorIds.push(actor); return { items: [{ requestId: legalId, kind: "complaint", status: "received", receivedAt: "2026-01-01T00:00:00.000Z", responseDueAt: null, answeredAt: null, retentionUntil: null, legalHold: false, revision: 0 }], truncated: true }; },
      readAdmin: async (_id: string, actor: string) => { actorIds.push(actor); return { requestId: legalId, kind: "complaint", status: "received", receivedAt: "2026-01-01T00:00:00.000Z", responseDueAt: null, answeredAt: null, retentionUntil: null, legalHold: false, revision: 0, response: "forbidden response", email: "private@example.test", narrative: "allowed legal narrative", transactionId: "allowed-transaction", cipher: "forbidden-cipher" }; },
    },
    securityIncidents: {
      listOperatorQueue: async (actor: string) => { actorIds.push(actor); return { items: [incidentItem], truncated: false }; },
      readAdmin: async (_id: string, actor: string) => { actorIds.push(actor); return { ...incidentItem, title: "allowed incident title", details: "allowed incident details", assessment: { categories: "availability", consequences: "bounded impact", dataSubjectCount: "1", recipientEmail: "private@example.test" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", authorityExportVersion: 2, assessmentVersion: 3, authorityReason: "allowed authority reason", subjectReason: "allowed subject reason", authoritySubmissionReference: "case-ref-1", subjectNotifications: [{ recipientPseudonym: "pseudonymous-recipient", snapshotVersion: 2, status: "failed", deliveryId: "delivery-1", recipientEmail: "private@example.test" }], preparedRecipients: [{ recipientPseudonym: "pseudonymous-prepared", snapshotVersion: 2, recipientEmail: "private@example.test" }], auditHistory: [{ event: "decide_authority", actorPseudonym: "actor-pseudonym", at: "2026-01-03T00:00:00.000Z", revision: 2, assessmentVersion: 3, snapshot: { secret: "forbidden-snapshot" } }], recipientEmail: "private@example.test", cipher: "forbidden-cipher" }; },
      readAuthorityExport: async (_id: string, _version: number, actor: string) => { actorIds.push(actor); return { payload: "exact-export", digest: "a".repeat(43), version: 2 }; },
    },
  };
  const app = buildApplication(makeDependencies(stores));
  try {
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/v1/operator/content-reports", headers: auth }),
      app.inject({ method: "GET", url: "/v1/operator/content-reports/" + reportId, headers: auth }),
      app.inject({ method: "GET", url: "/v1/operator/privacy-requests", headers: auth }),
      app.inject({ method: "GET", url: "/v1/operator/privacy-requests/" + privacyId, headers: auth }),
      app.inject({ method: "GET", url: "/v1/operator/legal-requests", headers: auth }),
      app.inject({ method: "GET", url: "/v1/operator/legal-requests/" + legalId, headers: auth }),
      app.inject({ method: "GET", url: "/v1/operator/security-incidents", headers: auth }),
      app.inject({ method: "GET", url: "/v1/operator/security-incidents/" + incidentId, headers: auth }),
      app.inject({ method: "GET", url: "/v1/operator/security-incidents/" + incidentId + "/authority-exports/2", headers: auth }),
    ]);
    assert.ok(responses.every((response) => response.statusCode === 200));
    assert.equal(responses[0]?.json().truncated, true);
    assert.equal(responses[4]?.json().truncated, true);
    const body = responses.map((response) => response.body).join(" ");
    for (const allowedValue of ["allowed report detail", "node-1", "allowed privacy narrative", "allowed privacy reason", "allowed legal narrative", "allowed-transaction", "allowed incident title", "allowed incident details", "allowed authority reason", "pseudonymous-recipient", "actor-pseudonym"]) assert.equal(body.includes(allowedValue), true);
    for (const privateValue of ["private@example.test", "forbidden response", "forbidden-token", "forbidden-cipher", "forbidden-snapshot", "forbidden-id", "forbidden-account"]) assert.equal(body.includes(privateValue), false, `detail leaked ${privateValue}`);
    assert.deepEqual(responses[0]?.json().items[0], contentItem);
    assert.equal(responses[7]?.json().item.auditHistory[0].snapshot, undefined);
    assert.equal(responses[8]?.json().payload, "exact-export");
    assert.equal(actorIds.length, 9);
    assert.ok(actorIds.every((actor) => actor !== subject && /^[A-Za-z0-9_-]{40,}$/u.test(actor)));
  } finally { await app.close(); }
});

test("operator transitions reject extra fields and disabled delivery actions before store writes", async () => {
  let transitions = 0;
  let privacyActions = 0;
  let legalActions = 0;
  let securityActions = 0;
  let exportCalls = 0;
  const createIds: string[] = [];
  const stores = {
    contentReports: {
      transitionStatus: async (_id: string, _actor: string, _next: string, expected: string) => { transitions += 1; assert.equal(expected, "open"); return { report: { id: reportId, ...contentItem, status: "in_review", description: "private", context: {}, linkage: "unlinked", updatedAt: "2026-01-02T00:00:00.000Z" }, duplicate: false }; },
    },
    privacyRequests: {
      transitionAdmin: async (_id: string, _actor: string, action: { action: string }, _sender: unknown, blockPublicEmail: boolean) => { privacyActions += 1; assert.equal(action.action, "start_review"); assert.equal(blockPublicEmail, true); return { requestId: privacyId, status: "in_review", revision: 3 }; },
      readExecutionContext: async () => ({ channel: "account", right: "access", status: "in_review", revision: 2, userId: "protected-account" }),
      prepareExecutedResponse: async () => ({ requestId: privacyId, status: "response_ready", revision: 3, response: "private export" }),
    },
    legalRequests: {
      transitionAdmin: async (_id: string, _actor: string, action: { action: string }, sender: unknown) => { legalActions += 1; assert.equal(action.action, "close"); assert.equal(sender, null); return { requestId: legalId, status: "closed", revision: 1 }; },
    },
    securityIncidents: {
      create: async (_actor: string, _input: unknown, id: string) => { createIds.push(id); return { ...incidentItem, title: "private", details: "private", assessment: {}, createdAt: "", updatedAt: "", authorityExportVersion: null, assessmentVersion: 1, authorityReason: null, subjectReason: null, authoritySubmissionReference: null, subjectNotifications: [], preparedRecipients: [], auditHistory: [] }; },
      act: async (_id: string, _actor: string, action: { action: string }) => { securityActions += 1; assert.equal(action.action, "classify"); return { ...incidentItem, nextAction: "decide_authority", revision: 1, title: "private", details: "private", assessment: {}, createdAt: "", updatedAt: "", authorityExportVersion: null, assessmentVersion: 1, authorityReason: null, subjectReason: null, authoritySubmissionReference: null, subjectNotifications: [], preparedRecipients: [], auditHistory: [] }; },
    },
  };
  const storesWithExport = {
    ...stores,
    dataExport: {
      create: async (userId: string, authorization: { administratorUserId: string; expectedRevision: number }, stableId: string, completed: (result: { serialized: string; exportId: string }) => Promise<void>) => {
        exportCalls += 1;
        assert.equal(userId, "protected-account");
        assert.notEqual(authorization.administratorUserId, subject);
        assert.equal(authorization.expectedRevision, 2);
        assert.match(stableId, /^export_[A-Za-z0-9_-]{32}$/u);
        await completed({ serialized: "private export", exportId: "export-fixture-1" });
      },
    },
  };
  const app = buildApplication({ ...makeDependencies(storesWithExport), legalRequestEmailSender: null });
  try {
    const bad = await app.inject({ method: "PATCH", url: "/v1/operator/content-reports/" + reportId, headers: auth, payload: { expectedStatus: "open", status: "in_review", extra: true } });
    assert.equal(bad.statusCode, 400);
    const content = await app.inject({ method: "PATCH", url: "/v1/operator/content-reports/" + reportId, headers: auth, payload: { expectedStatus: "open", status: "in_review" } });
    assert.equal(content.statusCode, 200);
    assert.equal("description" in content.json().item, false);
    assert.equal(transitions, 1);
    const privacy = await app.inject({ method: "PATCH", url: "/v1/operator/privacy-requests/" + privacyId, headers: auth, payload: { action: "start_review", expectedRevision: 2 } });
    assert.equal(privacy.statusCode, 200);
    const exportResult = await app.inject({ method: "PATCH", url: "/v1/operator/privacy-requests/" + privacyId, headers: auth, payload: { action: "execute_export", expectedRevision: 2 } });
    assert.equal(exportResult.statusCode, 200);
    assert.deepEqual(exportResult.json().item, { requestId: privacyId, status: "response_ready", revision: 3 });
    assert.equal("response" in exportResult.json().item, false);
    assert.equal(exportCalls, 1);
    const blockedPrivacy = await app.inject({ method: "PATCH", url: "/v1/operator/privacy-requests/" + privacyId, headers: auth, payload: { action: "retry_extension_notice", expectedRevision: 2 } });
    assert.equal(blockedPrivacy.statusCode, 409);
    assert.equal(privacyActions, 1);
    const legal = await app.inject({ method: "PATCH", url: "/v1/operator/legal-requests/" + legalId, headers: auth, payload: { action: "close", expectedRevision: 0 } });
    assert.equal(legal.statusCode, 200);
    const blockedLegal = await app.inject({ method: "PATCH", url: "/v1/operator/legal-requests/" + legalId, headers: auth, payload: { action: "answer", expectedRevision: 0, response: "private" } });
    assert.equal(blockedLegal.statusCode, 409);
    assert.equal(legalActions, 1);
    const blockedSecurity = await app.inject({ method: "PATCH", url: "/v1/operator/security-incidents/" + incidentId, headers: auth, payload: { action: "reconcile_subject_notifications", expectedRevision: 0, extra: true } });
    assert.equal(blockedSecurity.statusCode, 400);
    assert.equal(securityActions, 0);
    const createPayload = { title: "private title", details: "private details", detectedAt: "2026-01-01T00:00:00.000Z", categories: "availability", dataSubjectCount: "1", recordCount: "1", specialData: false, confidentialityImpact: "none", integrityImpact: "none", availabilityImpact: "low", consequences: "none", likelihood: "low", severity: "low", containment: "contained", remediation: "done", prevention: "updated", postmortem: "complete" };
    const createUrl = "/v1/operator/security-incidents/" + incidentId;
    const firstCreate = await app.inject({ method: "PUT", url: createUrl, headers: auth, payload: createPayload });
    const replayCreate = await app.inject({ method: "PUT", url: createUrl, headers: auth, payload: createPayload });
    assert.equal(firstCreate.statusCode, 200);
    assert.deepEqual(replayCreate.json(), firstCreate.json());
    assert.deepEqual(createIds, [incidentId.slice(3), incidentId.slice(3)]);
    assert.equal("details" in firstCreate.json().item, false);
    for (const response of [bad, content, privacy, exportResult, blockedPrivacy, legal, blockedLegal, blockedSecurity, firstCreate, replayCreate]) assert.equal(response.headers["cache-control"], "private, no-store");
  } finally { await app.close(); }
});
