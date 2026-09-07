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
Cloud Run must provide `FIREBASE_PROJECT_ID`, `FIREBASE_AUTH_ISSUER`,
`ADMINISTRATOR_EMAIL`, `ADMIN_WEB_ORIGIN` and
`REPORT_RATE_LIMIT_HASH_SECRET` through runtime configuration.
`ADMIN_WEB_ORIGIN` is the exact HTTPS origin of the admin panel, without a
path, query, fragment or credentials. Production startup fails if required
configuration is absent. Firebase Admin SDK uses the Cloud Run runtime identity
for Firestore; no client or external database credentials are configured.

`DELETION_PSEUDONYM_KEYS_JSON` is a Secret Manager secret, readable only by the Cloud Run runtime service account through a narrowly scoped `secretAccessor` grant. It contains exactly one active HMAC key and optionally verify-only predecessors; startup fails closed if that contract is invalid.

`PRIVACY_RESPONSE_KEY_BASE64` (32 random bytes encoded as base64) and
`PRIVACY_AUDIT_HMAC_SECRET` (at least 32 characters) are Secret Manager
secrets. They encrypt temporary response artifacts and pseudonymize audit
identifiers. `PUBLIC_PRIVACY_ORIGIN` is the exact HTTPS origin serving
`/privacy-request`; it must not contain a path, query, fragment or credentials.
Public privacy-request intake uses Google Workspace SMTP Relay. Configure
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_FROM_EMAIL`,
`SMTP_FROM_NAME` and optional `SMTP_REPLY_TO` as runtime values. Provide
`SMTP_PASSWORD` through Secret Manager with a narrowly scoped `secretAccessor`
grant. Production startup fails closed when this configuration is incomplete.
Account deletion is initiated only in the authenticated application and does
not use email.

Firestore collection fields, TTL settings and the seven-day PITR target are
operational configuration, not request-time schema creation. The application
does not silently create or repair provider configuration at request time.
The account-data export TTL policy is versioned in
`config/firestore-ttl.json`; verify it with `npm run firestore:ttl:check` and
apply it to a target project with
`npm run firestore:ttl:apply -- --project <target-project>`. This enables
Firestore TTL on `expiresAt` for account export records and for privacy request,
secret, response, rate-limit and audit records. Privacy responses are retained
for 30 days after delivery; minimal pseudonymous evidence is retained for three
years after closure.

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

The administrator records the classification and both notification decisions.
The backend never decides whether a report is required, submits to UODO, or
sends subject email automatically. Export the prepared versioned UODO payload,
submit it through the authority channel, then record time, channel, reference
and encrypted evidence. Subject mail has a separate `security-incidents`
purpose and fails closed unless Google Workspace SMTP has real non-placeholder
From and Reply-To addresses over TLS 1.2+. Failed or unknown deliveries require
an explicit resolution; there is no automatic retry. Keep closed records and
decisions for six calendar years; keep encrypted artifacts one calendar year.
A documented legal hold removes expiry and its release recalculates expiry from
the original dates.
