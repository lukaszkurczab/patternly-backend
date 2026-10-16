# Backend operations

## Local checks

```sh
npm ci
npm run ci
```

`npm run ci` runs the explicit lint, strict typecheck, unit/API tests,
deterministic OpenAPI check and production build. The OpenAPI check compares
the committed document directly with the generated contract, so it does not
depend on a Git working tree.

Cloud Build runs `npm run ci:cloud`: static checks, contract generation,
production build and tests that do not need the local Firebase Emulator Suite
or the separately checked mobile repository. The complete emulator acceptance
suite and frontend client check remain required pre-promotion local checks.

## Cloud Run contract

Builds produce an image tagged with the immutable Cloud Build commit SHA.
Cloud Run must provide `FIREBASE_PROJECT_ID`, `FIREBASE_AUTH_ISSUER` and
`REPORT_RATE_LIMIT_HASH_SECRET` through runtime configuration. Administrator
routes are unavailable in production, and `ADMIN_WEB_ORIGIN` is rejected there.
Production startup fails if required configuration is absent. Firebase Admin SDK uses the Cloud Run runtime identity
for Firestore; no client or external database credentials are configured.

`DELETION_PSEUDONYM_KEYS_JSON` is a Secret Manager secret, readable only by the Cloud Run runtime service account through a narrowly scoped `secretAccessor` grant. It contains exactly one active HMAC key and optionally verify-only predecessors; startup fails closed if that contract is invalid.

