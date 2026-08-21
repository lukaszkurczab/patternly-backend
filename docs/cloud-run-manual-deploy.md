# Cloud Run deployment contract

The backend is deployed from this repository, not from the mobile application
repository. Build with `cloudbuild.yaml` and promote the image identified by
the immutable `${COMMIT_SHA}` tag to Cloud Run.

Required runtime configuration is supplied through Secret Manager or the
Cloud Run service configuration:

- `DATABASE_URL` for Cloud SQL PostgreSQL;
- `FIREBASE_PROJECT_ID` and `FIREBASE_AUTH_ISSUER`;
- `REVENUECAT_SECRET_NAME` for the provider boundary;
- `LOG_LEVEL` and `NODE_ENV`.

Before promotion, run `npm run ci`, apply the checked-in SQL migration through
the database deployment job, and verify `/health` and `/ready`. `/ready` must
not be treated as healthy until PostgreSQL and Firebase verifier wiring are
available.
