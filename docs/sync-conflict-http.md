# Sync HTTP conflict contract — prompt 05

14.10.2026 — **PASS: bounded local code and HTTP-contract acceptance**. This document records the contract and reproducible evidence; it is not deployment or release approval. Main agent was the sole writer. Independent contract review and acceptance QA used **gpt-6-luna / high**. Design: fit 0.95, simplicity 0.94, risk control 0.88, maintainability 0.94; minimum 0.88.

## Contract and consumers

`POST /v1/progress/sync` returns one error envelope for every HTTP 409. It never returns the successful batch body for a conflict.

| Code | `error` fields | Account-service decision |
| --- | --- | --- |
| `account_revision_conflict` | `code`, required safe nonnegative integer `currentAccountRevision` | Persist confirmed conflict; stop before ACK, GET or materialization |
| `version_conflict` | `code` | Persist confirmed conflict; stop before ACK, GET or materialization |
| `content_identity_schema_conflict` | `code`, optional string-array `issues` from request validation | Persist confirmed conflict; stop before ACK, GET or materialization |
| `mutation_id_reuse` | `code` | Explicit failed state; no ACK or materialization |
| `progress_generation_conflict` | `code` | Explicit failed state; no ACK or materialization |
| `authorization_generation_conflict` | `code` | Explicit failed state; no ACK or materialization |

The adapter throws `PatternlyApiClientError("server_error", 409, code, retryAfterSeconds, details)`. `details.currentAccountRevision` and `details.issues` preserve validated metadata. Legacy raw batch-conflict bodies, unknown codes, extra fields, missing/invalid revisions and malformed JSON fail as `invalid_response`; they cannot confirm a conflict or acknowledge mutations. A 200 body must contain exactly `accountRevision`, `applied`, `duplicates`, and empty `conflicts`. A nonempty conflict array, `accountRevisionConflict` field or error envelope is rejected as an invalid success.

No production consumer uses the rejected batch's `current` record: account service saves local request/batch identity, and both `inspectAccountSyncConflict` and `resolveAccountSyncConflict` obtain fresh progress before deciding. This also checks the latest whole goal/plan pair. Backend diagnostics only needs a successful ACK. Therefore the HTTP conflict omits stale records and mutation lists; it keeps the code and meaningful revision/schema details. No automatic winner or rebase was introduced. Internal progress-store results, receipt retention/replay and existing stored batch results remain unchanged.

OpenAPI source is `src/api/openapi.ts`; `openapi/patternly-v1.json` is generated. Sync 409 is `allOf(ErrorEnvelope, SyncConflictEnvelope)`: every payload must satisfy the common closed envelope and the per-code constraints. The validator permits mandatory `allOf` narrowing, rejects `anyOf` escape routes and still requires the closed common envelope. All other existing 409 producers already use `error`; no framework or common package was added.

## Scope and ordering

Baseline clean checkouts: APP `3fdff7bbfee2ae93e0baab1b6d9bde515001c4e0`; BACKEND `1fea72c9f64d82f8bcd534d3624664629eaf7d51`. Earlier prompt 04/03/02 outcomes were preserved, not reopened. The missing historical M03 report was not recreated; current code established the defect and consumers. Workspace `docs/PATTERNLY-WORKING-PLAN.md` remains canonical; no copy under APP docs was restored.

Producer: BACKEND route and OpenAPI → consumer: APP HTTP adapter → account service/diagnostics. Implementation order was producer/schema, consumer, real integration, independent acceptance. Any later merge or release must coordinate these two repositories: the new client intentionally rejects the old raw 409. There are no production users requiring a dual contract. Code delivery is separate from service deployment and iOS release; no deployment, migration or rollback tooling was introduced. Rollback, if needed before release, must restore both sides together.

Changed files in this package:

