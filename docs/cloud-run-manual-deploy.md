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

Before promotion, run `npm run ci` (including the Firebase Emulator Suite),
verify the Firestore TTL/PITR checklist for the target project, and verify
`/health` and `/ready`. `/ready` must not be treated as healthy until
Firestore, Firebase verifier and App Check wiring are available.

The Firebase account matching `ADMINISTRATOR_EMAIL` must use a verified email
address. The backend rejects unverified email tokens for the content-report
queue and its status transitions. After confirming an address, sign in again
or refresh the ID token before using the panel.
