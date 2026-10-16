# Patternly backend

Canonical server authority for Patternly identity mapping, persisted progress,
sync mutation batches, entitlements, device registration and immutable content
metadata.

The frontend remains offline-first. It owns the learning engine, active
practice sessions, timer, local queue and cache. This repository does not run
question selection or session transitions.

## Local prerequisites

The reproducible acceptance environment in [Backend CI](.github/workflows/ci.yml)
uses **Node.js 22.22.3**, **Temurin JDK 21** and **Firebase CLI 15.19.0**
(`firebase-tools`). Have these versions available and select them in your shell
before running the commands below. Java is required by the Firebase emulators; it is not a
production API dependency. Firebase CLI is installed separately in CI, not by
this repository's `npm ci`.

```sh
node --version       # v22.22.3
npm --version        # supplied with the selected Node installation
java -version        # Temurin 21 (check JAVA_HOME and PATH)
firebase --version   # 15.19.0
```

`package.json` declares the broader production Node minimum `>=22`; local
acceptance uses the CI pin above. Operator HTTPS fixture tests specifically
require Node 22.19+ for the test-only CA trust helpers (see
[operator acceptance](docs/operator-acceptance.md)). A Node 22.9 or Java 17
selected by a shell is insufficient for that acceptance environment.

For the complete `npm run ci`, keep the mobile and web consumers in sibling
directories `../patternly` and `../patternly-web`, and install mobile dependencies
with `npm ci --prefix ../patternly`, as CI does. Use the configured sandbox
project for the emulator command below; this is local validation, not a cloud
deployment. [Cloud Build](cloudbuild.yaml) instead runs `ci:cloud` under Node 22;
that narrower gate does not run the emulator/mobile-consumer acceptance.

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
