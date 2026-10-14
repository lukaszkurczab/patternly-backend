# Terminal account wire — SEC-05 / prompt 04

14.10.2026. **PASS — bounded local code/contract acceptance.** Backend-wide CI, service rollout and release are not accepted by this result. Next permitted prompt: **05**, not started.

## Contract and ownership

The canonical dependency-free closed guard is [APP accountWireState](../../patternly/src/domain/account/accountWireState.ts). BACKEND vendors exactly the same source at `src/modules/progress/accountWireState.ts`; `tests/accountWireContract.test.ts` compares the files in the default backend test command. No new SDK, runtime question schema, scorer, database or session store was introduced.

`training_session_summary.state` uses `schemaVersion: "terminal-session-v1"`. The explicit [producer/adapter](../../patternly/src/storage/contracts/terminalSessionWire.ts) transfers terminal identity, track/mode, status, timestamps, requested length and immutable `durationMs`. It omits `currentItemIndex`, `actualLength`, `activeForegroundMs`, draft, journal, active pointer and timer/checkpoint records. The existing store adapter derives length from the occurrence list and uses the last index solely to satisfy the terminal local model; abandoned stays abandoned. No active pointer is created, no session can resume, and re-export omits the derived position.

The immutable plan remains lossless: exact ordered occurrence refs, option order, configuration, conditional reinsertion slots, review-source snapshots, taxonomy and original plan fingerprint. `contentSessionIdentity.ts` hashes these values and completed Coding history recomputes that hash. QLE Review uses occurrence order, option order, feedback mode and case exposure. Removing them, clearing the fingerprint or recomputing a new historical plan would violate accepted evidence. Immutable timer configuration and terminal aggregate duration evidence are historical facts, distinct from a running clock/checkpoint. This resolves the stale SEC-05 blanket prohibition on all order/configuration/timer-named fields.

Committed attempt responses remain the first responses; no parallel firstResponse schema was added. QLE case evidence preserves assistanceBeforeSubmit, priorExposure, role, step/case identities and reveal policy. Case states preserve prior/hint/solution exposure. Approved terminal result coverage and family evidence, review cycles/manual intent, goals and accepted plans remain on their existing record types.

All seven record types dispatch through the same closed guard at backend sync, one-shot adoption and staged transfer intake; the app uses it at HTTP request/response, outbox/snapshot validation, materialization and account-export progress validation. Fixed nested objects reject extra keys without coercion or stripping. Response variants are the existing five canonical kinds. Supported result envelopes are the three registered families, aggregate facts and the four fixed Design simulation stages. Declared dictionaries carry occurrence/option/dimension identities and typed values; they are not arbitrary metadata objects. Content-specific interpretation/admission and scoring remain with their existing owners.

The exporter now reads through `FirestoreProgressStore.readSnapshot`, which selects the active generation after staged adoption. Its old generation-zero scan, shallow `readProgressRecord`, `asJsonRecord` and unused collection constant were removed after reference checks. Export format, authentication, generation fences, rate/size limits and audit behavior remain intact.

## Preproduction failure policy

The canonical plan explicitly does not require local-version compatibility before launch; storage policy excludes translators and parallel fallback. Old whole-session summaries or queued payloads are rejected, preserving stored bytes, fingerprints, receipts and mutation IDs. No migration, silent rehash, skip, reset or cleanup was performed. Existing account-unavailable/error presentation remains the failure boundary. Do not deploy the new consumer alone or promise restoration of unsupported historical shapes. Service inventory/rollout and any owner-approved repair remain outside this local acceptance; no assumption that cloud or device queues are empty was made.

A supported, closed plan shape may still fail domain semantics (the regression fixture uses v1 with empty slots). The existing explicit quarantine/replacement flow remains verified. Unsupported schema versions and unknown nested fields are denied at the wire boundary; they do not become silently accepted recovery data.

## Review and verification

Independent design and acceptance reviewer: **gpt-6-luna, high**. Main agent was the only writer. Initial broad plan-copy proposal scored below threshold; revised ownership and failure policy scored fit 0.94 / simplicity 0.84 / risk 0.84 / maintainability 0.86. The required generation-aware export correction was independently reviewed: 0.98 / 0.90 / 0.88 / 0.91. Review was based on independent source/diff inspection and actual command logs supplied by the main agent, not a separate device run.

