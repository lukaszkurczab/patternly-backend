# Patternly backend architecture

## Ownership

Patternly backend is the canonical server authority for identity mapping,
persisted progress, sync mutation deduplication, entitlement projections,
device registration and immutable content-version metadata. It does not run
the learning engine or own active practice sessions.

## Request path

```text
Firebase ID token
        |
        v
Fastify auth boundary -> PostgreSQL user/identity mapping
        |
        +--> /v1/me
        +--> /v1/progress
        +--> /v1/progress/sync -> idempotent mutation transaction
        +--> /v1/entitlements
        +--> /v1/tracks
        +--> /v1/content/versions
```

The client runs offline, retains local session state and sends a bounded batch
of domain mutations. Each mutation has a stable `mutationId` and an expected
record version. The server returns applied records, duplicates and explicit
version conflicts.

## Infrastructure contract

- Runtime: Node.js 22, Fastify, structured Pino logging and correlation IDs.
- Persistence: PostgreSQL on Cloud SQL, Drizzle schema and SQL migrations.
- Identity: Firebase Admin token verification; PostgreSQL is canonical for
  users and identities.
- Billing: RevenueCat is represented by an injected reconciliation boundary;
  provider credentials are not committed to the repository.
- Deployment: containerized for Cloud Run with Cloud Build configuration.
- Readiness: `/ready` is 503 until database and identity verification wiring
  are available. There is no silent production fallback.
