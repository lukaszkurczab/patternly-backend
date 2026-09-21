# APPCHK-02 — backend mobile App Check enforcement

**Status:** `done` locally; production attestation remains APPCHK-03/04 and ODK-084 work.

## Scope and contract

- All documented `mobile` `/v1` operations now have route-specific App Check guards: `app_check_bearer`, `app_check_verify_only_bearer`, `app_check_only` or the existing `app_check_optional_bearer`. Bearer and recent-auth checks still run after valid attestation.
- The three mobile public recovery/deletion routes now require App Check. Local admin, RevenueCat webhook, backend-only adoption `/v3` and legacy browser privacy routes retain their separate trust boundaries. WEB-03B will remove the latter after the guest app form works.
- OpenAPI expresses App Check and bearer as an AND requirement for account routes. Its generated JSON, route inventory and behavioral probes agree. Probes exercise missing, invalid and valid App Check plus missing/present bearer.
- Emulator tests use one explicit test-only token and verifier. No production bypass or fabricated runtime token was added. The stale local-admin fixture in the OpenAPI checker and stale production-admin-origin SMTP fixture were corrected to reflect WEB-02's loopback contract.

## Verification

- `npm run test:emulator` — **168/168 passed** on final run. The preceding run passed 166/168; one missing test header was corrected and one concurrent deletion test passed when repeated without a production change.
- `node --import tsx --test tests/openapiContracts.test.ts` — 21/21 passed.
- `npm run lint`, `npm run typecheck`, `npm run openapi:check`, `git diff --check` — passed. OpenAPI/runtime parity covers 55 operations.
- `patternly` client retest after its path-policy adjustment: 21/21 API tests and typecheck passed.
- `npm run frontend:client:check` remains red only for three legacy browser privacy endpoints. The hosted web consumer was removed in WEB-01; WEB-03B owns API retirement after the replacement mobile flow is verified. This gate is not claimed green.
- Independent briefing validation: `gpt-5.6-luna`/`max`; consistency 0.94, simplicity 0.90, risk 0.87, maintainability 0.91, minimum **0.87**, approved.
- Independent post-change QA: `gpt-5.6-luna`/`max`, **PASS** after completing the optional-bearer App Check probes; consistency 0.95, simplicity 0.92, risk 0.88, maintainability 0.93, minimum **0.88**. The reviewer did not rerun tests; the local OpenAPI suite passed 21/21 after the fix.

## Remaining

- APPCHK-03/04: native debug/production configuration checks, sanitized rejection monitoring, mobile unavailable/retry matrix and local retest. Real attestation for the frozen candidate is ODK-084.
- WEB-03B: verified in-app guest privacy form, followed by removal of the browser privacy API and its OpenAPI/client references.