- BACKEND: `src/api/app.ts`, `src/api/openapi.ts`, `src/api/openapi-validator.ts`, generated `openapi/patternly-v1.json`, `tests/openapiContracts.test.ts`, `tests/firestore.emulator.test.ts`, `tests/appObservability.test.ts`, `scripts/qa/sync-conflict-client.test.mjs`, `scripts/run-sync-conflict-tests.mjs`, `package.json`, this contract/evidence document.
- APP: `src/infrastructure/clients/PatternlyApiClientAdapter.ts`, `src/infrastructure/clients/patternlyApiClient.test.ts`, `src/application/account/accountDataService.ts`, `src/application/account/accountLifecycle.test.ts`, `src/features/home/BackendDiagnosticsScreen.tsx`, `src/features/home/BackendDiagnosticsScreen.test.ts`, `.agent/WORKING_STATE.md`.
- Workspace: `docs/PATTERNLY-WORKING-PLAN.md`.

Removed replaced paths: raw-conflict fallback in `requestJson`, `SyncConflictDto`/success-conflict parser, optional success `accountRevisionConflict`, account-service success-conflict branches, unreachable diagnostics conflict check and fake successful-conflict fixtures. No storage path, data, pin or historical artifact was deleted.

## Verification

Runtime: Node **22.22.3**, existing isolated emulator runner (Auth19119/Firestore18119), demo project `demo-patternly-sync-conflict`. Real loopback Fastify listen→native fetch was probed successfully before building the integration check. No simulator or device was used.

| Check | Result and scope |
| --- | --- |
| APP: `node --import tsx --test src/infrastructure/clients/patternlyApiClient.test.ts src/application/account/accountLifecycle.test.ts` | **85/85 PASS**: real adapter parsing, 16 negative cases including malformed JSON, account conflict/restart/rebase/whole-pair resolution and preservation |
| APP related service/contract/diagnostics tests | **7/7 PASS**: `accountDataService.test.ts`, `accountDataContract.test.ts`, `BackendDiagnosticsScreen.test.ts` |
| BACKEND: `npm run test:sync-conflict:emulator` | **34/34 PASS**, of which 5 new HTTP/client tests plus existing progress contracts/storage/receipt regressions |
| BACKEND changed route regression | **2/2 PASS**: real Firestore concurrent CAS/idempotency and authorization rotation during request; narrow command below |
| BACKEND: `node --import tsx --test tests/openapiContracts.test.ts` | **26/26 PASS**, including common-envelope narrowing and rejected bypasses |
| BACKEND: `node --import tsx --test tests/appObservability.test.ts` | **11/11 PASS**, privacy/logging assertions preserved |
| OpenAPI generation/check + frontend transport check | **PASS**, generated bytes match source, 76 actual runtime operations; 54 mobile/admin consumer operations |
| Both `npm run typecheck`; BACKEND `npm run lint` | **PASS** |
| APP `validate:content-boundary`, `validate:runtime-privacy-boundary`; both Git diff checks | **PASS** |
| Independent Luna high QA | **PASS**: APP adapter/lifecycle/diagnostics **87/87**, OpenAPI **26/26**, repaired observability regression **1/1** independently rerun; current integration evidence reviewed |

Reproduce the narrow real-store route regression from BACKEND (same isolated runner, no remote data):

```sh
node --input-type=module -e 'import { runIsolatedEmulatorTests } from "./scripts/isolated-emulator-test-runner.mjs"; process.exitCode=await runIsolatedEmulatorTests({backendRoot:process.cwd(),projectId:"demo-patternly-sync-conflict",command:"node --import tsx --test --test-name-pattern=\"Firestore transaction preserves sync CAS|progress sync rejects fresh writes\" tests/firestore.emulator.test.ts"});'
```

The new integration uses actual authenticated routes, native fetch over loopback HTTP, the production client and account service. Account/version conflicts originate in real Firestore. It asserts local records/outbox/revision unchanged, pending plan items, no ACK/materialization/download, no cloud write, and blocked automatic retry. Four other codes inject only store failures, while routing/auth/serialization/HTTP/client/account persistence are real; this proves consumer classification, not every underlying failure trigger. The schema-issues test tampers with an otherwise valid outbound HTTP request and checks the real route rejection, validated details and no cloud write. Success and actual 409 bodies are validated against the documented schemas. Separate client tests reject malformed payloads and disguised 200 errors. Existing lifecycle resolution tests verify fresh reads and both whole-pair choices with in-memory storage and controlled remote reads.

