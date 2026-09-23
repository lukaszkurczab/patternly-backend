# Patternly backend

Canonical server authority for Patternly identity mapping, persisted progress,
sync mutation batches, entitlements, device registration and immutable content
metadata.

The frontend remains offline-first. It owns the learning engine, active
practice sessions, timer, local queue and cache. This repository does not run
question selection or session transitions.

## Commands

```sh
npm ci
npm run ci
npm run dev
```

The API exposes `/health`, `/ready`, `/openapi.json` and versioned REST routes
under `/v1`. Production configuration is fail-closed: without Firestore,
Firebase verifier, App Check and rate-limit configuration, readiness is
unavailable and production startup rejects the environment.

The administrator question browser reads only a configured immutable artifact
release (`ADMIN_CONTENT_ROOT` and `ADMIN_CONTENT_RELEASE_ID`). It does not fetch
content package URIs. See `docs/cloud-run-manual-deploy.md` for the required
read-only deployment mount.

The generated frontend client is checked with:

```sh
PATTERNLY_FRONTEND_ROOT=../patternly npm run frontend:client:check
```

Guest-to-account migration has an explicit preview/confirmation contract in
`src/modules/users/merge.ts`. A merge cannot execute without matching the
preview fingerprint and resolving every conflict; unresolved conflicts are
reported explicitly instead of selecting a client or server winner.

Accepted backend decisions and deferred implementation work are recorded in
[docs/decision-register.md](docs/decision-register.md).

## Firebase Emulator Suite

The repeatable local backend acceptance flow uses the Firebase Auth and
Firestore emulators:

```sh
REPORT_RATE_LIMIT_HASH_SECRET=test-only-report-rate-limit-secret-0123456789 \
npm run test:emulator
```

The emulator suite verifies Firebase identity mapping, transactional sync CAS,
idempotency, App Check rejection, report redaction and account-owned document
deletion. The mobile app continues to reach backend data only through the
versioned HTTPS API.

### Local mobile login with already running emulators

Use `npm run dev:smoke` with `FIREBASE_PROJECT_ID=patternly-app-sandbox`,
`FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:19099` and
`FIRESTORE_EMULATOR_HOST=127.0.0.1:18081`. It reuses those emulators and binds the
API to `127.0.0.1:8080`; it does not start or clear emulator instances.
The launcher ignores ambient SMTP/RevenueCat settings and stores generated local
keys in ignored `.local/smoke/secrets.json` (mode 0600). It refuses production or
mismatched emulator configuration. The production entrypoint is unchanged.

In the mobile `.env.smoke.local`, use the same project and origins and set
`EXPO_PUBLIC_PATTERNLY_LOCAL_APPCHECK_TOKEN` from `appCheckToken` in that file.
Keep the existing Firebase/OAuth registration fields complete. Restart
`npm run start:smoke` after changing the profile. With this local token, native
App Check is not initialized. This is an explicit test fixture, **not provider
attestation**; real Firebase Auth emulator bearer tokens are still required.
Mobile accepts the fixture only in a development smoke build with loopback
API/Auth origins and the matching project. No real provider, mail, payment or
cloud validation is implied. Keep the token out of logs and release profiles.