| Executed check | Result and boundary |
| --- | --- |
| APP targeted 7 files: terminalAccountWire, accountDataSync, accountDataContract, localCommitAccountSync, patternlyApiClient, accountDataExportService, accountLifecycle | **120/120**. Real admitted QLE lifecycle/journal in isolated memory storage; all seven types round-trip, exact first responses/assistance/review, original plan fingerprint, terminal/abandoned adapter, active-session exclusion, stable retry IDs, obsolete outbox bytes preserved, quarantine and replacement. |
| `npm run test:terminal-wire:emulator` | **52/52**, rerun after adding unsupported-plan and persisted-whole-session negatives. Real Auth/Firestore SDKs, production HTTP serialization and route handlers, all-record sync/bootstrap, both adoption paths, retry/receipts, generation-1 export and stale generation-0 exclusion. Recursive injection across >50 nested object boundaries rejects with zero changes to user/account records, generations, revisions, receipts, batches and transfer records. Existing export authorization/redaction/rate/size/race tests included. |
| `node scripts/run-record-fingerprint-client.mjs` | **5/5**. Actual Design producer/outbox/consumers with ASCII/NFC/NFD, existing incompatible NFC hash refused and stored unchanged. Only its obsolete arbitrary-state fixture was replaced; vectors/profile unchanged. |
| Backend progressContracts/merge/adoptionTransfer units | **23/23**. After simplifying only the merge fixture builder, merge + guard equality rerun **9/9**. |
| Full backend `npm test` in isolated Auth/Firestore | **331 PASS / 4 FAIL / 10 SKIP, 345 tests; not PASS**. All repaired adoption byte/chunk/lease/concurrency, paging, observability, authorization and sync fixtures reached their intended assertions. See qualification below. |
| Narrow post-failure privacyRequests + progressStorage emulator | **19/19**. Privacy export stress changed from one unsupported 200KB arbitrary state to three valid ~90KB attempt states, preserving multi-chunk export. Concurrent accepted-pair SDK transaction passed in this narrowed run. |
| Isolated expired/overlong/future-token CLI test | **1/1** after its failure during the full backend run; CLI source untouched. |
| Both typechecks; backend lint; APP content/privacy boundary checks; both diff checks | **PASS**. |
| Existing OpenAPI generation/runtime check; client transport inventory | **PASS**, 76 operations / 54 used operations. These checks establish route/inventory agreement; they do not establish closed nested state in OpenAPI. Prompt 05 retains the OpenAPI/HTTP transport scope. |

Full-suite qualifications: the broad run also failed the untouched native piped-stdin CLI TTY prompt test (`token_prompt_requires_tty`) and the untouched token-time boundary test (isolated rerun passed). Its two relevant failures were the privacy fixture above and Firestore `INVALID_ARGUMENT: Transaction is invalid or closed` during concurrent plan updates; both passed the focused 19-test SDK rerun. The full suite was not rerun or declared green. A first broad invocation used an overlong test project ID and failed harness validation; that invocation is not complete regression evidence. The corrected project was `demo-patternly-term-regress`.

Direct local commands used Node 24.21.0; the broad npm test subprocess reported Node 22.22.3. No physical/Release/iOS/Android/MMKV-encryption or deployed-provider evidence is claimed. No devices, user app data, services, mail, publication, commit or push were operated on.

### Reproduction

From APP:

```sh
node --import tsx --test src/storage/contracts/terminalAccountWire.test.ts src/storage/repositories/accountDataSync.test.ts src/application/account/accountDataContract.test.ts src/application/learningMutations/localCommitAccountSync.test.ts src/infrastructure/clients/patternlyApiClient.test.ts src/application/account/accountDataExportService.test.ts src/application/account/accountLifecycle.test.ts
npm run typecheck
npm run validate:content-boundary
npm run validate:runtime-privacy-boundary
```

From BACKEND, with emulators sequentially and ports free:

```sh
npm run test:terminal-wire:emulator
node scripts/run-record-fingerprint-client.mjs
npm run typecheck
npm run lint
npm run openapi:check
npm run frontend:client:check
node --import tsx --test tests/accountWireContract.test.ts
```

The two broader/narrower SDK runs used the existing `runIsolatedEmulatorTests` from `scripts/isolated-emulator-test-runner.mjs`, with respectively `command: "npm test"` / project `demo-patternly-term-regress`, and `command: "node --import tsx --test --test-concurrency=1 tests/privacyRequests.test.ts tests/progressStorage.emulator.test.ts"` / project `demo-patternly-term-final`. No custom verification framework was added. Terminal memory fixture and non-secret runners are versioned; raw local test output was transient under `/private/tmp`.

## Own changed files

APP and BACKEND file paths below are relative to the named repository; documentation paths are workspace-qualified. Earlier ARCH-09/M01 deltas in shared files remain preserved and are not claimed as this package.

