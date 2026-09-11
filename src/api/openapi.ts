import { CONSUMER_SCOPES, SECURITY_PROFILES, securityRequirementNames, type SecurityProfile } from "./openapi-validator.js";

const SECURITY_INCIDENT_ACTIONS = ["acknowledge_awareness", "classify", "correct_assessment", "decide_authority", "prepare_authority_export", "record_authority_submission", "decide_subject", "prepare_subject_notification", "send_subject_notification", "resolve_subject_notification_unknown", "reconcile_subject_notifications", "set_legal_hold", "release_legal_hold", "close"] as const;
const incidentRevision = { type: "integer", minimum: 0 };
const incidentText = (max: number) => ({ type: "string", minLength: 1, maxLength: max });
const assessmentProperties = { details: incidentText(50_000), detectedAt: { type: "string", format: "date-time" }, occurredAt: { type: "string", format: "date-time" }, containedAt: { type: "string", format: "date-time" }, categories: incidentText(4_000), dataSubjectCount: incidentText(256), recordCount: incidentText(256), specialData: { type: "boolean" }, confidentialityImpact: incidentText(2_000), integrityImpact: incidentText(2_000), availabilityImpact: incidentText(2_000), consequences: incidentText(8_000), likelihood: incidentText(1_000), severity: incidentText(1_000), containment: incidentText(8_000), remediation: incidentText(8_000), prevention: incidentText(8_000), postmortem: incidentText(8_000) };
const incidentAction = (action: string, required: readonly string[], properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: ["action", "expectedRevision", ...required], properties: { action: { const: action }, expectedRevision: incidentRevision, ...properties } });
const SECURITY_INCIDENT_ACTION_SCHEMAS = [
  incidentAction("acknowledge_awareness", [], {}),
  incidentAction("classify", ["classification", "reason"], { classification: { type: "string", enum: ["triage", "breach_confirmed", "not_a_breach"] }, reason: incidentText(4_000) }),
  incidentAction("correct_assessment", ["reason", ...Object.keys(assessmentProperties).filter((key) => key !== "occurredAt" && key !== "containedAt")], { reason: incidentText(4_000), ...assessmentProperties }),
  incidentAction("decide_authority", ["decision", "reason"], { decision: { type: "string", enum: ["required", "not_required"] }, reason: incidentText(4_000), legalException: { type: "string", maxLength: 4_000 } }),
  incidentAction("prepare_authority_export", ["payload"], { payload: incidentText(100_000) }),
  incidentAction("record_authority_submission", ["channel", "reference", "evidence"], { channel: incidentText(128), reference: incidentText(512), evidence: incidentText(20_000), supplementary: { type: "boolean", default: false }, delayReason: { type: "string", minLength: 1, maxLength: 4_000 } }),
  incidentAction("decide_subject", ["decision", "reason"], { decision: { type: "string", enum: ["required", "not_required"] }, reason: incidentText(4_000), legalException: { type: "string", maxLength: 4_000 } }),
  incidentAction("prepare_subject_notification", ["recipients", "subject", "text"], { recipients: { type: "array", minItems: 1, maxItems: 500, items: { type: "string", format: "email", maxLength: 320 } }, subject: incidentText(300), text: incidentText(50_000) }),
  incidentAction("send_subject_notification", ["recipientPseudonym", "snapshotVersion"], { recipientPseudonym: { type: "string", pattern: "^[A-Za-z0-9_-]{16,128}$" }, snapshotVersion: { type: "integer", minimum: 1 } }),
  incidentAction("resolve_subject_notification_unknown", ["deliveryId", "outcome", "reason"], { deliveryId: { type: "string", format: "uuid" }, outcome: { type: "string", enum: ["sent", "failed"] }, reason: incidentText(4_000) }),
  incidentAction("reconcile_subject_notifications", [], {}), incidentAction("set_legal_hold", ["reason"], { reason: incidentText(4_000) }), incidentAction("release_legal_hold", ["reason"], { reason: incidentText(4_000) }), incidentAction("close", [], {}),
] as const;

const progressMutationProperties = {
  mutationId: { type: "string", pattern: "^[A-Za-z0-9_-]{16,128}$" },
  trackId: { type: "string", minLength: 1, maxLength: 128 },
  targetId: { type: "string", minLength: 1, maxLength: 256 },
  expectedVersion: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
  fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
  state: { type: "object", additionalProperties: true },
};
const progressMutationRequired = ["mutationId", "kind", "recordType", "trackId", "targetId", "expectedVersion", "fingerprint", "state"];
const progressMutationVariant = (recordType: string, kind: "node" | "item") => ({
  type: "object",
  additionalProperties: false,
  required: progressMutationRequired,
  properties: { ...progressMutationProperties, recordType: { const: recordType }, kind: { const: kind } },
});
const allProgressMutationVariants = [
  ["active_track", "node"],
  ["training_session_summary", "node"],
  ["training_session_result", "node"],
  ["training_attempt", "item"],
  ["review_queue_entry", "item"],
  ["goal", "node"],
  ["learning_plan", "node"],
] as const;
const legacyProgressMutationVariants = allProgressMutationVariants.slice(0, 5);

