# Backend operations

## Local checks

```sh
npm ci
npm run ci
```

`npm run ci` runs the explicit lint, strict typecheck, unit/API tests,
deterministic OpenAPI check and production build. The OpenAPI check compares
the committed document directly with the generated contract, so it does not
depend on a Git working tree.

Cloud Build runs `npm run ci:cloud`: static checks, contract generation,
production build and tests that do not need the local Firebase Emulator Suite
or the separately checked mobile repository. The complete emulator acceptance
suite and frontend client check remain required pre-promotion local checks.

## Cloud Run contract

Builds produce an image tagged with the immutable Cloud Build commit SHA.
Cloud Run must provide `FIREBASE_PROJECT_ID`, `FIREBASE_AUTH_ISSUER`,
`ADMINISTRATOR_EMAIL`, `ADMIN_WEB_ORIGIN` and
`REPORT_RATE_LIMIT_HASH_SECRET` through runtime configuration.
`ADMIN_WEB_ORIGIN` is the exact HTTPS origin of the admin panel, without a
path, query, fragment or credentials. Production startup fails if required
configuration is absent. Firebase Admin SDK uses the Cloud Run runtime identity
for Firestore; no client or external database credentials are configured.

Firestore collection fields, TTL settings and the seven-day PITR target are
operational configuration, not request-time schema creation. The application
does not silently create or repair provider configuration at request time.