- APP implementation: `patternly/src/domain/account/accountWireState.ts` (new); `src/storage/contracts/terminalSessionWire.ts` (new); `src/storage/repositories/accountDataRepository.ts`; `src/infrastructure/clients/PatternlyApiClientAdapter.ts`; `src/application/account/accountDataExportService.ts`.
- APP verification: `src/testing/terminalWireFixture.ts` (new); `src/storage/contracts/terminalAccountWire.test.ts` (new); `src/application/account/accountLifecycle.test.ts`; `src/application/learningMutations/localCommitAccountSync.test.ts`; `src/infrastructure/clients/patternlyApiClient.test.ts`.
- BACKEND implementation: `patternly-backend/src/modules/progress/accountWireState.ts` (new); `src/modules/progress/contracts.ts`; `src/modules/users/merge.ts`; `src/modules/users/adoptionTransfer.ts`; `src/modules/data-export/store.ts`.
- BACKEND verification: `package.json`; `scripts/run-terminal-wire-tests.mjs` and `scripts/qa/terminal-wire-client.test.mjs` (new); `tests/accountWireContract.test.ts`, `tests/progressFixtures.ts` (new); `tests/progressContracts.test.ts`, `tests/merge.test.ts`, `tests/adoptionTransfer.test.ts`, `tests/dataExport.test.ts`, `tests/progressStorage.emulator.test.ts`, `tests/adoptionTransfer.emulator.test.ts`, `tests/progressPaging.emulator.test.ts`, `tests/appObservability.test.ts`, `tests/firestore.emulator.test.ts`, `tests/isolatedProgressFixture.emulator.test.ts`, `tests/privacyRequests.test.ts`. Existing uncommitted `tests/syncMutationReceipts.emulator.test.ts` and `scripts/qa/record-fingerprint-client.test.mjs`: only canonical fixture adaptation for the new parser, preserving prior receipt/fingerprint assertions.
- Documentation: this contract; `patternly/docs/specs/engineering/security-privacy.md` SEC-05; workspace `docs/04-data-model.md`, `docs/08-storage-and-offline.md`, `docs/17-training-runtime-and-interaction-spec.md`; sole `docs/PATTERNLY-WORKING-PLAN.md`; existing linked `patternly/.agent/WORKING_STATE.md`.

No files were deleted. Replaced whole-session serialization and permissive intake success were removed in place. No question content, pins, runtime schema, scoring, identity hash algorithm or receipts policy changed.

## Source identity

The following hashes identify the accepted implementation; this is an uncommitted local package, not a claim about HEAD/CI/deployment.

| File | SHA-256 |
| --- | --- |
| `patternly/src/domain/account/accountWireState.ts` | `85e12261a31c59ca373ebbc949a49e84458f3c839a5db0621cb2f4da6c319acf` |
| `patternly/src/storage/contracts/terminalSessionWire.ts` | `1c7b6d53babf46432e29fa4c38a7ac40fee193dba21ac738282373fbc3bdba72` |
| `patternly/src/storage/repositories/accountDataRepository.ts` | `7f368d509f1fbeb6df669ea5a776f1c7180f2f2328bab3760a810c2a79a69655` |
| `patternly/src/infrastructure/clients/PatternlyApiClientAdapter.ts` | `c3ed90f3a7dda64d2ccadc5bd297792eb6634a2d4b1ccf003c4960698d68ef1c` |
| `patternly/src/application/account/accountDataExportService.ts` | `ba07b6464aa80411bf41a6a464fc14051c2a8557adc108152b51eb94c3e46df9` |
| `patternly-backend/src/modules/progress/accountWireState.ts` | `85e12261a31c59ca373ebbc949a49e84458f3c839a5db0621cb2f4da6c319acf` |
| `patternly-backend/src/modules/progress/contracts.ts` | `53653e1ef05cad693efeff74cdca4ebb79ae1069f991e86c510a07ca69250a3e` |
| `patternly-backend/src/modules/users/merge.ts` | `ae4d73bb20e71fa57d6b925061fe15103cb83aae11febb98cca71c62d9ca4945` |
| `patternly-backend/src/modules/users/adoptionTransfer.ts` | `56be8ea9ab587e19485a2f28e8684f9bd23f5f60b4418f2249b7245f2a9e95b6` |
| `patternly-backend/src/modules/data-export/store.ts` | `152b59a91abaa6cf8f8b6b8a2620cdddcd4c4168952eb3214d0d14a4d71793ee` |
