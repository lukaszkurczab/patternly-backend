# APPCHK-04 — rejection observability and unavailable/retry retest

**Status:** `done` locally; real provider attestation remains ODK-E2E-084.

## Evidence

- The mobile App Check guard emits one allowlisted `app_check_rejected` event for missing, invalid, or unconfigured attestation. The event contains only a fixed code and server-generated correlation ID. HTTP responses keep the existing 401/503 contract.
- An observability test injects canary authorization, App Check, query, and client correlation values. It confirms those values are absent from logs and checks the exact event shape for all three rejection states.
- The canonical native-token accessor maps provider rejection to `null`. Both the public legal form and content report outbox then use their explicit unavailable state. Mobile client tests prove unavailable attestation prevents transport, an explicit retry can proceed after a token becomes available, and privacy request failures classify missing, invalid, and unconfigured server attestation as unavailable. A content report outbox test proves that provider rejection retains the same submission ID across retry.

## Verification

- Backend: `tests/appObservability.test.ts` 6/6, `tests/openapiContracts.test.ts` 21/21, lint, typecheck, OpenAPI parity and diff check passed.
- App: targeted API, account and content report outbox tests 60/60, typecheck and diff check passed.
- Independent briefing validation: `gpt-5.6-luna`/`max`, approved; consistency 0.94, simplicity 0.91, risk 0.86, maintainability 0.92, minimum **0.86**.
- Independent post-change QA: initial FAIL found an uncaught native-token rejection in the public legal and content report flows. After the canonical accessor fix and retest, `gpt-5.6-luna`/`max` returned **PASS**; consistency 0.96, simplicity 0.95, risk 0.91, maintainability 0.95, minimum **0.91**.

## Remaining external gate

ODK-E2E-084 requires a frozen native build and real device evidence for valid, missing, invalid, and unavailable provider states. Local deterministic verifiers and configuration tests are not proof of production attestation.
