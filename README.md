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
