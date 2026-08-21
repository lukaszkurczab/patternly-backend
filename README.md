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
under `/v1`. Production configuration is fail-closed: without PostgreSQL and
Firebase verifier configuration, readiness is unavailable and production
startup rejects the environment.

The generated frontend client is checked with:

```sh
PATTERNLY_FRONTEND_ROOT=../patternly npm run frontend:client:check
```

Guest-to-account migration has an explicit preview/confirmation contract in
`src/modules/users/merge.ts`. A merge cannot execute without matching the
preview fingerprint and resolving every conflict; unresolved conflicts are
reported explicitly instead of selecting a client or server winner.

## iOS Simulator backend check

The repeatable local acceptance flow uses PostgreSQL, the Firebase Auth
Emulator and the tracked Maestro flow in the frontend repository:

```sh
firebase emulators:start --only auth --project patternly-app-sandbox --config firebase.json
DATABASE_URL=postgresql://lukaszkurczab@127.0.0.1:5432/patternly \
PATTERNLY_BACKEND_ORIGIN=http://127.0.0.1:8080 \
PATTERNLY_FIREBASE_EMULATOR_ORIGIN=http://127.0.0.1:9099 \
npm run e2e:ios:seed
```

Start the backend with the seeded database and emulator configuration, source
`/private/tmp/patternly-ios-e2e.env` before starting the Expo iOS app, then run:

```sh
maestro test --udid <simulator-udid> --no-reinstall-driver \
  ../patternly/.maestro/backend-ios-simulator-e2e.yaml
```

The flow verifies health, readiness, OpenAPI route inventory, Firebase
identity mapping, all authenticated read routes, mutation application,
idempotent retry, stale-version conflict and the post-sync projection.