Initial OpenAPI check failed because the guard accepted only a direct common-envelope ref; correction preserves the common requirement using `allOf`, with negative bypass tests. Independent QA then found two stale observability response assertions; only their envelope expectation was corrected, and the full suite plus independent targeted rerun passed. These failures are resolved; they are not hidden as environment blockers.

## Tested source identity

SHA-256 of the tested bytes (workspace-relative paths); documentation-only updates do not invalidate these checks.

| File | SHA-256 |
| --- | --- |
| `patternly-backend/src/api/app.ts` | `3b02f7476c79072e0c8cebb333a5f2f2dba255e325021796c7945f0ec6564adb` |
| `patternly-backend/src/api/openapi.ts` | `9ccfe4d8095befce13e95f0e0be6613f5a59323f4a112c9d9c16da1dd1d7b597` |
| `patternly-backend/src/api/openapi-validator.ts` | `b1fe748e800d89c006d21f53ae3e4b8e754aa703317a39e79a5b942f77fac9cf` |
| `patternly-backend/openapi/patternly-v1.json` | `82f2a4e8d820024009fff0279d21e43a473034a8874033c7201961cd5b88d0c0` |
| `patternly-backend/scripts/qa/sync-conflict-client.test.mjs` | `69b52e522ca9e99417caac7143a0f1cbe65359bbebc76c1458ae993d0d6c3323` |
| `patternly-backend/scripts/run-sync-conflict-tests.mjs` | `4c25d840808be424324fb478962d2c367e8b5d1a6a590869a117875582f70ab8` |
| `patternly-backend/tests/openapiContracts.test.ts` | `4008e1bd8e43ca456aa2c3d2c7f1fe16b96d4cb82551d4d20881f3ea4077216d` |
| `patternly-backend/tests/firestore.emulator.test.ts` | `0491efb6f893932f83e554de747a412e89a58a5da6b618f3e217b547a47e42f1` |
| `patternly-backend/tests/appObservability.test.ts` | `ed88502e66d1f3fedb9e6534ed3a06d12990376e637031dccd64fc76fa78623f` |
| `patternly/src/infrastructure/clients/PatternlyApiClientAdapter.ts` | `80801e0603d0af61456c87e6569971f0879f054ea9e57fa51d7c808f951a05c1` |
| `patternly/src/infrastructure/clients/patternlyApiClient.test.ts` | `ca2f03e343ae7d13bc91e84f04b65ceceef859ea1e6bb3d436c38274b55d6c7e` |
| `patternly/src/application/account/accountDataService.ts` | `d99a99db288bdad9b62bd948c11e2389ae160bc9e0946605dee38d980fd7945b` |
| `patternly/src/application/account/accountLifecycle.test.ts` | `bc5652b328cf25d9da9804b7b6332c7edca2b4dd31fc33a5eb34028053a63a7c` |
| `patternly/src/features/home/BackendDiagnosticsScreen.tsx` | `da407f70477fac08daf015a45ab4999c2748c2f91dc283638751f74269f37fc4` |
| `patternly/src/features/home/BackendDiagnosticsScreen.test.ts` | `ca98c9dce7f98ba145afb5eadcfe5190039e0085b018775189667223c1440e62` |

## Limits and handoff

This is bounded local code/HTTP acceptance. No full repository suites, hosted CI, native MMKV, physical/Release build, remote services, iOS/Android, real App Check, mail or publication were tested. Prior prompt-04 broad-CI limits remain in its [terminal-wire evidence](terminal-account-wire.md); this package does not turn that historical full-suite run into PASS. No reset/reinstall/newGuest, external service change, migration, mail, commit/push, automation, goal or new chat occurred.

No prompt-05 residual remains. Next permitted prompt: **06 — purchase-mail finalization**; it was not started.
