# ODK-119 — provider-backed backend refresh (partial)

## Scope and cause

The previous `GET /v1/entitlements` read only a Firestore webhook projection. That projection could be stale and could not establish current grace or billing hold. The route now performs a RevenueCat REST v1 subscriber read for the authenticated account during each request. It returns the configured entitlement and product with provider expiry, separate grace expiry, provider observation time and server observation time. A missing reader, provider failure, malformed or ambiguous response returns explicit `503`; no webhook projection is substituted.

The reader distinguishes active, grace, hold, expired and refunded. Cancellation before expiry remains active; grace requires a provider grace date. The response must contain `original_app_user_id` equal to the requested Patternly account ID; alias or transfer ambiguity denies confirmation. Missing provider maps are unavailable rather than authoritative expiry. The API key stays server-side in `REVENUECAT_READ_API_KEY` and the authenticated route remains protected by App Check and bearer. Production `/ready` fails when the reader is missing. OpenAPI and the mobile client DTO use the new response shape.

## Verification

- Backend `npm run typecheck`, `npm run lint`, `npm run build`, `npm run openapi:check`, `npm run frontend:client:check`: passed.
- RevenueCat reader tests: 13/13 passed, covering active/cancellation/grace/hold/expiry/refund, alias mismatch, missing or mismatched records, network and response failures, and fetch/body timeouts.
- Firebase emulator suite: 189/189 passed, including account binding, App Check, provider failure, hold and missing reader.
- App `npm run typecheck`: passed after DTO and fixture updates.

## Remaining work and limits

- This is one backend slice, **not ODK-119 completion**. The app does not yet refresh/cache this state or gate new Premium sessions and downloads. Existing fixed seven-day domain predicate remains unused in runtime and needs replacement.
- RevenueCat production key, exact SKU/environment, Apple and Google three-day grace configuration, and provider-backed lifecycle evidence are not available from this checkout. Local mocks do not prove those settings.
- Until `REVENUECAT_READ_API_KEY` and matching IDs/environment are configured, the endpoint intentionally returns `503`.
- No production deployment was performed.

## Independent QA

Initial independent `gpt-5.6-luna/max` QA rejected the slice (minimum 0.56) for grace detection, account binding, missing provider maps and readiness. Those findings were patched and retested. Follow-up QA approved the bounded backend slice (consistency 0.91, simplicity 0.86, risk 0.84, maintainability 0.87; minimum **0.84**). QA noted that the provider reader's readiness status should appear in `/ready` checks; this was added after the review. Provider console and E2E evidence remain open.
