# Cloud Run deployment contract

The backend is deployed from this repository, not from the mobile application
repository. Build with `cloudbuild.yaml` and promote the image identified by
the immutable `${COMMIT_SHA}` tag to Cloud Run.

Required runtime configuration is supplied through Secret Manager or the
Cloud Run service configuration:

- `FIREBASE_PROJECT_ID` and `FIREBASE_AUTH_ISSUER`;
- No administrator web origin is configured in production. The /v1/admin/*
  panel routes remain unavailable there; the panel uses only the local backend
  and emulators. The separate /v1/operator/* API is backend-only and is enabled
  only when all four operator OIDC settings below are supplied;
- OPERATOR_OIDC_ISSUER, OPERATOR_OIDC_AUDIENCE, OPERATOR_OIDC_JWKS_URL and
  OPERATOR_ALLOWLIST_JSON — configure the real identity provider and reviewed
  operator subjects/actions through the restricted Cloud Run runtime
  configuration. Do not copy test issuer values, test signing keys, or
  synthetic local identities into production. Production operator enablement
  remains a release gate until the real issuer, audience, JWKS endpoint and
  allowlist are verified;
- `REPORT_RATE_LIMIT_HASH_SECRET`;
- Brevo SMTP settings for application mail (including guest privacy codes)
  `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_FROM_EMAIL`,
  `SMTP_FROM_NAME` and optional `SMTP_REPLY_TO`;
- `SMTP_PASSWORD` — a Secret Manager value available only to the Cloud Run
  runtime service account. Do not store it in source control or ordinary
  deployment variables;
- `REVENUECAT_PROJECT_ID=proj8ae78267`, `REVENUECAT_APP_ID=app7b06e9a4c1`,
  `REVENUECAT_ENTITLEMENT_ID=premium`, `REVENUECAT_PRODUCT_ID=com.lkurczab.patternly.premium.monthly`
  and `REVENUECAT_WEBHOOK_ENVIRONMENT=PRODUCTION` must match the production
  RevenueCat project and App Store product exactly;
- `REVENUECAT_WEBHOOK_SECRET` — the exact Authorization value configured in
  RevenueCat, supplied through Secret Manager and never stored in source;
- `REVENUECAT_READ_API_KEY` — the server reader credential, supplied through Secret Manager. The existing sandbox value is an Apple public key and a real v1 subscriber read succeeded on 15 October 2026; it is not evidence of a secret server key or an active purchase. The intended separate server-key configuration remains a PREMIUM-RC-01 residual. Without a usable key the authenticated `/v1/entitlements` refresh returns `503`; a webhook projection is not presented as a fresh provider read;
- `DELETION_PSEUDONYM_KEYS_JSON` — a Secret Manager value containing exactly one `active` HMAC key and any `verify_only` predecessors. Grant the Cloud Run runtime service account only `roles/secretmanager.secretAccessor` on this secret; never expose its material in source control, build logs or ordinary environment files;
- `RECOVERY_OPERATION_KEYS_JSON` — a dedicated Secret Manager keyring for recovery operation results, with exactly one `active` 32-byte AES-256 key and any retained `decrypt_only` predecessors. Generate independent random key material and never reuse the privacy-response encryption key or deletion pseudonym keys. The backend rejects recovery key reuse against the privacy-response key. If this secret is absent, recovery operations fail closed with `503`; there is no privacy-key fallback;
- `RECOVERY_OPERATION_RATE_LIMIT_MAX` and `RECOVERY_OPERATION_RATE_LIMIT_WINDOW_SECONDS` — optional bounded controls for durable recovery-request rate limits; defaults are 30 requests per 60 seconds. Rate-limit requester identities are domain-separated HMACs, never raw IP addresses or recovery codes;
- `LOG_LEVEL` and `NODE_ENV`.

The existing sandbox uses `NODE_ENV=production` (server hardening) with
`FIREBASE_PROJECT_ID=patternly-app-sandbox` and `REVENUECAT_WEBHOOK_ENVIRONMENT=SANDBOX`
(store transaction environment). Preserve this distinction. Production store
transactions require a separate production deployment and secret references;
never point a production client at this sandbox.

Premium package readiness requires `CONTENT_PACKAGE_BUCKET` and the paired
`CONTENT_PACKAGE_READINESS_TRACK_ID=aws-certified-solutions-architect-associate` /
`CONTENT_PACKAGE_READINESS_NODE_ID=identity_federation_and_root_access`.
Configure them only after a private GCS object, exact admitted Firestore pointer,
runtime object-read permission and signing authority are verified. The runtime
does not need bucket write/list or public access. See
[transport contract](content-package-transport.md#prepared-configuration-not-deployed)
and the [prompt20 service diff and blockers](../../patternly/docs/reports/premium-rc20-2026-10-15.md).
An older deployed `/ready=200` without `checks.contentPackages` does not prove
this source version or package readiness.

Local question-bank inspection uses the checksum-verified immutable content
release configured by `npm run dev:admin`. Cloud Run does not serve the panel.

Rotate deletion pseudonym keys by publishing a new secret version with one new `active` key and the previous key marked `verify_only`. Keep a predecessor available for at least 45 days (the tombstone retention period), then remove it only after confirming no unexpired tombstones require it. Revoke a suspected compromised key by replacing the secret, auditing access, and treating affected tombstones as a privacy incident; recovery requires an encrypted, access-audited backup of the keyring. Startup fails closed for missing, malformed, weak, duplicate or ambiguously active keys.

Recovery operation keys use a separate versioned JSON keyring with one `active`
key and retained `decrypt_only` keys. Keep every predecessor until all encrypted
recovery-operation results using that version have expired or been acknowledged.
Publish a new active key before removing an old version; do not change the active
version while an operation result that depends on it remains recoverable. The
minimal operation history expires 30 days after ACK or actual supersession;
unfinished operations and delivery-unconfirmed reissues have no operation TTL.
Encrypted results keep their independent short deadline.

Before promotion, run `npm run ci` (including the Firebase Emulator Suite),
run `npm run firestore:ttl:apply -- --project <target-project>` to apply the
repository-owned TTL policies, verify the Firestore TTL/PITR checklist for the target project, and verify
`/health` and `/ready`. `/ready` must not be treated as healthy until
Firestore, Firebase verifier and App Check wiring are available.

The local emulator account matching `ADMINISTRATOR_EMAIL` uses a verified email.
The backend still verifies the token and administrator identity in development.

The account-data export history requires the
`accountDataExportAudits(userId ASC, createdAt DESC)` index in
`firestore.indexes.json`. The admin usage aggregates also require the
`progress.recordType` collection-group index. Deploy that configuration with
`firebase deploy --only firestore:indexes --project <target-project>` and wait
for the index to become ready before enabling the new panel. Existing
collection-scope indexes are preserved. See the
[Firestore index documentation](https://firebase.google.com/docs/firestore/query-data/index-overview#collection_group_scope).

Security-incident notices use the same Brevo SMTP connection
but a separate backend mail purpose. `SMTP_FROM_EMAIL` and `SMTP_REPLY_TO`
must be real monitored addresses: the incident sender fails closed for known
placeholders. UODO reporting remains manual; export the versioned payload and
record the channel/reference/evidence after submitting through the authority's
portal.

Patternly uses the existing Brevo relay at `smtp-relay.brevo.com:587` with
STARTTLS, sender name `Patternly`, and `contact@patternly.it` for both
`SMTP_FROM_EMAIL` and `SMTP_REPLY_TO`. The login comes from the connected Brevo
account; retain the existing Secret Manager reference for `SMTP_PASSWORD`.
Human mail is separate: OVH Zimbra receives `contact@patternly.it` and its
`support@patternly.it` / `privacy@patternly.it` aliases and sends operator replies.
See the [domain/mail acceptance and limits](../../patternly/docs/specs/engineering/company-domain-mail.md).
An SMTP delivery probe does not accept all backend mail routes or a production
release; those remain ODK-E2E-086.
