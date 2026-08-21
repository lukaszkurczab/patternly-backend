# Backend operations

## Local checks

```sh
npm ci
npm run ci
```

`npm run ci` runs the explicit lint, strict typecheck, unit/API tests,
deterministic OpenAPI check and production build.

## Cloud Run contract

Builds produce an image tagged with the immutable Cloud Build commit SHA.
Cloud Run must provide `DATABASE_URL`, `FIREBASE_PROJECT_ID`,
`FIREBASE_AUTH_ISSUER` and the RevenueCat Secret Manager reference through
runtime configuration. Production startup fails if the required private
configuration is absent.

Database migration is an explicit deployment operation. The application does
not silently create or repair schema at request time.
