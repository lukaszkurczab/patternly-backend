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
