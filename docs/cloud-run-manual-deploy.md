# Cloud Run deployment contract

The backend is deployed from this repository, not from the mobile application
repository. Build with `cloudbuild.yaml` and promote the image identified by
the immutable `${COMMIT_SHA}` tag to Cloud Run.

Required runtime configuration is supplied through Secret Manager or the
Cloud Run service configuration:

- `FIREBASE_PROJECT_ID` and `FIREBASE_AUTH_ISSUER`;
- No administrator web origin is configured in production. Administrator routes
  are unavailable there; the panel uses only the local backend and emulators;
- `REPORT_RATE_LIMIT_HASH_SECRET`;
- `PUBLIC_PRIVACY_ORIGIN` and the Google Workspace SMTP settings
  `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_FROM_EMAIL`,
  `SMTP_FROM_NAME` and optional `SMTP_REPLY_TO`;
- `SMTP_PASSWORD` — a Secret Manager value available only to the Cloud Run
  runtime service account. Do not store it in source control or ordinary
  deployment variables;
- `REVENUECAT_APP_ID`, `REVENUECAT_ENTITLEMENT_ID`, `REVENUECAT_PRODUCT_ID`
  and `REVENUECAT_WEBHOOK_ENVIRONMENT=PRODUCTION` must match the production
  RevenueCat project and App Store product exactly;
- `REVENUECAT_WEBHOOK_SECRET` — the exact Authorization value configured in
  RevenueCat, supplied through Secret Manager and never stored in source;
- `DELETION_PSEUDONYM_KEYS_JSON` — a Secret Manager value containing exactly one `active` HMAC key and any `verify_only` predecessors. Grant the Cloud Run runtime service account only `roles/secretmanager.secretAccessor` on this secret; never expose its material in source control, build logs or ordinary environment files;
- `LOG_LEVEL` and `NODE_ENV`.

Local question-bank inspection uses the checksum-verified immutable content
release configured by `npm run dev:admin`. Cloud Run does not serve the panel.

Rotate deletion pseudonym keys by publishing a new secret version with one new `active` key and the previous key marked `verify_only`. Keep a predecessor available for at least 45 days (the tombstone retention period), then remove it only after confirming no unexpired tombstones require it. Revoke a suspected compromised key by replacing the secret, auditing access, and treating affected tombstones as a privacy incident; recovery requires an encrypted, access-audited backup of the keyring. Startup fails closed for missing, malformed, weak, duplicate or ambiguously active keys.

Before promotion, run `npm run ci` (including the Firebase Emulator Suite),
run `npm run firestore:ttl:apply -- --project <target-project>` to apply the
repository-owned export retention policy, verify the Firestore TTL/PITR
checklist for the target project, and verify
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

Security-incident notices use the same Google Workspace SMTP Relay connection
but a separate backend mail purpose. `SMTP_FROM_EMAIL` and `SMTP_REPLY_TO`
must be real monitored addresses: the incident sender fails closed for known
placeholders. UODO reporting remains manual; export the versioned payload and
record the channel/reference/evidence after submitting through the authority's
portal.