const OPENAPI_DOCUMENT_RAW = {
  openapi: "3.1.0",
  info: { title: "Patternly Backend API", version: "1.0.0" },
  servers: [{ url: "/" }],
  security: [{ bearerAuth: [] }],
  paths: {
    "/health": { "x-patternly-security-profile": "public", "x-patternly-consumer-scope": "diagnostic", get: { security: [], responses: { "200": { description: "Process is alive" } } } },
    "/ready": { "x-patternly-security-profile": "public", "x-patternly-consumer-scope": "diagnostic", get: { security: [], responses: { "200": { description: "Dependencies are ready" }, "503": { description: "Dependency unavailable" } } } },
    "/openapi.json": { "x-patternly-security-profile": "public", "x-patternly-consumer-scope": "diagnostic", get: { security: [], responses: { "200": { description: "OpenAPI document" } } } },
    "/v1/webhooks/revenuecat": { "x-patternly-security-profile": "webhook", "x-patternly-consumer-scope": "backend-only", post: { security: [], description: "Receive one authenticated, idempotent RevenueCat lifecycle event, bind an initial purchase to the active attempt, deliver its durable receipt, and update the canonical Premium projection.", parameters: [{ name: "Authorization", in: "header", required: true, schema: { type: "string", minLength: 1 } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["event"], properties: { event: { type: "object", additionalProperties: true } } } } } }, responses: { "200": { description: "Event processed, ignored, or replayed" }, "400": { description: "Malformed event" }, "401": { description: "Webhook authorization failed" }, "503": { description: "Webhook or durable receipt delivery is unavailable; sender should retry" } } } },
    "/v1/me": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "mobile", get: { responses: { "200": { description: "Canonical account identity" }, "401": { description: "Authentication required" } } } },
    "/v1/legal-acceptances": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "mobile", post: { description: "Record an immutable, versioned Terms and minimum-age acceptance for the authenticated account.", responses: { "201": { description: "Acceptance recorded" }, "400": { description: "Invalid acceptance" }, "401": { description: "Authentication required" } } } },
    "/v1/purchase-confirmations": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "mobile", post: { description: "Record the immutable pre-contract offer and express immediate-start request before opening App Store checkout.", responses: { "201": { description: "Confirmation recorded" }, "400": { description: "Invalid confirmation" }, "401": { description: "Authentication required" } } } },
    "/v1/entitlements": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "mobile", get: { responses: { "200": { description: "Account entitlement projection" } } } },
    "/v1/progress": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "mobile", get: { parameters: [{ name: "protocolVersion", in: "query", required: false, schema: { type: "integer", enum: [1, 2], default: 1 } }, { name: "pageSize", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } }, { name: "pageToken", in: "query", required: false, schema: { type: "string", minLength: 1 } }], responses: { "200": { description: "Canonical progress state and account revision; paged responses include generation and nextPageToken" }, "400": { description: "Unsupported protocol version or invalid pagination token" }, "409": { description: "Progress generation or account revision changed while paging" } } } },
    "/v1/account-data/export": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "mobile", get: { description: "Download a bounded JSON account-data export after recent reauthentication. The response is an attachment and is never persisted as a payload.", responses: { "200": { description: "JSON account-data attachment", headers: { "Cache-Control": { schema: { type: "string", const: "private, no-store" } }, "Content-Disposition": { schema: { type: "string" } } }, content: { "application/json": { schema: { "$ref": "#/components/schemas/AccountDataExport" } } } }, "401": { description: "Authentication or recent reauthentication required", headers: { "Cache-Control": { schema: { type: "string", const: "private, no-store" } } } }, "413": { description: "Serialized export exceeds the configured maximum" }, "429": { description: "Per-account export rate limit exceeded", headers: { "Retry-After": { schema: { type: "integer", minimum: 1 } } } } } } },
    "/v1/privacy-requests": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "mobile", post: { description: "Create one authenticated privacy-right case", requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/CreateAccountPrivacyRequest" } } } }, responses: { "201": { description: "Privacy request created" }, "401": { description: "Authentication or recent reauthentication required" } } }, get: { description: "List minimal metadata for the authenticated subject's own privacy requests", responses: { "200": { description: "Privacy request list" } } } },
    "/v1/privacy-requests/{requestId}": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "mobile", get: { description: "Read one own privacy response after recent reauthentication", parameters: [{ "$ref": "#/components/parameters/PrivacyRequestId" }], responses: { "200": { description: "Privacy response" }, "401": { description: "Recent reauthentication required" }, "404": { description: "Request unavailable" } } } },
    "/v1/public/privacy-requests": { "x-patternly-security-profile": "public", "x-patternly-consumer-scope": "web", post: { security: [], description: "Accept a non-enumerating guest privacy request and send an email-possession link", requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/CreatePublicPrivacyRequest" } } } }, responses: { "202": { description: "Request accepted without disclosing matching data" }, "429": { description: "Rate limited" }, "503": { description: "Email delivery unavailable" } } } },
    "/v1/public/privacy-requests/{requestId}/session": { "x-patternly-security-profile": "public", "x-patternly-consumer-scope": "web", post: { security: [], description: "Exchange a one-time fragment token for a short object-scoped session", parameters: [{ "$ref": "#/components/parameters/PrivacyRequestId" }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/PrivacyTokenExchange" } } } }, responses: { "200": { description: "Short privacy-request session" }, "404": { description: "Uniform unavailable response" } } } },
    "/v1/public/privacy-requests/{requestId}/response": { "x-patternly-security-profile": "public", "x-patternly-consumer-scope": "web", post: { security: [], description: "Read guest request status and an unexpired response with an object-scoped session", parameters: [{ "$ref": "#/components/parameters/PrivacyRequestId" }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/PublicPrivacySession" } } } }, responses: { "200": { description: "Privacy response" }, "404": { description: "Uniform unavailable response" } } } },
    "/v1/legal-requests": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "mobile", post: { description: "Create an authenticated consumer complaint, withdrawal, non-personal data recovery request, or suspension appeal and email a durable receipt.", responses: { "201": { description: "Consumer case received" }, "401": { description: "Authentication required" }, "503": { description: "Email delivery unavailable" } } }, get: { description: "List the authenticated account's consumer cases.", responses: { "200": { description: "Consumer case list" } } } },
    "/v1/legal-requests/{requestId}": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "mobile", get: { description: "Read one consumer case owned by the authenticated account.", responses: { "200": { description: "Consumer case" }, "404": { description: "Case unavailable" } } } },
    "/v1/public/legal-requests": { "x-patternly-security-profile": "app_check_optional_bearer", "x-patternly-consumer-scope": "mobile", post: { security: [{ appCheckAuth: [] }], description: "Create a guest consumer case with App Check, bounded rate limiting, and a durable email receipt.", parameters: [{ "$ref": "#/components/parameters/FirebaseAppCheck" }], responses: { "201": { description: "Consumer case received" }, "401": { description: "Valid App Check required" }, "429": { description: "Rate limited" }, "503": { description: "Email delivery unavailable" } } } },
    "/v1/progress/sync": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "mobile", post: { requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/SyncRequest" } } } }, responses: { "200": { description: "Applied or duplicate mutations" }, "400": { description: "Invalid sync request, fingerprint, or track bundle" }, "409": { description: "Progress or account revision conflict" }, "413": { description: "Canonical UTF-8 sync envelope exceeds 512 KiB" } } } },
    "/v1/account-data/adoption/preview": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "mobile", post: { description: "Preview local account-data adoption without binding or writing learning records", requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/GuestMergeSnapshot" } } } }, responses: { "200": { description: "Deterministic adoption preview" }, "400": { description: "Invalid snapshot" } } } },
    "/v1/account-data/adoption/confirm": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "mobile", post: { description: "Execute an exact confirmed adoption preview idempotently", requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/AdoptionConfirmationRequest" } } } }, responses: { "200": { description: "Adoption executed or replayed idempotently" }, "409": { description: "Preview, resolution, active-session or idempotency conflict" } } } },
    "/v3/account-data/adoption/start": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "backend-only", post: { description: "Start an authenticated, resumable adoption-v3 transfer session", requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/AdoptionTransferStart" } } } }, responses: { "200": { description: "Transfer session created or replayed idempotently" }, "400": { description: "Invalid transfer start" }, "401": { description: "Authentication required" }, "409": { description: "Generation or idempotency conflict" } } } },
    "/v3/account-data/adoption/{sessionId}/upload": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "backend-only", post: { description: "Upload one bounded adoption-v3 chunk; records and chunk metadata are stored separately", parameters: [{ "$ref": "#/components/parameters/AdoptionTransferSessionId" }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/AdoptionTransferUpload" } } } }, responses: { "200": { description: "Chunk accepted or replayed" }, "400": { description: "Invalid record, chunk, or fingerprint" }, "404": { description: "Transfer unavailable" }, "409": { description: "Duplicate, state, or idempotency conflict" }, "413": { description: "Canonical envelope or record limit exceeded" } } } },
    "/v3/account-data/adoption/{sessionId}/seal": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "backend-only", post: { description: "Seal a complete adoption-v3 transfer by canonical digest", parameters: [{ "$ref": "#/components/parameters/AdoptionTransferSessionId" }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/AdoptionTransferSeal" } } } }, responses: { "200": { description: "Transfer sealed or replayed" }, "400": { description: "Invalid seal" }, "404": { description: "Transfer unavailable" }, "409": { description: "Incomplete, stale, or mismatched seal" } } } },
    "/v3/account-data/adoption/{sessionId}/preview": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "backend-only", post: { description: "Build a resumable deterministic adoption-v3 preview using the existing merge semantics", parameters: [{ "$ref": "#/components/parameters/AdoptionTransferSessionId" }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/AdoptionTransferPreview" } } } }, responses: { "200": { description: "Preview ready" }, "400": { description: "Invalid or unsupported merge" }, "404": { description: "Transfer unavailable" }, "409": { description: "Preview or generation conflict" } } } },
    "/v3/account-data/adoption/{sessionId}/confirm": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "backend-only", post: { description: "Persist an immutable adoption-v3 decision fingerprint and exact conflict resolutions", parameters: [{ "$ref": "#/components/parameters/AdoptionTransferSessionId" }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/AdoptionTransferConfirm" } } } }, responses: { "200": { description: "Decision recorded or replayed" }, "400": { description: "Invalid confirmation" }, "404": { description: "Transfer unavailable" }, "409": { description: "Preview, decision, device, or resolution conflict" } } } },
    "/v3/account-data/adoption/{sessionId}/apply": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "backend-only", post: { description: "Materialize confirmed adoption into an invisible generation and atomically flip the active generation", parameters: [{ "$ref": "#/components/parameters/AdoptionTransferSessionId" }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/AdoptionTransferApply" } } } }, responses: { "200": { description: "Applied or resumed atomically" }, "400": { description: "Invalid apply request" }, "404": { description: "Transfer unavailable" }, "409": { description: "Generation, cursor, or decision conflict" } } } },
    "/v3/account-data/adoption/{sessionId}/status": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "backend-only", get: { description: "Read bounded resumable adoption-v3 status", parameters: [{ "$ref": "#/components/parameters/AdoptionTransferSessionId" }, { name: "deviceId", in: "query", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Transfer status", content: { "application/json": { schema: { "$ref": "#/components/schemas/AdoptionTransferStatus" } } } }, "400": { description: "Invalid or mismatched device" }, "404": { description: "Transfer unavailable" } } } },
    "/v1/account/recovery-codes": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "mobile", post: { description: "Replace the account's ten one-time recovery codes after recent reauthentication", requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/EmptyRequest" } } } }, responses: { "200": { description: "Recovery codes returned once" }, "401": { description: "Recent reauthentication required" } } } },
    "/v1/public/recovery-codes/consume": { "x-patternly-security-profile": "public", "x-patternly-consumer-scope": "mobile", post: { security: [], description: "Consume one possession recovery code and issue a Firebase custom token", requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/RecoveryCodeConsumeRequest" } } } }, responses: { "200": { description: "Recovery code consumed" }, "401": { description: "Invalid recovery code" }, "409": { description: "Recovery code already used" } } } },
    "/v1/account/session/revoke": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "mobile", post: { description: "Revoke current and stale Firebase sessions idempotently", requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/OperationRequest" } } } }, responses: { "200": { description: "Sessions revoked" }, "503": { description: "Revocation pending; account remains bound" } } } },
    "/v1/account/deletion": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "mobile", post: { description: "Delete the authenticated account after recent reauthentication and return a verified proof", requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/OperationRequest" } } } }, responses: { "200": { description: "Remote deletion and proof complete" }, "401": { description: "Recent reauthentication required" }, "503": { description: "Remote deletion pending" } } } },
    "/v1/public/deletion-proofs/{proofId}": { "x-patternly-security-profile": "public", "x-patternly-consumer-scope": "mobile", get: { security: [], description: "Read an opaque server deletion proof", parameters: [{ name: "proofId", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Deletion proof" }, "404": { description: "Proof unavailable" } } } },
    "/v1/public/deletion-operations/status": { "x-patternly-security-profile": "public", "x-patternly-consumer-scope": "mobile", post: { security: [], description: "Resume an in-app deletion after its Firebase account has been removed, using the operation-bound secret", requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/PublicDeletionStatus" } } } }, responses: { "200": { description: "Deletion operation status" }, "404": { description: "Operation unavailable" } } } },
    "/v1/tracks": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "mobile", get: { responses: { "200": { description: "Account track access" } } } },
    "/v1/content/versions": { "x-patternly-security-profile": "bearer", "x-patternly-consumer-scope": "mobile", get: { responses: { "200": { description: "Current immutable content metadata" } } } },
    "/v1/content/reports": { "x-patternly-security-profile": "app_check_optional_bearer", "x-patternly-consumer-scope": "mobile", post: { security: [{ appCheckAuth: [] }], description: "App Check is required. Account and contact linkage are stored only when explicitly requested; account linkage additionally requires an optional Firebase bearer token.", parameters: [{ "$ref": "#/components/parameters/FirebaseAppCheck" }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/CreateContentReport" } } } }, responses: { "201": { description: "Content report accepted" }, "200": { description: "Duplicate client submission" }, "400": { description: "Invalid report" }, "401": { description: "Valid App Check required or account linkage authentication required" }, "429": { description: "Anonymous report rate limit exceeded" } } } },
    "/v1/admin/content-reports": { "x-patternly-security-profile": "admin", "x-patternly-consumer-scope": "mobile+web", get: { description: "Open, in-review, and resolved content reports for the configured administrator with a verified Firebase email.", responses: { "200": { description: "Content report triage queue" }, "401": { description: "Valid Firebase bearer token required" }, "403": { description: "Verified configured administrator required" } } } },
    "/v1/admin/privacy-requests": { "x-patternly-security-profile": "admin", "x-patternly-consumer-scope": "web", get: { description: "Minimal deadline-ordered privacy request queue for the verified configured administrator", responses: { "200": { description: "Privacy request queue" }, "403": { description: "Administrator required" } } } },
    "/v1/admin/privacy-requests/{requestId}": { "x-patternly-security-profile": "admin", "x-patternly-consumer-scope": "web", get: { description: "Read audited privacy request details", parameters: [{ "$ref": "#/components/parameters/PrivacyRequestId" }], responses: { "200": { description: "Privacy request details" }, "404": { description: "Request unavailable" } } }, patch: { description: "Apply one revision-guarded privacy request lifecycle action", parameters: [{ "$ref": "#/components/parameters/PrivacyRequestId" }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/PrivacyRequestAdminAction" } } } }, responses: { "200": { description: "Transition applied" }, "409": { description: "Revision or lifecycle conflict" }, "503": { description: "Response email unavailable" } } } },
    "/v1/admin/legal-requests": { "x-patternly-security-profile": "admin", "x-patternly-consumer-scope": "web", get: { description: "List the minimal consumer-case queue for the verified administrator.", responses: { "200": { description: "Consumer-case queue" }, "403": { description: "Administrator required" } } } },
    "/v1/admin/legal-requests/{requestId}": { "x-patternly-security-profile": "admin", "x-patternly-consumer-scope": "web", get: { description: "Read audited consumer-case details.", responses: { "200": { description: "Consumer-case details" }, "404": { description: "Case unavailable" } } }, patch: { description: "Apply a revision-guarded review, answer, closure, or legal-hold action.", responses: { "200": { description: "Action applied" }, "409": { description: "Revision or lifecycle conflict" }, "503": { description: "Answer delivery unavailable" } } } },
    "/v1/admin/security-incidents": { "x-patternly-security-profile": "admin", "x-patternly-consumer-scope": "web", post: { description: "Create a minimal encrypted security-incident register record; verified configured administrator only.", requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/SecurityIncidentCreate" } } } }, responses: { "201": { description: "Incident created", content: { "application/json": { schema: { "$ref": "#/components/schemas/SecurityIncidentResponse" } } } }, "403": { description: "Administrator required" } } }, get: { description: "List security incidents without sensitive details or recipient data.", responses: { "200": { description: "Incident queue", content: { "application/json": { schema: { "$ref": "#/components/schemas/SecurityIncidentListResponse" } } } }, "403": { description: "Administrator required" } } } },
    "/v1/admin/security-incidents/{incidentId}": { "x-patternly-security-profile": "admin", "x-patternly-consumer-scope": "web", get: { description: "Read audited encrypted incident details.", parameters: [{ "$ref": "#/components/parameters/SecurityIncidentId" }], responses: { "200": { description: "Incident details", content: { "application/json": { schema: { "$ref": "#/components/schemas/SecurityIncidentResponse" } } } }, "404": { description: "Incident unavailable" } } }, patch: { description: "Apply an explicit revision-guarded incident action. UODO submission is recorded manually; this API never sends reports to UODO.", parameters: [{ "$ref": "#/components/parameters/SecurityIncidentId" }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/SecurityIncidentAction" } } } }, responses: { "200": { description: "Incident action applied", content: { "application/json": { schema: { "$ref": "#/components/schemas/SecurityIncidentResponse" } } } }, "409": { description: "Revision or legal-lifecycle conflict" }, "503": { description: "Subject-notification email unavailable" } } } },
    "/v1/admin/security-incidents/{incidentId}/authority-exports/{version}": { "x-patternly-security-profile": "admin", "x-patternly-consumer-scope": "web", get: { description: "Read one exact encrypted, versioned UODO export and audit the read.", parameters: [{ "$ref": "#/components/parameters/SecurityIncidentId" }, { name: "version", in: "path", required: true, schema: { type: "integer", minimum: 1 } }], responses: { "200": { description: "Exact prepared export", content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["payload", "digest", "version"], properties: { payload: { type: "string", minLength: 1 }, digest: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" }, version: { type: "integer", minimum: 1 } } } } } }, "404": { description: "Export unavailable" } } } },
    "/v1/admin/overview": { "x-patternly-security-profile": "admin", "x-patternly-consumer-scope": "web", get: { description: "Bounded operational metrics from Firestore and question-bank availability from the configured checksum-verified immutable content release.", responses: { "200": { description: "Published-content, usage, and report statistics" }, "401": { description: "Valid Firebase bearer token required" }, "403": { description: "Verified configured administrator required" } } } },
    "/v1/admin/questions": { "x-patternly-security-profile": "admin", "x-patternly-consumer-scope": "web", get: { description: "Paginated inspection of checksum-verified, locally configured published artifacts. The endpoint never dereferences package URIs.", parameters: [{ name: "trackId", in: "query", required: false, schema: { type: "string" } }, { name: "q", in: "query", required: false, schema: { type: "string", maxLength: 160 } }, { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1 } }, { name: "pageSize", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } }], responses: { "200": { description: "Question page from verified published artifacts" }, "400": { description: "Invalid query parameters" }, "503": { description: "Question package inspection is not configured" }, "401": { description: "Valid Firebase bearer token required" }, "403": { description: "Verified configured administrator required" } } } },
    "/v1/admin/content-reports/{clientSubmissionId}": { "x-patternly-security-profile": "admin", "x-patternly-consumer-scope": "mobile+web", patch: { description: "Advance one report through the server-owned triage state machine; a verified Firebase token for the configured administrator is required.", parameters: [{ name: "clientSubmissionId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/TransitionContentReport" } } } }, responses: { "200": { description: "Status transition applied or repeated idempotently" }, "400": { description: "Invalid status transition request" }, "401": { description: "Valid Firebase bearer token required" }, "403": { description: "Verified configured administrator required" }, "404": { description: "Report not found" }, "409": { description: "Status transition is not allowed" } } } },
  },
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "Firebase ID token" }, appCheckAuth: { type: "apiKey", in: "header", name: "X-Firebase-AppCheck" } },
    parameters: { FirebaseAppCheck: { name: "X-Firebase-AppCheck", in: "header", required: true, schema: { type: "string", minLength: 1 } }, PrivacyRequestId: { name: "requestId", in: "path", required: true, schema: { type: "string", pattern: "^pr_[0-9a-f-]{36}$" } }, SecurityIncidentId: { name: "incidentId", in: "path", required: true, schema: { type: "string", pattern: "^si_[0-9a-f-]{36}$" } }, AdoptionTransferSessionId: { name: "sessionId", in: "path", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" } } },
    schemas: {
      SecurityIncidentCreate: { type: "object", additionalProperties: false, required: ["title", "details", "detectedAt", "categories", "dataSubjectCount", "recordCount", "specialData", "confidentialityImpact", "integrityImpact", "availabilityImpact", "consequences", "likelihood", "severity", "containment", "remediation", "prevention", "postmortem"], properties: { title: { type: "string", minLength: 1, maxLength: 200 }, details: { type: "string", minLength: 1, maxLength: 50000 }, detectedAt: { type: "string", format: "date-time" }, occurredAt: { type: "string", format: "date-time" }, containedAt: { type: "string", format: "date-time" }, categories: { type: "string" }, dataSubjectCount: { type: "string" }, recordCount: { type: "string" }, specialData: { type: "boolean" }, confidentialityImpact: { type: "string" }, integrityImpact: { type: "string" }, availabilityImpact: { type: "string" }, consequences: { type: "string" }, likelihood: { type: "string" }, severity: { type: "string" }, containment: { type: "string" }, remediation: { type: "string" }, prevention: { type: "string" }, postmortem: { type: "string" } } },
      SecurityIncidentAction: { oneOf: SECURITY_INCIDENT_ACTION_SCHEMAS },
      SecurityIncidentAssessment: { type: "object", additionalProperties: false, required: ["details", "detectedAt", "categories", "dataSubjectCount", "recordCount", "specialData", "confidentialityImpact", "integrityImpact", "availabilityImpact", "consequences", "likelihood", "severity", "containment", "remediation", "prevention", "postmortem"], properties: { details: { type: "string" }, detectedAt: { type: "string", format: "date-time" }, occurredAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, containedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, categories: { type: "string" }, dataSubjectCount: { type: "string" }, recordCount: { type: "string" }, specialData: { type: "boolean" }, confidentialityImpact: { type: "string" }, integrityImpact: { type: "string" }, availabilityImpact: { type: "string" }, consequences: { type: "string" }, likelihood: { type: "string" }, severity: { type: "string" }, containment: { type: "string" }, remediation: { type: "string" }, prevention: { type: "string" }, postmortem: { type: "string" } } },
      SecurityIncidentListItem: { type: "object", additionalProperties: false, required: ["incidentId", "classification", "authorityDecision", "authorityDeliveryStatus", "subjectDecision", "subjectNotificationStatus", "awarenessAt", "authorityDeadlineAt", "closedAt", "revision", "legalHold", "nextAction"], properties: { incidentId: { type: "string" }, classification: { enum: ["triage", "breach_confirmed", "not_a_breach"] }, authorityDecision: { enum: ["undecided", "required", "not_required"] }, authorityDeliveryStatus: { enum: ["not_started", "submitted", "supplemented"] }, subjectDecision: { enum: ["undecided", "required", "not_required"] }, subjectNotificationStatus: { enum: ["not_started", "prepared", "pending", "sent", "failed", "unknown"] }, awarenessAt: { anyOf: [{ type: "string" }, { type: "null" }] }, authorityDeadlineAt: { anyOf: [{ type: "string" }, { type: "null" }] }, closedAt: { anyOf: [{ type: "string" }, { type: "null" }] }, revision: { type: "integer", minimum: 0 }, legalHold: { type: "boolean" }, nextAction: { enum: ["acknowledge_awareness", "classify", "decide_authority", "prepare_authority_export", "record_authority_submission", "decide_subject", "prepare_subject_notification", "resolve_subject_notification_unknown", "send_subject_notification", "close", "none"] } } },
      SecurityIncidentAuditSnapshot: { type: "object", additionalProperties: false, properties: { classification: { enum: ["triage", "breach_confirmed", "not_a_breach"] }, authorityDecision: { enum: ["undecided", "required", "not_required"] }, authorityDeliveryStatus: { enum: ["not_started", "submitted", "supplemented"] }, subjectDecision: { enum: ["undecided", "required", "not_required"] }, subjectNotificationStatus: { enum: ["not_started", "prepared", "pending", "sent", "failed", "unknown"] } } },
      SecurityIncidentAuditEntry: { type: "object", additionalProperties: false, required: ["event", "actorPseudonym", "at", "revision", "assessmentVersion", "snapshot"], properties: { event: { type: "string" }, actorPseudonym: { type: "string" }, at: { type: "string" }, revision: { anyOf: [{ type: "integer" }, { type: "null" }] }, assessmentVersion: { anyOf: [{ type: "integer" }, { type: "null" }] }, snapshot: { anyOf: [{ "$ref": "#/components/schemas/SecurityIncidentAuditSnapshot" }, { type: "null" }] } } },
      SecurityIncidentPreparedRecipient: { type: "object", additionalProperties: false, required: ["recipientPseudonym", "snapshotVersion"], properties: { recipientPseudonym: { type: "string" }, snapshotVersion: { type: "integer", minimum: 1 } } },
      SecurityIncidentDelivery: { type: "object", additionalProperties: false, required: ["recipientPseudonym", "snapshotVersion", "status", "deliveryId"], properties: { recipientPseudonym: { type: "string" }, snapshotVersion: { type: "integer", minimum: 1 }, status: { enum: ["pending", "sent", "failed", "unknown", "superseded"] }, deliveryId: { type: "string", format: "uuid" } } },
      SecurityIncidentDetails: { type: "object", additionalProperties: false, required: ["incidentId", "classification", "authorityDecision", "authorityDeliveryStatus", "subjectDecision", "subjectNotificationStatus", "awarenessAt", "authorityDeadlineAt", "closedAt", "revision", "legalHold", "nextAction", "title", "details", "assessment", "createdAt", "updatedAt", "authorityExportVersion", "assessmentVersion", "authorityReason", "subjectReason", "authoritySubmissionReference", "preparedRecipients", "auditHistory", "subjectNotifications"], properties: { incidentId: { type: "string" }, classification: { enum: ["triage", "breach_confirmed", "not_a_breach"] }, authorityDecision: { enum: ["undecided", "required", "not_required"] }, authorityDeliveryStatus: { enum: ["not_started", "submitted", "supplemented"] }, subjectDecision: { enum: ["undecided", "required", "not_required"] }, subjectNotificationStatus: { enum: ["not_started", "prepared", "pending", "sent", "failed", "unknown"] }, awarenessAt: { anyOf: [{ type: "string" }, { type: "null" }] }, authorityDeadlineAt: { anyOf: [{ type: "string" }, { type: "null" }] }, closedAt: { anyOf: [{ type: "string" }, { type: "null" }] }, revision: { type: "integer", minimum: 0 }, legalHold: { type: "boolean" }, nextAction: { enum: ["acknowledge_awareness", "classify", "decide_authority", "prepare_authority_export", "record_authority_submission", "decide_subject", "prepare_subject_notification", "resolve_subject_notification_unknown", "send_subject_notification", "close", "none"] }, title: { type: "string" }, details: { type: "string" }, assessment: { "$ref": "#/components/schemas/SecurityIncidentAssessment" }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" }, authorityExportVersion: { anyOf: [{ type: "integer" }, { type: "null" }] }, assessmentVersion: { type: "integer", minimum: 1 }, authorityReason: { anyOf: [{ type: "string" }, { type: "null" }] }, subjectReason: { anyOf: [{ type: "string" }, { type: "null" }] }, authoritySubmissionReference: { anyOf: [{ type: "string" }, { type: "null" }] }, preparedRecipients: { type: "array", items: { "$ref": "#/components/schemas/SecurityIncidentPreparedRecipient" } }, auditHistory: { type: "array", items: { "$ref": "#/components/schemas/SecurityIncidentAuditEntry" } }, subjectNotifications: { type: "array", items: { "$ref": "#/components/schemas/SecurityIncidentDelivery" } } } },
      SecurityIncidentResponse: { type: "object", additionalProperties: false, required: ["incident"], properties: { incident: { "$ref": "#/components/schemas/SecurityIncidentDetails" } } },
      SecurityIncidentListResponse: { type: "object", additionalProperties: false, required: ["incidents"], properties: { incidents: { type: "array", items: { "$ref": "#/components/schemas/SecurityIncidentListItem" } } } },
      ProgressMutation: {
        oneOf: allProgressMutationVariants.map(([recordType, kind]) => progressMutationVariant(recordType, kind)),
      },
      LegacyProgressMutation: {
        oneOf: legacyProgressMutationVariants.map(([recordType, kind]) => progressMutationVariant(recordType, kind)),
      },
      SyncRequest: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["expectedAccountRevision", "mutations"],
            properties: {
              protocolVersion: { type: "integer", const: 1, default: 1 },
              expectedAccountRevision: { type: "integer", minimum: 0 },
              deviceId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }], default: null },
              mutations: { type: "array", minItems: 1, maxItems: 100, items: { "$ref": "#/components/schemas/LegacyProgressMutation" } },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["protocolVersion", "expectedAccountRevision", "mutations"],
            properties: {
              protocolVersion: { type: "integer", const: 2 },
              expectedAccountRevision: { type: "integer", minimum: 0 },
              deviceId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }], default: null },
              mutations: { type: "array", minItems: 1, maxItems: 100, items: { "$ref": "#/components/schemas/ProgressMutation" } },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["protocolVersion", "canonicalVersion", "expectedAccountRevision", "deviceId", "sessionId", "batchId", "planVersion", "highWatermark", "mutations"],
            properties: {
              protocolVersion: { type: "integer", const: 3 },
              canonicalVersion: { type: "string", const: "canonical-json-v1" },
              expectedAccountRevision: { type: "integer", minimum: 0 },
              deviceId: { type: "string", format: "uuid" },
              sessionId: { type: "string", minLength: 1, maxLength: 128 },
              batchId: { type: "string", minLength: 1, maxLength: 128 },
              planVersion: { type: "integer", const: 3 },
              highWatermark: { type: "integer", minimum: 0 },
              mutations: { type: "array", minItems: 1, maxItems: 100, items: { "$ref": "#/components/schemas/ProgressMutation" } },
            },
          },
        ],
      },
      GuestMergeSnapshot: {
        type: "object",
        additionalProperties: false,
        required: ["guestSnapshotVersion", "guestUserId", "records", "activeSession", "pendingJournal"],
        properties: {
          protocolVersion: { type: "integer", enum: [1, 2] },
          guestSnapshotVersion: { type: "integer", minimum: 0 },
          guestUserId: { type: "string", format: "uuid" },
          records: { type: "array", maxItems: 1000, items: { "$ref": "#/components/schemas/GuestMergeRecord" } },
          activeSession: { type: "boolean" },
          pendingJournal: { type: "boolean" },
        },
      },
      GuestMergeRecord: {
        type: "object",
        additionalProperties: false,
        required: ["fingerprint", "recordId", "recordType", "state", "trackId", "version"],
        properties: {
          fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
          recordId: { type: "string" },
          recordType: { type: "string", enum: ["active_track", "training_session_summary", "training_session_result", "training_attempt", "review_queue_entry", "goal", "learning_plan"] },
          state: { type: "object", additionalProperties: true },
          trackId: { type: "string" },
          version: { type: "integer", minimum: 0 },
        },
      },
      AdoptionConfirmationRequest: {
        type: "object",
        additionalProperties: false,
        required: ["deviceId", "snapshot", "confirmation"],
        properties: {
          deviceId: { type: "string", format: "uuid" },
          snapshot: { "$ref": "#/components/schemas/GuestMergeSnapshot" },
          confirmation: {
            type: "object",
            additionalProperties: false,
            required: ["operationId", "previewFingerprint", "protocolVersion", "resolutions"],
            properties: {
              operationId: { type: "string", format: "uuid" },
              previewFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
              protocolVersion: { type: "integer", enum: [1, 2] },
              resolutions: { type: "array", maxItems: 1000, items: { type: "object", additionalProperties: false, required: ["conflictId", "resolution"], properties: { conflictId: { type: "string" }, resolution: { type: "string", enum: ["keep_guest", "keep_account", "manual_required"] } } } },
              groupChoices: { type: "array", maxItems: 1000, items: { type: "object", additionalProperties: false, required: ["groupId", "resolution"], properties: { groupId: { type: "string" }, resolution: { type: "string", enum: ["keep_guest", "keep_account"] } } } },
            },
          },
        },
      },
      AdoptionTransferStart: {
        type: "object",
        additionalProperties: false,
        required: ["idempotencyKey", "guestUserId", "snapshotVersion", "deviceId"],
        properties: {
          protocolVersion: { type: "integer", const: 3, default: 3 },
          canonicalVersion: { type: "string", const: "canonical-json-v1", default: "canonical-json-v1" },
          sessionId: { type: "string", minLength: 1, maxLength: 128 },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
          guestUserId: { type: "string", format: "uuid" },
          snapshotVersion: { type: "integer", minimum: 0 },
          expectedGeneration: { type: "integer", minimum: 0, default: 0 },
          deviceId: { type: "string", format: "uuid" },
          activeSession: { type: "boolean", default: false },
          pendingJournal: { type: "boolean", default: false },
        },
      },
      AdoptionTransferRecord: {
        type: "object",
        additionalProperties: false,
        required: ["recordType", "recordId", "trackId", "fingerprint", "state", "version"],
        properties: {
          recordType: { type: "string", minLength: 1, maxLength: 128 },
          recordId: { type: "string", minLength: 1, maxLength: 256 },
          trackId: { type: "string", minLength: 1, maxLength: 128 },
          fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
          state: { type: "object", additionalProperties: true },
          version: { type: "integer", minimum: 0 },
        },
      },
      AdoptionTransferChunk: {
        type: "object",
        additionalProperties: false,
        required: ["chunkId", "index", "recordKeys", "fingerprint", "bytes"],
        properties: {
          chunkId: { type: "string", minLength: 1, maxLength: 128 },
          index: { type: "integer", minimum: 0 },
          recordKeys: { type: "array", maxItems: 450, items: { type: "string", minLength: 1 } },
          fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
          bytes: { type: "integer", minimum: 0, maximum: 524288 },
        },
      },
      AdoptionTransferUpload: {
        type: "object",
        additionalProperties: false,
        required: ["deviceId", "chunk", "records"],
        properties: {
          canonicalVersion: { type: "string", const: "canonical-json-v1", default: "canonical-json-v1" },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
          deviceId: { type: "string", format: "uuid" },
          chunk: { "$ref": "#/components/schemas/AdoptionTransferChunk" },
          records: { type: "array", maxItems: 450, items: { "$ref": "#/components/schemas/AdoptionTransferRecord" } },
        },
      },
      AdoptionTransferSeal: {
        type: "object",
        additionalProperties: false,
        required: ["deviceId", "snapshotFingerprint", "recordCount", "chunkCount"],
        properties: {
          canonicalVersion: { type: "string", const: "canonical-json-v1", default: "canonical-json-v1" },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
          deviceId: { type: "string", format: "uuid" },
          snapshotFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
          recordCount: { type: "integer", minimum: 0, maximum: 1000 },
          chunkCount: { type: "integer", minimum: 0, maximum: 1000 },
        },
      },
      AdoptionTransferPreview: {
        type: "object",
        additionalProperties: false,
        required: ["deviceId"],
        properties: {
          canonicalVersion: { type: "string", const: "canonical-json-v1", default: "canonical-json-v1" },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
          deviceId: { type: "string", format: "uuid" },
          protocolVersion: { type: "integer", enum: [1, 2], default: 2 },
        },
      },
      AdoptionTransferConfirm: {
        type: "object",
        additionalProperties: false,
        required: ["deviceId", "previewFingerprint", "protocolVersion", "resolutions"],
        properties: {
          canonicalVersion: { type: "string", const: "canonical-json-v1", default: "canonical-json-v1" },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
          deviceId: { type: "string", format: "uuid" },
          operationId: { type: "string", format: "uuid" },
          previewFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
          decisionFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
          protocolVersion: { type: "integer", enum: [1, 2] },
          resolutions: { type: "array", maxItems: 1000, items: { type: "object", additionalProperties: false, required: ["conflictId", "resolution"], properties: { conflictId: { type: "string" }, resolution: { type: "string", enum: ["keep_guest", "keep_account", "manual_required"] } } } },
          groupChoices: { type: "array", maxItems: 1000, items: { type: "object", additionalProperties: false, required: ["groupId", "resolution"], properties: { groupId: { type: "string" }, resolution: { type: "string", enum: ["keep_guest", "keep_account"] } } } },
        },
      },
      AdoptionTransferApply: {
        type: "object",
        additionalProperties: false,
        required: ["deviceId"],
        properties: {
          canonicalVersion: { type: "string", const: "canonical-json-v1", default: "canonical-json-v1" },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
          deviceId: { type: "string", format: "uuid" },
          decisionFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
          expectedGeneration: { type: "integer", minimum: 0 },
        },
      },
      AdoptionTransferStatus: {
        type: "object",
        additionalProperties: false,
        required: ["version", "accountId", "sessionId", "state", "recordCount", "chunkCount", "generation"],
        properties: {
          version: { type: "integer", const: 3 },
          accountId: { type: "string" },
          sessionId: { type: "string" },
          guestUserId: { type: "string" },
          state: { type: "string", enum: ["collecting", "sealing", "sealed", "result_building", "preview_ready", "applying", "complete", "failed"] },
          expectedGeneration: { type: "integer", minimum: 0 },
          generation: { type: "integer", minimum: 0 },
          recordCount: { type: "integer", minimum: 0, maximum: 1000 },
          chunkCount: { type: "integer", minimum: 0, maximum: 1000 },
          snapshotFingerprint: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] },
          previewFingerprint: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] },
          operationId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
          decisionFingerprint: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] },
          targetGeneration: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
          applyCursor: { type: "integer", minimum: 0 },
          applyTotal: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
          accountRevision: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
          failureCode: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
      EmptyRequest: { type: "object", additionalProperties: false },
      OperationRequest: { type: "object", additionalProperties: false, required: ["operationId"], properties: { operationId: { type: "string", format: "uuid" } } },
      RecoveryCodeConsumeRequest: { type: "object", additionalProperties: false, required: ["code"], properties: { code: { type: "string", pattern: "^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$" } } },
      CreateAccountPrivacyRequest: { type: "object", additionalProperties: false, required: ["right"], properties: { right: { "$ref": "#/components/schemas/PrivacyRight" }, narrative: { type: "string", minLength: 1, maxLength: 2000 } } },
      CreatePublicPrivacyRequest: { type: "object", additionalProperties: false, required: ["email", "right"], properties: { email: { type: "string", format: "email", maxLength: 320 }, right: { "$ref": "#/components/schemas/PrivacyRight" }, narrative: { type: "string", minLength: 1, maxLength: 2000 }, reportSubmissionIds: { type: "array", maxItems: 10, items: { type: "string", format: "uuid" } } } },
      PrivacyRight: { type: "string", enum: ["access", "rectification", "erasure", "restriction", "objection", "portability", "consent_withdrawal"] },
      PrivacyTokenExchange: { type: "object", additionalProperties: false, required: ["token"], properties: { token: { type: "string", minLength: 32, maxLength: 512 } } },
      PublicPrivacySession: { type: "object", additionalProperties: false, required: ["sessionToken"], properties: { sessionToken: { type: "string", minLength: 32, maxLength: 512 } } },
      PublicDeletionStatus: { type: "object", additionalProperties: false, required: ["operationId", "operationSecret"], properties: { operationId: { type: "string", format: "uuid" }, operationSecret: { type: "string", pattern: "^[a-f0-9]{64}$" } } },
      PrivacyRequestAdminAction: { oneOf: [
        { type: "object", additionalProperties: false, required: ["action", "reason", "expectedRevision"], properties: { action: { const: "require_verification" }, reason: { type: "string", minLength: 1, maxLength: 2000 }, expectedRevision: { type: "integer", minimum: 0 } } },
        { type: "object", additionalProperties: false, required: ["action", "reason", "expectedRevision"], properties: { action: { const: "verify_subject" }, reason: { type: "string", minLength: 1, maxLength: 2000 }, expectedRevision: { type: "integer", minimum: 0 } } },
        { type: "object", additionalProperties: false, required: ["action", "expectedRevision"], properties: { action: { const: "start_review" }, expectedRevision: { type: "integer", minimum: 0 } } },
        { type: "object", additionalProperties: false, required: ["action", "expectedRevision"], properties: { action: { const: "execute_export" }, expectedRevision: { type: "integer", minimum: 0 } } },
        { type: "object", additionalProperties: false, required: ["action", "reason", "noticeLocale", "expectedRevision"], properties: { action: { const: "extend" }, reason: { type: "string", minLength: 1, maxLength: 2000 }, noticeLocale: { type: "string", enum: ["pl", "en"] }, expectedRevision: { type: "integer", minimum: 0 } } },
        { type: "object", additionalProperties: false, required: ["action", "expectedRevision"], properties: { action: { const: "retry_extension_notice" }, expectedRevision: { type: "integer", minimum: 0 } } },
        { type: "object", additionalProperties: false, required: ["action", "outcome", "response", "reason", "complaintInformationIncluded", "executionEvidence", "expectedRevision"], properties: { action: { const: "prepare_response" }, outcome: { type: "string", enum: ["fulfilled", "partially_fulfilled", "refused"] }, response: { type: "string", minLength: 1, maxLength: 250000 }, reason: { type: "string", minLength: 1, maxLength: 2000 }, complaintInformationIncluded: { const: true }, executionEvidence: { type: "string", minLength: 1, maxLength: 512 }, expectedRevision: { type: "integer", minimum: 0 } } },
        { type: "object", additionalProperties: false, required: ["action", "expectedRevision"], properties: { action: { type: "string", enum: ["deliver", "close"] }, expectedRevision: { type: "integer", minimum: 0 } } },
      ] },
      AccountDataExport: {
        type: "object",
        additionalProperties: false,
        required: ["schemaVersion", "exportId", "exportedAt", "scope", "article15Information", "portable", "accountContext", "manifest"],
        properties: {
          schemaVersion: { type: "string", const: "account-data-export-v1" },
          exportId: { type: "string", pattern: "^export_[A-Za-z0-9_-]{32}$" },
          exportedAt: { type: "string", format: "date-time" },
          scope: { type: "object", additionalProperties: false, required: ["portable", "accountContext"], properties: { portable: { type: "string", const: "user_data_and_activity" }, accountContext: { type: "string", const: "user_visible_account_context" } } },
          article15Information: { type: "object", additionalProperties: false, required: ["purposes", "dataCategories", "recipientCategories", "retentionCriteria", "dataSources", "internationalTransfers", "automatedDecisionMaking", "rightsAndComplaint"], properties: { purposes: { type: "array", items: { type: "string" } }, dataCategories: { type: "array", items: { type: "string" } }, recipientCategories: { type: "array", items: { type: "string" } }, retentionCriteria: { type: "array", items: { type: "string" } }, dataSources: { type: "array", items: { type: "string" } }, internationalTransfers: { type: "string" }, automatedDecisionMaking: { type: "string" }, rightsAndComplaint: { type: "string" } } },
          portable: {
            type: "object",
            additionalProperties: false,
            required: ["profile", "progress", "linkedContentReports"],
            properties: {
              profile: { type: "object", additionalProperties: false, required: ["createdAt", "identity"], properties: { createdAt: { type: "string", format: "date-time" }, identity: { type: "object", additionalProperties: false, required: ["provider", "email", "emailVerified"], properties: { provider: { type: "string" }, email: { anyOf: [{ type: "string", format: "email" }, { type: "null" }] }, emailVerified: { type: "boolean" } } } } },
              progress: { type: "array", items: { "$ref": "#/components/schemas/AccountDataExportProgress" } },
              linkedContentReports: { type: "array", items: { "$ref": "#/components/schemas/AccountDataExportContentReport" } },
            },
          },
          accountContext: {
            type: "object",
            additionalProperties: false,
            required: ["trackAccess", "entitlements", "devices", "syncMetadata", "exportHistory"],
            properties: {
              trackAccess: { type: "array", items: { type: "object", additionalProperties: true } },
              entitlements: { type: "array", items: { type: "object", additionalProperties: true } },
              devices: { type: "array", items: { type: "object", additionalProperties: true } },
              syncMetadata: { type: "object", additionalProperties: true },
              exportHistory: { type: "array", items: { type: "object", additionalProperties: true } },
            },
          },
          manifest: { type: "object", additionalProperties: false, required: ["included", "omitted"], properties: { included: { type: "array", items: { type: "string" } }, omitted: { type: "array", items: { type: "object", additionalProperties: false, required: ["category", "reason"], properties: { category: { type: "string" }, reason: { type: "string" } } } } } },
        },
      },
      AccountDataExportProgress: { type: "object", additionalProperties: false, required: ["kind", "recordType", "trackId", "targetId", "version", "fingerprint", "state", "lastMutationId", "updatedAt"], properties: { kind: { type: "string", enum: ["node", "item"] }, recordType: { type: "string" }, trackId: { type: "string" }, targetId: { type: "string" }, version: { type: "integer", minimum: 0 }, fingerprint: { type: "string" }, state: { type: "object", additionalProperties: true }, lastMutationId: { type: "string" }, updatedAt: { type: "string", format: "date-time" } } },
      AccountDataExportContentReport: { type: "object", additionalProperties: false, required: ["id", "clientSubmissionId", "trackId", "contentVersion", "itemId", "reason", "description", "context", "linkage", "status", "createdAt", "updatedAt"], properties: { id: { type: "string" }, clientSubmissionId: { type: "string" }, trackId: { type: "string" }, contentVersion: { type: "string" }, itemId: { type: "string" }, reason: { type: "string" }, description: { type: "string" }, context: { type: "object", additionalProperties: true }, linkage: { type: "string", enum: ["account", "account_and_contact"] }, status: { type: "string" }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" } } },
      CreateContentReport: {
        type: "object",
        additionalProperties: false,
        required: ["clientSubmissionId", "trackId", "contentVersion", "itemId", "reason", "description", "context"],
        properties: {
          clientSubmissionId: { type: "string", format: "uuid" },
          trackId: { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9._:/-]+$" },
          contentVersion: { type: "string", minLength: 1, maxLength: 128 },
          itemId: { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9._:/-]+$" },
          reason: { type: "string", enum: ["incorrect_answer", "unclear_explanation", "outdated_content", "technical_issue", "other"] },
          description: { type: "string", maxLength: 280, description: "Optional note. Blank input is stored as a neutral fixed description; obvious contact data, URLs, passwords and codes are rejected." },
          context: { "$ref": "#/components/schemas/ContentReportContext" },
          linkAccount: { type: "boolean", default: false, description: "Explicit opt-in to attach the authenticated Patternly account identifier." },
          contactEmail: { type: "string", format: "email", description: "Explicit opt-in contact address; never inferred from authentication." },
        },
      },
      ContentReportContext: {
        type: "object",
        additionalProperties: false,
        required: ["releasePackageId", "trackNode", "modeRoute", "locale", "appBuild", "platform", "occurredAt"],
        properties: {
          releasePackageId: { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9._:/-]+$" },
          trackNode: { anyOf: [{ type: "string", minLength: 1, maxLength: 128 }, { type: "null" }] },
          modeRoute: { type: "string", enum: ["practice_feedback_details", "answer_review"] },
          locale: { type: "string", enum: ["en", "pl"] },
          appBuild: { type: "string", minLength: 1, maxLength: 32 },
          platform: { type: "string", enum: ["ios", "android"] },
          occurredAt: { type: "string", format: "date-time" },
        },
      },
      TransitionContentReport: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: { status: { type: "string", enum: ["open", "in_review", "resolved", "closed"] } },
      },
    },
  },
};

type OpenApiRecord = Record<string, unknown>;

const errorEnvelopeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code"],
      properties: {
        code: { type: "string", minLength: 1 },
        correlationId: { type: "string", format: "uuid" },
        issues: { type: "array", items: { type: "string" } },
        reason: { type: "string", minLength: 1 },
        currentAccountRevision: { type: "integer", minimum: 0 },
      },
    },
  },
} as const;

const jsonResponse = (description: string, schema: OpenApiRecord) => ({
  description,
  content: { "application/json": { schema } },
});

const ref = (name: string) => ({ "$ref": `#/components/schemas/${name}` });

const objectSchema = (properties: OpenApiRecord, required: readonly string[] = [], additionalProperties: boolean | OpenApiRecord = false) => ({
  type: "object",
  additionalProperties,
  ...(required.length === 0 ? {} : { required: [...required] }),
  properties,
});

/** Dynamic values are used only for user-authored progress/question state. */
const opaqueObjectSchema = objectSchema({}, [], true);
const progressRecordSchema = objectSchema({
  kind: { type: "string", enum: ["node", "item"] },
  recordType: { type: "string", enum: ["active_track", "training_session_summary", "training_session_result", "training_attempt", "review_queue_entry", "goal", "learning_plan"] },
  trackId: { type: "string", minLength: 1, maxLength: 128 },
  targetId: { type: "string", minLength: 1, maxLength: 256 },
  version: { type: "integer", minimum: 0 },
  fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
  state: opaqueObjectSchema,
  lastMutationId: { type: "string", minLength: 16, maxLength: 128 },
  updatedAt: { type: "string", format: "date-time" },
}, ["kind", "recordType", "trackId", "targetId", "version", "fingerprint", "state", "lastMutationId", "updatedAt"]);
const guestMergeRecordSchema = objectSchema({
  fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
  recordId: { type: "string", minLength: 1, maxLength: 256 },
  recordType: { type: "string", enum: ["active_track", "training_session_summary", "training_session_result", "training_attempt", "review_queue_entry", "goal", "learning_plan"] },
  state: opaqueObjectSchema,
  trackId: { type: "string", minLength: 1, maxLength: 128 },
  version: { type: "integer", minimum: 0 },
}, ["fingerprint", "recordId", "recordType", "state", "trackId", "version"]);
const guestMergeConflictSchema = objectSchema({
  accountVersion: { type: "integer", minimum: 0 },
  conflictId: { type: "string", minLength: 1, maxLength: 768 },
  guestVersion: { type: "integer", minimum: 0 },
  recordId: { type: "string", minLength: 1, maxLength: 256 },
  recordType: { type: "string", enum: ["active_track", "training_session_summary", "training_session_result", "training_attempt", "review_queue_entry", "goal", "learning_plan"] },
}, ["accountVersion", "conflictId", "guestVersion", "recordId", "recordType"]);
const adoptionPreviewSchema = objectSchema({
  accountSnapshotVersion: { type: "integer", minimum: 0 },
  accountUserId: { type: "string", format: "uuid" },
  conflicts: { type: "array", maxItems: 1000, items: guestMergeConflictSchema },
  fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
  guestSnapshotVersion: { type: "integer", minimum: 0 },
  guestUserId: { type: "string", format: "uuid" },
  operationId: { type: "string", format: "uuid" },
  protocolVersion: { type: "integer", enum: [1, 2] },
  goalPlanConflictGroups: { type: "array", maxItems: 1000, items: objectSchema({
    groupId: { type: "string", pattern: "^track:.+", maxLength: 192 },
    trackId: { type: "string", minLength: 1, maxLength: 128 },
    localRecordIds: { type: "array", maxItems: 2, items: { type: "string" } },
    accountRecordIds: { type: "array", maxItems: 2, items: { type: "string" } },
  }, ["groupId", "trackId", "localRecordIds", "accountRecordIds"]) },
}, ["accountSnapshotVersion", "accountUserId", "conflicts", "fingerprint", "guestSnapshotVersion", "guestUserId", "operationId", "protocolVersion"]);
const adoptionPlanSchema = objectSchema({
  caseId: { type: "string", enum: ["emptyLocalEmptyRemote", "populatedLocalEmptyRemote", "emptyLocalPopulatedRemote", "populatedLocalPopulatedRemote", "divergentRecord", "blocked"] },
  localRecordCount: { type: "integer", minimum: 0 },
  remoteRecordCount: { type: "integer", minimum: 0 },
  uploadRecordIds: { type: "array", items: { type: "string" } },
  restoreRecordIds: { type: "array", items: { type: "string" } },
  deduplicatedRecordIds: { type: "array", items: { type: "string" } },
  conflictRecordIds: { type: "array", items: { type: "string" } },
  blockingReason: { anyOf: [{ type: "string", enum: ["active_session", "journal_recovery"] }, { type: "null" }] },
}, ["caseId", "localRecordCount", "remoteRecordCount", "uploadRecordIds", "restoreRecordIds", "deduplicatedRecordIds", "conflictRecordIds", "blockingReason"]);
const userProfileSchema = objectSchema({
  id: { type: "string", format: "uuid" },
  createdAt: { type: "string", format: "date-time" },
  acceptedTermsVersion: { anyOf: [{ type: "string" }, { type: "null" }] },
  identity: objectSchema({ provider: { type: "string", minLength: 1 }, subject: { type: "string", minLength: 1 }, email: { anyOf: [{ type: "string", format: "email" }, { type: "null" }] }, emailVerified: { type: "boolean" } }, ["provider", "subject", "email", "emailVerified"]),
}, ["id", "createdAt", "acceptedTermsVersion", "identity"]);
const entitlementSchema = objectSchema({ entitlement: { type: "string", minLength: 1 }, status: { type: "string", minLength: 1 }, source: { type: "string", minLength: 1 }, expiresAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, updatedAt: { type: "string", format: "date-time" } }, ["entitlement", "status", "source", "expiresAt", "updatedAt"]);
const trackAccessSchema = objectSchema({ trackId: { type: "string", minLength: 1 }, source: { type: "string", minLength: 1 }, status: { type: "string", minLength: 1 }, updatedAt: { type: "string", format: "date-time" } }, ["trackId", "source", "status", "updatedAt"]);
const contentVersionSchema = objectSchema({ trackId: { type: "string", minLength: 1 }, version: { type: "string", minLength: 1 }, checksumSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, packageUri: { type: "string", minLength: 1 }, publishedAt: { type: "string", format: "date-time" } }, ["trackId", "version", "checksumSha256", "packageUri", "publishedAt"]);
const contentReportSchema = objectSchema({
  id: { type: "string", format: "uuid" },
  clientSubmissionId: { type: "string", format: "uuid" },
  trackId: { type: "string", minLength: 1, maxLength: 256 },
  contentVersion: { type: "string", minLength: 1, maxLength: 128 },
  itemId: { type: "string", minLength: 1, maxLength: 256 },
  reason: { type: "string", enum: ["incorrect_answer", "unclear_explanation", "outdated_content", "technical_issue", "other"] },
  description: { type: "string", maxLength: 280 },
  context: ref("ContentReportContext"),
  linkage: { type: "string", enum: ["unlinked", "account", "contact", "account_and_contact"] },
  status: { type: "string", enum: ["open", "in_review", "resolved", "closed"] },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
}, ["id", "clientSubmissionId", "trackId", "contentVersion", "itemId", "reason", "description", "context", "linkage", "status", "createdAt", "updatedAt"]);
const privacyRequestDetailsSchema = objectSchema({
  requestId: { type: "string", pattern: "^pr_[0-9a-f-]{36}$" },
  right: ref("PrivacyRight"),
  channel: { type: "string", enum: ["account", "public"] },
  status: { type: "string", enum: ["received", "identity_verification_required", "in_review", "response_ready", "fulfilled", "partially_fulfilled", "refused", "closed"] },
  outcome: { anyOf: [{ type: "string", enum: ["fulfilled", "partially_fulfilled", "refused"] }, { type: "null" }] },
  receivedAt: { type: "string", format: "date-time" },
  deadlineAt: { type: "string", format: "date-time" },
  deliveredAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
  extendedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
  revision: { type: "integer", minimum: 0 },
  narrative: { anyOf: [{ type: "string" }, { type: "null" }] },
  reportSubmissionIds: { type: "array", items: { type: "string", format: "uuid" } },
  reason: { anyOf: [{ type: "string" }, { type: "null" }] },
  executionEvidence: { anyOf: [{ type: "string" }, { type: "null" }] },
  responseAvailableUntil: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
  subjectVerified: { type: "boolean" },
  extensionNoticeStatus: { anyOf: [{ type: "string", enum: ["available_in_app", "pending", "delivered", "failed"] }, { type: "null" }] },
}, ["requestId", "right", "channel", "status", "outcome", "receivedAt", "deadlineAt", "deliveredAt", "extendedAt", "revision", "narrative", "reportSubmissionIds", "reason", "executionEvidence", "responseAvailableUntil", "subjectVerified", "extensionNoticeStatus"]);
const adminOverviewSchema = objectSchema({
  observedAt: { type: "string", format: "date-time" },
  content: objectSchema({ publishedTracks: { type: "integer", minimum: 0 }, tracks: { type: "array", items: objectSchema({ trackId: { type: "string" }, version: { type: "string" }, questionCount: { type: "integer", minimum: 0 } }, ["trackId", "version", "questionCount"]) }, questionCount: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] } }, ["publishedTracks", "tracks", "questionCount"]),
  questionBank: { oneOf: [objectSchema({ status: { type: "string", const: "available" }, releaseId: { type: "string" } }, ["status", "releaseId"]), objectSchema({ status: { type: "string", const: "unavailable" }, reason: { type: "string", enum: ["canonical_package_inspection_not_configured", "configured_release_unavailable", "configured_release_invalid"] } }, ["status", "reason"]) ] },
  usage: objectSchema({ accounts: { type: "integer", minimum: 0 }, progressRecords: { type: "integer", minimum: 0 }, trainingAttempts: { type: "integer", minimum: 0 }, reviewQueueEntries: { type: "integer", minimum: 0 } }, ["accounts", "progressRecords", "trainingAttempts", "reviewQueueEntries"]),
  reports: objectSchema({ open: { type: "integer", minimum: 0 }, in_review: { type: "integer", minimum: 0 }, resolved: { type: "integer", minimum: 0 }, closed: { type: "integer", minimum: 0 } }, ["open", "in_review", "resolved", "closed"]),
}, ["observedAt", "content", "questionBank", "usage", "reports"]);
const adminQuestionsSchema = objectSchema({ questions: { type: "array", items: opaqueObjectSchema }, total: { type: "integer", minimum: 0 }, page: { type: "integer", minimum: 1 }, pageSize: { type: "integer", minimum: 1, maximum: 100 }, trackId: { anyOf: [{ type: "string" }, { type: "null" }] } }, ["questions", "total", "page", "pageSize", "trackId"]);

const successSchemas: Readonly<Record<string, OpenApiRecord>> = {
  "GET /health": objectSchema({ status: { type: "string", const: "ok" }, service: { type: "string", const: "patternly-backend" } }, ["status", "service"]),
  "GET /ready": objectSchema({ status: { type: "string", enum: ["ready", "not_ready"] }, checks: objectSchema({ database: { type: "boolean" }, authentication: { type: "boolean" } }, ["database", "authentication"]) }, ["status", "checks"]),
  "GET /openapi.json": objectSchema({ openapi: { type: "string", minLength: 1 }, paths: objectSchema({}, [], true) }, ["openapi", "paths"], true),
  "POST /v1/webhooks/revenuecat": objectSchema({ outcome: { type: "string", minLength: 1 }, duplicate: { type: "boolean" } }, ["outcome", "duplicate"]),
  "GET /v1/me": objectSchema({ user: userProfileSchema }, ["user"]),
  "POST /v1/legal-acceptances": objectSchema({ acceptance: objectSchema({ termsVersion: { type: "string" }, acceptedAt: { type: "string", format: "date-time" } }, ["termsVersion", "acceptedAt"]) }, ["acceptance"]),
  "POST /v1/purchase-confirmations": objectSchema({ confirmation: objectSchema({ confirmationId: { type: "string", format: "uuid" }, acceptedAt: { type: "string", format: "date-time" }, attemptExpiresAt: { type: "string", format: "date-time" } }, ["confirmationId", "acceptedAt", "attemptExpiresAt"]) }, ["confirmation"]),
  "GET /v1/entitlements": objectSchema({ entitlements: { type: "array", items: entitlementSchema } }, ["entitlements"]),
  "GET /v1/progress": objectSchema({ accountRevision: { type: "integer", minimum: 0 }, generation: { type: "integer", minimum: 0 }, records: { type: "array", items: progressRecordSchema }, nextPageToken: { anyOf: [{ type: "string" }, { type: "null" }] } }, ["accountRevision", "generation", "records"]),
  "GET /v1/account-data/export": ref("AccountDataExport"),
  "POST /v1/privacy-requests": objectSchema({ request: ref("PrivacyRequestListItem") }, ["request"]),
  "GET /v1/privacy-requests": objectSchema({ requests: { type: "array", items: ref("PrivacyRequestListItem") } }, ["requests"]),
  "GET /v1/privacy-requests/{requestId}": ref("PrivacyRequestResponse"),
  "POST /v1/public/privacy-requests": objectSchema({ status: { type: "string", const: "accepted" } }, ["status"]),
  "POST /v1/public/privacy-requests/{requestId}/session": ref("PublicPrivacySession"),
  "POST /v1/public/privacy-requests/{requestId}/response": ref("PrivacyRequestResponse"),
  "POST /v1/legal-requests": objectSchema({ request: ref("LegalRequest") }, ["request"]),
  "GET /v1/legal-requests": objectSchema({ requests: { type: "array", items: ref("LegalRequest") } }, ["requests"]),
  "GET /v1/legal-requests/{requestId}": objectSchema({ request: ref("LegalRequest") }, ["request"]),
  "POST /v1/public/legal-requests": objectSchema({ request: ref("LegalRequest") }, ["request"]),
  "POST /v1/progress/sync": ref("SyncResponse"),
  "POST /v1/account-data/adoption/preview": ref("AdoptionPreviewResponse"),
  "POST /v1/account-data/adoption/confirm": ref("AdoptionExecutionResponse"),
  "POST /v3/account-data/adoption/start": ref("AdoptionTransferStatus"),
  "POST /v3/account-data/adoption/{sessionId}/upload": ref("AdoptionTransferStatus"),
  "POST /v3/account-data/adoption/{sessionId}/seal": ref("AdoptionTransferStatus"),
  "POST /v3/account-data/adoption/{sessionId}/preview": ref("AdoptionTransferPreviewResponse"),
  "POST /v3/account-data/adoption/{sessionId}/confirm": ref("AdoptionTransferStatus"),
  "POST /v3/account-data/adoption/{sessionId}/apply": ref("AdoptionTransferStatus"),
  "GET /v3/account-data/adoption/{sessionId}/status": ref("AdoptionTransferStatus"),
  "POST /v1/account/recovery-codes": objectSchema({ generationId: { type: "string" }, codes: { type: "array", items: { type: "string" } } }, ["generationId", "codes"]),
  "POST /v1/public/recovery-codes/consume": objectSchema({ customToken: { type: "string", minLength: 1 } }, ["customToken"]),
  "POST /v1/account/session/revoke": objectSchema({ status: { type: "string", const: "revoked" }, operationId: { type: "string", format: "uuid" } }, ["status", "operationId"]),
  "POST /v1/account/deletion": objectSchema({ status: { type: "string", const: "deleted" }, operationId: { type: "string", format: "uuid" }, proofId: { type: "string", minLength: 1 } }, ["status", "operationId", "proofId"]),
  "GET /v1/public/deletion-proofs/{proofId}": objectSchema({ status: { type: "string", const: "deleted" }, operationId: { type: "string", format: "uuid" }, proofId: { type: "string", minLength: 1 } }, ["status", "operationId", "proofId"]),
  "POST /v1/public/deletion-operations/status": ref("DeletionOperationStatus"),
  "GET /v1/tracks": objectSchema({ tracks: { type: "array", items: trackAccessSchema } }, ["tracks"]),
  "GET /v1/content/versions": objectSchema({ versions: { type: "array", items: contentVersionSchema } }, ["versions"]),
  "POST /v1/content/reports": ref("ContentReportResponse"),
  "GET /v1/admin/content-reports": ref("AdminContentReportsResponse"),
  "GET /v1/admin/privacy-requests": objectSchema({ requests: { type: "array", items: ref("PrivacyRequestListItem") } }, ["requests"]),
  "GET /v1/admin/privacy-requests/{requestId}": objectSchema({ request: privacyRequestDetailsSchema }, ["request"]),
  "PATCH /v1/admin/privacy-requests/{requestId}": objectSchema({ request: privacyRequestDetailsSchema }, ["request"]),
  "GET /v1/admin/legal-requests": objectSchema({ requests: { type: "array", items: ref("LegalRequest") } }, ["requests"]),
  "GET /v1/admin/legal-requests/{requestId}": ref("AdminLegalRequestDetails"),
  "PATCH /v1/admin/legal-requests/{requestId}": objectSchema({ request: ref("LegalRequest") }, ["request"]),
  "POST /v1/admin/security-incidents": ref("SecurityIncidentResponse"),
  "GET /v1/admin/security-incidents": ref("SecurityIncidentListResponse"),
  "GET /v1/admin/security-incidents/{incidentId}": ref("SecurityIncidentResponse"),
  "GET /v1/admin/security-incidents/{incidentId}/authority-exports/{version}": objectSchema({ payload: { type: "string", minLength: 1 }, digest: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" }, version: { type: "integer", minimum: 1 } }, ["payload", "digest", "version"]),
  "PATCH /v1/admin/security-incidents/{incidentId}": ref("SecurityIncidentResponse"),
  "GET /v1/admin/overview": adminOverviewSchema,
  "GET /v1/admin/questions": adminQuestionsSchema,
  "PATCH /v1/admin/content-reports/{clientSubmissionId}": ref("ContentReportResponse"),
};

const requestSchemas: Readonly<Record<string, OpenApiRecord>> = {
  "POST /v1/webhooks/revenuecat": objectSchema({ event: objectSchema({}, [], true) }, ["event"], false),
  "POST /v1/legal-acceptances": objectSchema({ termsVersion: { type: "string", pattern: "^[A-Za-z0-9._-]{1,80}$" }, minimumAgeConfirmed: { type: "integer", const: 18 } }, ["termsVersion", "minimumAgeConfirmed"]),
  "POST /v1/purchase-confirmations": objectSchema({ confirmationId: { type: "string", format: "uuid" }, termsVersion: { type: "string", pattern: "^[A-Za-z0-9._-]{1,80}$" }, productIdentifier: { type: "string", minLength: 1, maxLength: 200 }, storefrontPrice: { type: "string", minLength: 1, maxLength: 80 }, locale: { type: "string", enum: ["en", "pl"] }, immediateStartRequested: { type: "boolean", const: true } }, ["confirmationId", "termsVersion", "productIdentifier", "storefrontPrice", "locale", "immediateStartRequested"]),
  "POST /v1/privacy-requests": ref("CreateAccountPrivacyRequest"),
  "POST /v1/public/privacy-requests": ref("CreatePublicPrivacyRequest"),
  "POST /v1/public/privacy-requests/{requestId}/session": ref("PrivacyTokenExchange"),
  "POST /v1/public/privacy-requests/{requestId}/response": ref("PublicPrivacySession"),
  "POST /v1/legal-requests": ref("CreateLegalRequest"),
  "POST /v1/public/legal-requests": ref("CreatePublicLegalRequest"),
  "POST /v1/progress/sync": ref("SyncRequest"),
  "POST /v1/account-data/adoption/preview": ref("GuestMergeSnapshot"),
  "POST /v1/account-data/adoption/confirm": ref("AdoptionConfirmationRequest"),
  "POST /v3/account-data/adoption/start": ref("AdoptionTransferStart"),
  "POST /v3/account-data/adoption/{sessionId}/upload": ref("AdoptionTransferUpload"),
  "POST /v3/account-data/adoption/{sessionId}/seal": ref("AdoptionTransferSeal"),
  "POST /v3/account-data/adoption/{sessionId}/preview": ref("AdoptionTransferPreview"),
  "POST /v3/account-data/adoption/{sessionId}/confirm": ref("AdoptionTransferConfirm"),
  "POST /v3/account-data/adoption/{sessionId}/apply": ref("AdoptionTransferApply"),
  "POST /v1/account/recovery-codes": ref("EmptyRequest"),
  "POST /v1/public/recovery-codes/consume": ref("RecoveryCodeConsumeRequest"),
  "POST /v1/account/session/revoke": ref("OperationRequest"),
  "POST /v1/account/deletion": ref("AccountDeletionRequest"),
  "POST /v1/public/deletion-operations/status": ref("PublicDeletionStatus"),
  "POST /v1/content/reports": ref("CreateContentReport"),
  "PATCH /v1/admin/legal-requests/{requestId}": ref("LegalRequestAdminAction"),
  "PATCH /v1/admin/privacy-requests/{requestId}": ref("PrivacyRequestAdminAction"),
  "POST /v1/admin/security-incidents": ref("SecurityIncidentCreate"),
  "PATCH /v1/admin/security-incidents/{incidentId}": ref("SecurityIncidentAction"),
  "PATCH /v1/admin/content-reports/{clientSubmissionId}": ref("TransitionContentReport"),
};

function parameterSchema(name: string, path: string): OpenApiRecord {
  if (name === "requestId" && path.includes("/legal-requests/")) return { "$ref": "#/components/parameters/LegalRequestId" };
  if (name === "requestId") return { "$ref": "#/components/parameters/PrivacyRequestId" };
  if (name === "incidentId") return { "$ref": "#/components/parameters/SecurityIncidentId" };
  if (name === "sessionId") return { "$ref": "#/components/parameters/AdoptionTransferSessionId" };
  if (name === "version") return { name, in: "path", required: true, schema: { type: "integer", minimum: 1 } };
  if (name === "clientSubmissionId") return { name, in: "path", required: true, schema: { type: "string", format: "uuid" } };
  if (name === "proofId") return { name, in: "path", required: true, schema: { type: "string", pattern: "^proof_[A-Za-z0-9_-]{20,128}$" } };
  return { name, in: "path", required: true, schema: { type: "string", minLength: 1 } };
}

function parameterNames(path: string): readonly string[] {
  const names: string[] = [];
  const matcher = /\{([^}]+)\}/gu;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(path)) !== null) if (match[1] !== undefined && !names.includes(match[1])) names.push(match[1]);
  return names;
}

function enrichOpenApiDocument(document: OpenApiRecord): void {
  const components = document.components as OpenApiRecord;
  const schemas = components.schemas as OpenApiRecord;
  const parameters = components.parameters as OpenApiRecord;
  parameters.LegalRequestId ??= { name: "requestId", in: "path", required: true, schema: { type: "string", pattern: "^lr_[0-9a-f-]{36}$" } };
  schemas.ErrorEnvelope = errorEnvelopeSchema;
  schemas.PrivacyRequestListItem = objectSchema({ requestId: { type: "string", pattern: "^pr_[0-9a-f-]{36}$" }, right: ref("PrivacyRight"), channel: { type: "string", enum: ["account", "public"] }, status: { type: "string", enum: ["received", "identity_verification_required", "in_review", "response_ready", "fulfilled", "partially_fulfilled", "refused", "closed"] }, outcome: { anyOf: [{ type: "string", enum: ["fulfilled", "partially_fulfilled", "refused"] }, { type: "null" }] }, receivedAt: { type: "string", format: "date-time" }, deadlineAt: { type: "string", format: "date-time" }, deliveredAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, extendedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, revision: { type: "integer", minimum: 0 } }, ["requestId", "right", "channel", "status", "outcome", "receivedAt", "deadlineAt", "deliveredAt", "extendedAt", "revision"]);
  schemas.PrivacyRequestResponse = objectSchema({ request: ref("PrivacyRequestListItem"), response: { anyOf: [{ type: "string" }, { type: "null" }] }, responseAvailableUntil: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, extensionReason: { anyOf: [{ type: "string" }, { type: "null" }] }, complaintInformationIncluded: { type: "boolean" } }, ["request", "response", "responseAvailableUntil", "extensionReason", "complaintInformationIncluded"]);
  schemas.PrivacyRequestDetails = privacyRequestDetailsSchema;
  schemas.LegalRequest = objectSchema({ requestId: { type: "string", pattern: "^lr_[0-9a-f-]{36}$" }, kind: { type: "string", enum: ["complaint", "withdrawal", "data_recovery", "suspension_appeal"] }, status: { type: "string", enum: ["received", "in_review", "answered", "closed"] }, receivedAt: { type: "string", format: "date-time" }, responseDueAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, answeredAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, retentionUntil: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, response: { anyOf: [{ type: "string" }, { type: "null" }] }, legalHold: { type: "boolean" }, revision: { type: "integer", minimum: 0 } }, ["requestId", "kind", "status", "receivedAt", "responseDueAt", "answeredAt", "retentionUntil", "response", "legalHold", "revision"]);
  schemas.AdminLegalRequestDetails = objectSchema({ request: objectSchema({ requestId: { type: "string", pattern: "^lr_[0-9a-f-]{36}$" }, kind: { type: "string", enum: ["complaint", "withdrawal", "data_recovery", "suspension_appeal"] }, status: { type: "string", enum: ["received", "in_review", "answered", "closed"] }, receivedAt: { type: "string", format: "date-time" }, responseDueAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, answeredAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, retentionUntil: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, response: { anyOf: [{ type: "string" }, { type: "null" }] }, legalHold: { type: "boolean" }, revision: { type: "integer", minimum: 0 }, email: { type: "string", format: "email" }, narrative: { anyOf: [{ type: "string" }, { type: "null" }] }, transactionId: { anyOf: [{ type: "string", maxLength: 128 }, { type: "null" }] } }, ["requestId", "kind", "status", "receivedAt", "responseDueAt", "answeredAt", "retentionUntil", "response", "legalHold", "revision", "email", "narrative", "transactionId"]) }, ["request"]);
  const legalNarrative = { type: "string", minLength: 1, maxLength: 4_000 };
  const legalTransactionId = { type: "string", minLength: 1, maxLength: 128 };
  schemas.CreateLegalRequest = { oneOf: [
    objectSchema({ kind: { const: "complaint" }, narrative: legalNarrative, transactionId: legalTransactionId }, ["kind", "narrative"]),
    objectSchema({ kind: { const: "withdrawal" }, narrative: legalNarrative, transactionId: legalTransactionId }, ["kind"]),
    objectSchema({ kind: { const: "data_recovery" }, narrative: legalNarrative, transactionId: legalTransactionId }, ["kind", "narrative"]),
    objectSchema({ kind: { const: "suspension_appeal" }, narrative: legalNarrative, transactionId: legalTransactionId }, ["kind", "narrative"]),
  ] };
  schemas.CreatePublicLegalRequest = { oneOf: [
    objectSchema({ email: { type: "string", format: "email", maxLength: 320 }, kind: { const: "complaint" }, narrative: legalNarrative, transactionId: legalTransactionId }, ["email", "kind", "narrative"]),
    objectSchema({ email: { type: "string", format: "email", maxLength: 320 }, kind: { const: "withdrawal" }, narrative: legalNarrative, transactionId: legalTransactionId }, ["email", "kind"]),
    objectSchema({ email: { type: "string", format: "email", maxLength: 320 }, kind: { const: "data_recovery" }, narrative: legalNarrative, transactionId: legalTransactionId }, ["email", "kind", "narrative"]),
    objectSchema({ email: { type: "string", format: "email", maxLength: 320 }, kind: { const: "suspension_appeal" }, narrative: legalNarrative, transactionId: legalTransactionId }, ["email", "kind", "narrative"]),
  ] };
  schemas.AccountDeletionRequest = objectSchema({ operationId: { type: "string", format: "uuid" }, operationSecret: { type: "string", pattern: "^[a-f0-9]{64}$" } }, ["operationId", "operationSecret"]);
  schemas.LegalRequestAdminAction = { oneOf: [
    objectSchema({ action: { const: "start_review" }, expectedRevision: { type: "integer", minimum: 0 } }, ["action", "expectedRevision"]),
    objectSchema({ action: { const: "answer" }, expectedRevision: { type: "integer", minimum: 0 }, response: { type: "string", minLength: 1, maxLength: 50_000 } }, ["action", "expectedRevision", "response"]),
    objectSchema({ action: { const: "close" }, expectedRevision: { type: "integer", minimum: 0 } }, ["action", "expectedRevision"]),
    objectSchema({ action: { const: "set_legal_hold" }, expectedRevision: { type: "integer", minimum: 0 }, active: { type: "boolean" }, reason: { type: "string", minLength: 1, maxLength: 1_000 } }, ["action", "expectedRevision", "active", "reason"]),
  ] };
  const progressConflictSchema = objectSchema({ mutationId: { type: "string", minLength: 16, maxLength: 128 }, code: { const: "version_conflict" }, current: { anyOf: [progressRecordSchema, { type: "null" }] } }, ["mutationId", "code", "current"]);
  schemas.SyncResponse = objectSchema({ accountRevision: { type: "integer", minimum: 0 }, applied: { type: "array", items: progressRecordSchema }, duplicates: { type: "array", items: { type: "string" } }, conflicts: { type: "array", items: progressConflictSchema }, accountRevisionConflict: { anyOf: [{ type: "object", additionalProperties: false, required: ["code", "currentAccountRevision"], properties: { code: { type: "string", const: "account_revision_conflict" }, currentAccountRevision: { type: "integer", minimum: 0 } } }, { type: "null" }] } }, ["accountRevision", "applied", "duplicates", "conflicts"]);
  schemas.AdoptionPreviewResponse = objectSchema({ preview: adoptionPreviewSchema, plan: adoptionPlanSchema, remoteRecords: { type: "array", items: guestMergeRecordSchema } }, ["preview", "plan", "remoteRecords"]);
  schemas.AdoptionExecutionResponse = objectSchema({ accountRevision: { type: "integer", minimum: 0 }, operationId: { type: "string", format: "uuid" }, mutationIds: { type: "array", items: { type: "string", minLength: 1 } }, records: { type: "array", items: guestMergeRecordSchema } }, ["accountRevision", "operationId", "mutationIds", "records"]);
  schemas.AdoptionTransferPreviewResponse = objectSchema({ version: { type: "integer", const: 3 }, accountId: { type: "string" }, sessionId: { type: "string" }, guestUserId: { type: "string" }, state: { type: "string" }, expectedGeneration: { type: "integer", minimum: 0 }, generation: { type: "integer", minimum: 0 }, targetGeneration: { type: "integer", minimum: 0 }, recordCount: { type: "integer", minimum: 0 }, chunkCount: { type: "integer", minimum: 0 }, snapshotVersion: { type: "integer", minimum: 0 }, snapshotFingerprint: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] }, previewFingerprint: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] }, operationId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] }, decisionFingerprint: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] }, applyCursor: { type: "integer", minimum: 0 }, applyTotal: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] }, accountRevision: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] }, failureCode: { anyOf: [{ type: "string" }, { type: "null" }] }, preview: adoptionPreviewSchema, plan: adoptionPlanSchema, remoteRecords: { type: "array", items: guestMergeRecordSchema } }, ["version", "accountId", "sessionId", "guestUserId", "state", "expectedGeneration", "generation", "targetGeneration", "recordCount", "chunkCount", "snapshotVersion", "snapshotFingerprint", "previewFingerprint", "operationId", "decisionFingerprint", "applyCursor", "applyTotal", "accountRevision", "failureCode", "preview", "plan", "remoteRecords"]);
  schemas.DeletionOperationStatus = objectSchema({ status: { type: "string", enum: ["pending", "remote_deleted", "complete"] }, operationId: { type: "string", format: "uuid" }, proofId: { anyOf: [{ type: "string" }, { type: "null" }] } }, ["status", "operationId", "proofId"]);
  schemas.ContentReportResponse = objectSchema({ report: contentReportSchema, duplicate: { type: "boolean" } }, ["report", "duplicate"]);
  schemas.AdminContentReportsResponse = objectSchema({ reports: { type: "array", items: contentReportSchema } }, ["reports"]);

  const paths = document.paths as OpenApiRecord;
  for (const [path, pathItemValue] of Object.entries(paths)) {
    const pathItem = pathItemValue as OpenApiRecord;
    for (const [method, operationValue] of Object.entries(pathItem)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const operation = operationValue as OpenApiRecord;
      const identity = `${method.toUpperCase()} ${path}`;
      const successSchema = successSchemas[identity];
      if (successSchema === undefined) throw new Error(`openapi_success_schema_missing:${identity}`);
      const securityProfile = operation["x-patternly-security-profile"] ?? pathItem["x-patternly-security-profile"];
      const consumerScope = operation["x-patternly-consumer-scope"] ?? pathItem["x-patternly-consumer-scope"];
      if (typeof securityProfile !== "string" || !(SECURITY_PROFILES as readonly string[]).includes(securityProfile)) throw new Error(`openapi_security_profile_missing:${identity}`);
      if (typeof consumerScope !== "string" || !(CONSUMER_SCOPES as readonly string[]).includes(consumerScope)) throw new Error(`openapi_consumer_scope_missing:${identity}`);
      operation.operationId ??= identity
        .replace(/\{([^}]+)\}/gu, "by_$1")
        .replace(/[^A-Za-z0-9]+/gu, "_")
        .replace(/^_|_$/gu, "")
        .replace(/^([0-9])/u, "op_$1")
        .toLowerCase();
      const securityNames = securityRequirementNames(securityProfile as SecurityProfile);
      operation.security = securityNames.length === 0 ? [] : [{ [securityNames[0]!]: [] }];
      operation["x-patternly-security-profile"] = securityProfile;
      operation["x-patternly-consumer-scope"] = consumerScope;

      const parameters = Array.isArray(operation.parameters) ? [...operation.parameters] : [];
      for (const name of parameterNames(path)) {
        const alreadyDeclared = parameters.some((parameterValue) => {
          const parameter = parameterValue as OpenApiRecord;
          if (typeof parameter.$ref === "string") return parameter.$ref.endsWith(`/${name === "requestId" ? "PrivacyRequestId" : name === "incidentId" ? "SecurityIncidentId" : name === "sessionId" ? "AdoptionTransferSessionId" : ""}`);
          return parameter.name === name && parameter.in === "path";
        });
        if (!alreadyDeclared) parameters.push(parameterSchema(name, path));
      }
      if (parameters.length > 0) operation.parameters = parameters;

      if (["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) {
        const requestSchema = requestSchemas[identity];
        if (requestSchema === undefined) throw new Error(`openapi_request_schema_missing:${identity}`);
        operation.requestBody = { required: true, content: { "application/json": { schema: requestSchema } } };
      }
      const responses = (operation.responses as OpenApiRecord | undefined) ?? {};
      operation.responses = responses;
      for (const [status, responseValue] of Object.entries(responses)) {
        const response = responseValue as OpenApiRecord;
        const numericStatus = Number(status);
        if (numericStatus >= 200 && numericStatus < 300 && numericStatus !== 204 && response.content === undefined) {
          response.content = { "application/json": { schema: successSchema } };
        }
        if (numericStatus >= 400) {
          response.content = { "application/json": { schema: { "$ref": "#/components/schemas/ErrorEnvelope" } } };
        }
      }
      const successStatus = Object.keys(responses).find((status) => Number(status) >= 200 && Number(status) < 300 && Number(status) !== 204);
      if (successStatus === undefined) {
        responses["200"] = jsonResponse("Successful response", successSchema);
      }
    }
  }
}

enrichOpenApiDocument(OPENAPI_DOCUMENT_RAW as unknown as OpenApiRecord);

export const OPENAPI_DOCUMENT = Object.freeze(OPENAPI_DOCUMENT_RAW);

export type OpenApiDocument = typeof OPENAPI_DOCUMENT;