`PRIVACY_RESPONSE_KEY_BASE64` (32 random bytes encoded as base64) and
`PRIVACY_AUDIT_HMAC_SECRET` (at least 32 characters) are Secret Manager
secrets. They encrypt temporary response artifacts and pseudonymize audit
identifiers. Guest privacy intake and code verification run only in the mobile
application under the mandatory App Check policy in BE-DEC-004. The retired
browser privacy endpoints and `PUBLIC_PRIVACY_ORIGIN` are not accepted.
SMTP configuration for guest privacy codes uses
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_FROM_EMAIL`,
`SMTP_FROM_NAME`, optional `SMTP_REPLY_TO` and a Secret Manager
`SMTP_PASSWORD` with a narrowly scoped `secretAccessor` grant. Account deletion
is initiated only in the authenticated application and does not use email.

Firestore collection fields, TTL settings and the seven-day PITR target are
operational configuration, not request-time schema creation. The application
does not silently create or repair provider configuration at request time.
The account-data export TTL policy is versioned in
`config/firestore-ttl.json`; verify it with `npm run firestore:ttl:check` and
apply it to a target project with
`npm run firestore:ttl:apply -- --project <target-project>`. This enables
Firestore TTL on `expiresAt` for account export records and for privacy request,
secret, response, rate-limit and audit records. Privacy responses are retained
for 30 days after delivery. Closed privacy-request history is retained for 12
calendar months; its encrypted narrative and email secret expires 30 days after
closure. Account-deletion proof and its opaque operation acknowledgement expire
after 12 calendar months. The operation hash remains during that period so the
confirmation workflow can be resumed without retaining the account identifier.

`config/log-retention-policy.json` records the desired Cloud Logging configuration:
ordinary application/operational logs for 30 days and selected security review
logs for 90 days. Check its internal contract with `npm run logs:retention:check`.
The checked file is desired state only; it does not read or change a Google Cloud
project. Confirm provider configuration separately before treating these periods
as active.

## Sandbox snapshot — 30 September 2026

- Email/password sign-in was confirmed working on the Android sandbox after the
  backend session-exchange route was deployed. The later loading-screen polish
  for the transient sign-out state has not been published to EAS; the tester
  chose to continue with the current build.
- Brevo SMTP is configured for the sandbox in Google Cloud Secret Manager.
  SMTP authentication over TLS was checked, but no test email was sent. Secret
  values are intentionally not recorded here.
- The RevenueCat project exists, but App Store Connect and Google Play remain
  intentionally unconnected. No purchase or store lifecycle has been verified.
  Do not treat local entitlement tests as provider-backed purchase evidence.

Historical content-report cleanup is an explicit operator action, not an HTTP
endpoint or a background job. Run `npm run retention:purge -- --project
<project-id> --database '(default)'` first and add `--execute` only after its
JSON result is reviewed. It is restricted to content-report parents and their
exact audit children; privacy and security audit records are deliberately
excluded because their lifecycle and legal-hold contracts own retention. Use
`--max-deletes` to set the explicit bounded execution budget; `--page-size`
only changes deterministic scan pagination and never changes scope.

## Deletion pseudonym key lifecycle

Rotate by adding a new active key and retaining the former key as `verify_only` for at least 45 days. This permits retries of deletion operations and validation of unexpired tombstones created before rotation. Remove a predecessor only after the retention window and an audit of outstanding data. Keep an encrypted, access-audited recovery backup outside the application runtime. A suspected compromise requires immediate secret replacement, access audit and privacy-incident handling; do not introduce a fallback key or bypass fail-closed startup validation.

## Security-incident register

The verified configured administrator checks the incident queue at least once
each business day and immediately after any suspected incident. Acknowledged
awareness times materialize non-sensitive 24, 48, 60 and 70 hour reminder
records when the register is read or acted on; monitor an empty queue too,
because there is no background decision engine.

The administrator records a reasoned classification and both notification decisions.
The backend never decides whether a report is required, submits to UODO, or
sends subject email automatically. Export the prepared versioned UODO payload,
submit it through the authority channel, then record time, channel, reference
and encrypted evidence. Subject mail has a separate `security-incidents`
purpose and fails closed unless Brevo SMTP has real non-placeholder
From and Reply-To addresses over TLS 1.2+. Failed or unknown deliveries require
an explicit resolution; there is no automatic retry. A closed non-breach without
a dispute retains only a short incident summary, rationale and corrective actions
for 12 calendar months. A confirmed-breach record is retained for six calendar
years; the annual `review_retention` action and due-review queue record necessity without extending core expiry.
Required submission/notification evidence may follow the same end date while
working captures, deliveries, reminders and idempotency keys expire 30 days
after closure. Legal holds require a review date within six months. Expiry is
enforced by reads as well as Firestore TTL; an overdue hold remains active and
is never released automatically.

Closed legal requests require an explicit retention disposition. Minimal
non-claim history expires after 12 calendar months and removes private case text
and contact details. A claim disposition records its exact expiry, basis and
reason. Holds are scoped with a review date no later than six months; an overdue
hold stays active until a person records a disposition.


All four operator queues have stable document-ID continuation. Use `list <family>`
with `--due true` for review work (content reports: non-closed work), then pass
`--cursor <nextCursor>` with the same filter until nextCursor is null. Each page
returns at most100items and scans at most500records plus one continuation probe.
An empty page can have a cursor. Cursors are scoped to family/filter, contain
no contact data and grant no authority; normal authentication applies on every page.

Claim close requires `necessaryFields` (email, narrative, transactionId, response)
and the applicable retentionUntil, basis and reason. Unselected fields and the
email-derived subjectKey are removed immediately, within the90day maximum.
`review_retention` records reason, selected fields and the next review within
6calendar months. It never restores deleted data or guesses the applicable law.
Old claims without an assessment appear due immediately. A hold preserves all
previously needed fields. `dispute: ongoing` keeps the hold; `resolved_executed`
requires finalResolutionAt plus executedAt before releasing it and removing
now redundant fields. Generic hold release cannot bypass an active dispute.
Metadata for account history/accountability has its separate purpose. Use brief
review reasons; do not copy correspondence into them.

Breach review is annual, or within6months when held. An overdue hold stays active.
Nonbreach minimization is deferred during a hold and performed on release.
Legacy privacy12month and incident classification/working30day read caps apply
before physical TTL. Necessary breach notification evidence and core audits
follow the core period. Invalid closed-record expiry fails closed.

Uncertain privacy delivery is surfaced for inspection by the start of the next
UTC weekday (Monday–Friday). This conservative operational target is separate
from legal deadlines and statutory holiday calendars. `record_review` acknowledges
an inspected delivery with reason and next date within30days. A new failure or
attempt reopens review. It never retries SMTP, pretends delivery succeeded,
changes a legal deadline or deletes an active request. Closed minimal metadata
remains available after working secrets are physically deleted.

Reproduce local checks with Node22 and Java21+:
`npm run test:retention:emulator` uses only isolated demo projects/ports and
fake data. Provider TTL backfill, log configuration and mailbox cleanup require
separate service authorization; no such operation runs in these tests.
