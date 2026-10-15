# SEC-04 / prompt 11 — protected recovery routes

14.10.2026. Scope: local code and HTTP contract only. Input backend `65587f8a37dd`, mobile `b449b7f2fad2`; both checkouts clean before this slice. QLE dependency already accepted in the canonical plan; not rerun.

## Change and contract

Three existing routes now reuse `routeGuard("app_check_bearer", dependencies)`:

- `GET /v1/account/recovery-codes/issue/status`
- `POST /v1/account/recovery-codes/issue/saved-ack`
- `POST /v1/account/recovery-codes/consume/ack`

The existing guard verifies App Check before bearer verification, account resolution, rate-limit persistence and lifecycle calls. Missing App Check returns `401 app_check_required`; invalid tokens and verifier exceptions return `401 app_check_invalid`; an unconfigured verifier returns `503 app_check_not_configured`. No new App Check protocol or error mapping was introduced. Source and generated OpenAPI require App Check and bearer together and document these errors.

Each route retains `onRequest: recoveryOperationNoStore`, its original handler and exact operation ID/user ID/authorization-generation forwarding. The unchanged users store rejects missing/stale session generations. The unchanged lifecycle store checks ownership, operation generation and transaction generation. Original issue still requires recent reauthentication. `POST /v1/public/recovery-codes/consume/status` remains App Check-only with code possession proof, without bearer.

Changed implementation/test files: `src/api/app.ts`, `src/api/openapi.ts`, generated `openapi/patternly-v1.json`, `tests/openapiContracts.test.ts`, new `tests/recoveryRouteGuards.test.ts`. No replaced runtime paths, helpers, dependencies or pins required removal. Existing mobile adapter already attaches both headers; no mobile implementation change.

Supporting files in the workspace: this evidence `patternly-backend/docs/sec04-recovery-app-check.md`, `patternly/docs/specs/engineering/security-privacy.md`, the sole canonical `docs/PATTERNLY-WORKING-PLAN.md`, and `.agent/WORKING_STATE.md` (existing symlink to `patternly/.agent/WORKING_STATE.md`, preserved). Only accepted local SEC-04 was removed from the plan's security row; provider gates remain. No deleted plan copy was restored.

## Acceptance evidence

Run from `patternly-backend` with Node `v22.22.3`:

| Check | Result and meaning |
| --- | --- |
| `node --import tsx --test tests/recoveryRouteGuards.test.ts` | 14/14 PASS; 59 real Fastify injections. Missing/invalid/unconfigured/throwing App Check × absent/valid/invalid bearer on each target route: zero auth calls, account reads, limiter calls and lifecycle effects. Valid App Check plus absent/invalid bearer or missing/stale generation rejects before limiter/lifecycle. Valid pair reaches only the correct handler with exact operation/owner/generation. Wrong owner or operation generation retains 404/409 and zero acknowledgement effects. Every response asserted `private, no-store`. Original issue reauth and public consume/status preserved. |
| `node --import tsx --test tests/openapiContracts.test.ts tests/appObservability.test.ts` | 37/37 PASS; contract/security probes and bounded logging regressions. Executed alongside the initial new test fixture; those 37 tests passed. |
| `npm run openapi:generate` then `npm run openapi:check` | PASS; generated artifact matches source and real runtime inventory/security probes, 76 operations. |
| `npm run typecheck`, `npm run lint`, `npm run build` | PASS. Typecheck rerun after the test fixture correction. |
| `npm run frontend:client:check` | PASS, 54 used consumer operations. |
| `git diff --check` | PASS. |

Mobile compatibility, from `patternly`:

`node --import tsx --test --test-name-pattern='recovery operation methods use the canonical paths' src/infrastructure/clients/patternlyApiClient.test.ts` — 1/1 PASS. Existing client sends App Check plus bearer for all three routes and App Check without bearer for public consume/status.

Temporary receipts: `/private/tmp/patternly-sec04-11-routes.tap`, `/private/tmp/patternly-sec04-11-mobile.tap`. `/private/tmp/patternly-sec04-11-tests.tap` retains the initial run: existing 37 tests PASS, new fixture failed before requests because three mandatory environment values were absent. Added explicit synthetic test configuration; the corrected route suite then passed. No configuration safeguards were weakened.

## Review and limits

Main agent sole writer. Proposed approach scores: objective/architecture fit 0.98, simplicity 0.99, risk control 0.95, maintainability 0.98; minimum 0.95. Independent design review by `gpt-6-luna high`: PASS, scores 0.96/0.95/0.94/0.95, minimum 0.94; reuse of the canonical guard is the smallest coherent change.

**Independent acceptance by `gpt-6-luna high`: PASS.** Reviewer independently ran `node --import tsx --test --test-concurrency=1 tests/recoveryRouteGuards.test.ts tests/openapiContracts.test.ts tests/appObservability.test.ts`: **51/51 PASS**, zero failures/skips. Reviewer also ran typecheck, lint, OpenAPI/runtime parity (76 operations) and diff-check, all PASS; inspected real lifecycle ownership/generation checks and the separate public status guard. This final combined run supersedes the initial fixture-setup failure. Code and local route-contract acceptance: **PASS**; services/release: **not assessed**. No commit/push performed in this slice.

Behavior tests execute production Fastify guards, auth adapters and handlers with verifier/store doubles. They prove rejection ordering, handler forwarding and response handling at those boundaries; they do not newly establish Firebase provider attestation or Firestore transaction behavior. Actual users/lifecycle source checks were inspected and are unchanged. No emulator, simulator, external services, SMTP, publishing or deployment was invoked. Full repository CI, real App Check pass/fail/unavailable and device/provider acceptance remain separate in R04 / APPCHK-03/04 / ODK-E2E-084. No full-suite or release PASS is claimed. Next admissible prompt: **12**, not started.
