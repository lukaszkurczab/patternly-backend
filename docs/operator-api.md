# Backend operator API

The /v1/operator/* endpoints are a backend-only interface for authorized
operations tooling. They are separate from the local /v1/admin/* panel and
are not consumed by the mobile or web applications.

Every request requires an OIDC ID token in the Authorization: Bearer header.
The backend verifies the signature against the configured pinned HTTPS JWKS
URL, issuer and audience, then checks the exact action in the operator
allowlist. Roles are descriptive metadata; action strings are the
authorization boundary. Missing verifier configuration returns 503
operator_unavailable. Invalid tokens and missing actions return the neutral
401 operator_token_invalid. All operator responses, including errors, use
Cache-Control: private, no-store.

Collection endpoints return { items: [...], truncated: boolean }. They read
at most 100 items and set truncated when more results exist. Detail endpoints
return { item: ... }. Detail responses expose the reviewed request or incident
context needed for triage: content description and safe client context,
privacy and legal narrative metadata, and the current incident assessment
with pseudonymous delivery and audit scalars. They omit contact email
addresses, legal response bodies, privacy response bodies, session tokens,
encrypted payloads, recipient addresses, and raw audit snapshots. Queues and
action results remain minimal. Queue and detail reads are audited with the
verifier's pseudonymous actor identity.

| Action | Routes |
| --- | --- |
| content_reports:read | GET /v1/operator/content-reports, GET /v1/operator/content-reports/{clientSubmissionId} |
| content_reports:transition | PATCH /v1/operator/content-reports/{clientSubmissionId} |
| privacy_requests:read | GET /v1/operator/privacy-requests, GET /v1/operator/privacy-requests/{requestId} |
| privacy_requests:action | PATCH /v1/operator/privacy-requests/{requestId} |
| legal_requests:read | GET /v1/operator/legal-requests, GET /v1/operator/legal-requests/{requestId} |
| legal_requests:action | PATCH /v1/operator/legal-requests/{requestId} |
| security_incidents:create | PUT /v1/operator/security-incidents/{incidentId} |
| security_incidents:read | GET /v1/operator/security-incidents, incident detail, and exact-version authority export routes |
| security_incidents:action | PATCH /v1/operator/security-incidents/{incidentId} |

Content-report transitions require both the current expectedStatus and the
requested status; the store checks the expected value atomically. Privacy
and legal transitions retain their revision checks. Privacy public email
delivery, extension-notice retry and public extension/delivery attempts are
unavailable through this API. The public-request email actions fail before
their transaction writes; in-app account actions remain available. Legal
email answers are unavailable. Security notification actions retain their
durable pending/sent/failed/unknown state and unknown outcomes require an
explicit reconciliation action; the API does not retry delivery implicitly.

Security-incident PUT IDs use the form si_<uuid>. The UUID is the stable
create operation key; retrying the same ID and payload replays the same
creation, while reusing the ID with different content returns a conflict.
Both initial creation and replay return HTTP 200.

The verifier is constructed only when all four values are configured:
OPERATOR_OIDC_ISSUER, OPERATOR_OIDC_AUDIENCE, OPERATOR_OIDC_JWKS_URL, and
OPERATOR_ALLOWLIST_JSON. The allowlist is a JSON array of entries with
subject, role and actions fields. Keep operator configuration restricted to
the backend runtime. Production enablement requires review of the real
issuer, audience, JWKS endpoint and operator subjects/actions; synthetic
local signing keys do not establish a provider or production identity claim.
