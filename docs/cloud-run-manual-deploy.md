# Cloud Run deployment contract

The backend is deployed from this repository, not from the mobile application
repository. Build with `cloudbuild.yaml` and promote the image identified by
the immutable `${COMMIT_SHA}` tag to Cloud Run.

Required runtime configuration is supplied through Secret Manager or the
Cloud Run service configuration:

- `FIREBASE_PROJECT_ID` and `FIREBASE_AUTH_ISSUER`;
- `ADMINISTRATOR_EMAIL` and `ADMIN_WEB_ORIGIN`. `ADMIN_WEB_ORIGIN` must be the
  exact HTTPS origin of the deployed panel, with no path, query, fragment or
  credentials. The selected sandbox deployment target is
  `https://patternly-app-sandbox.web.app/admin`, so its configured origin is
  `https://patternly-app-sandbox.web.app`;
- `REPORT_RATE_LIMIT_HASH_SECRET`;
- `LOG_LEVEL` and `NODE_ENV`.

Question-bank inspection has a separate read-only publication contract. To
enable it, mount the immutable artifact directory into every revision and set
`ADMIN_CONTENT_ROOT` to that mount plus `ADMIN_CONTENT_RELEASE_ID` to the exact
release directory under `releases/`. For example, a Cloud Run GCS volume may
mount a release export at `/mnt/patternly-artifacts`, with
`ADMIN_CONTENT_ROOT=/mnt/patternly-artifacts` and
`ADMIN_CONTENT_RELEASE_ID=patternly-launch-2026-08-25-01`. The mounted release
must contain `releases/<release-id>/release.json`; the API verifies every
artifact checksum and envelope before exposing it. Do not point this setting at
an authoring checkout or an arbitrary URL. If either setting or the mounted
release is unavailable, the panel receives an explicit unavailable state.

Before promotion, run `npm run ci` (including the Firebase Emulator Suite),
verify the Firestore TTL/PITR checklist for the target project, and verify
`/health` and `/ready`. `/ready` must not be treated as healthy until
Firestore, Firebase verifier and App Check wiring are available.

The Firebase account matching `ADMINISTRATOR_EMAIL` must use a verified email
address. The backend rejects unverified email tokens for the content-report
queue and its status transitions. After confirming an address, sign in again
or refresh the ID token before using the panel.

The admin usage aggregates require the `progress.recordType` collection-group
index in `firestore.indexes.json`. Deploy that configuration with
`firebase deploy --only firestore:indexes --project <target-project>` and wait
for the index to become ready before enabling the new panel. Existing
collection-scope indexes are preserved. See the
[Firestore index documentation](https://firebase.google.com/docs/firestore/query-data/index-overview#collection_group_scope).
