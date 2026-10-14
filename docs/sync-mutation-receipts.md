# Sync mutation receipts — prompt 03 / SOLO-SYNC-01

2026-10-14. Local code/Firestore-emulator acceptance; cloud and release acceptance are separate. Dependency ARCH-09 is already accepted: use `record-fingerprint-json-utf8-v1`, with exact UTF-8 strings and no NFC fallback. QLE is not part of this change. The referenced historical M01 report is absent; the inventory below comes from current source/configuration, not that report.

## Inventory and ownership

| Producer / retained fact | Before this change | Current contract |
| --- | --- | --- |
| `FirestoreProgressStore.applyBatch` → `users/{userId}/syncMutations/{mutationId}` | `deviceId`, `mutationId`, `recordType`, `appliedVersion`, `createdAt`, `expiresAt`; no fingerprint/target/track binding | Writes fingerprint, targetId, recordType and trackId atomically with progress and account revision |
| `FirestoreProgressStore.confirmAdoption` → same collection | Same incomplete shape plus `operationId` | Same complete binding; adoption replay uses its immutable `syncOperations` result |
| Staged adoption `applyAdoptionTransfer` | Progress-generation rows carry `lastMutationId`; changed rows use deterministic adoption IDs, copied rows use `adoption_carry_*` IDs | No `syncMutations` producer; generation promotion, transfer state and markers remain its canonical receipt mechanism |
| `syncBatches` | Full request fingerprint plus immutable result; 30-day expiry | Same-batch replay still uses this receipt; mutation-level checks protect a separate batch |
| Legacy `syncMutations` | The two known writers produced recordType-only binding. Partial rows, missing expiry and malformed present fields are also possible inputs | No migration, backfill, automatic legacy deletion, or renewed expiry |

Search: `rg -n 'syncMutations' src tests scripts config` in backend. Production references to the collection are the two writers/read path in [store.ts](../src/modules/progress/store.ts); [merge.ts](../src/modules/users/merge.ts) supplies the existing fingerprint, not another receipt writer. This is an inventory of repository producers and persisted shapes, **not a scan or count of live Firestore documents**. Actual cloud population, field completeness and deployed TTL policy state were not inspected. No operation in this package depends on guessing those counts.

`syncMutations`, `syncBatches` and one-shot `syncOperations` use `expiresAt = createdAt + 30 days`, with no extension on replay. [TTL config](../config/firestore-ttl.json), [checker](../scripts/check-firestore-ttl.mjs) and [retention runbook](retention-runbook.md) retain the existing policies. Missing/non-timestamp expiry is not automatically repaired. An expired receipt that still exists remains identity evidence; elapsed time alone never authorizes a new write. Firestore TTL is eventual deletion; the emulator does not execute the managed TTL service.

## Replay decision

All incoming records first pass the existing schema/content checks and recomputed canonical fingerprint. The scope of mutation IDs is the user account, including across devices and progress generations.

| Available evidence in a separate batch | Decision |
| --- | --- |
| Complete receipt with all four fields equal | Duplicate, no progress write, even if valid current progress has since changed or is absent; malformed present progress still fails its existing read validation |
| Any present receipt binding differs (including null/malformed values) | `mutation_id_reuse`, transaction abort; no ACK, progress/revision/receipt/batch write |
| Incomplete receipt | Duplicate only if every present binding agrees and the exact current record has equal fingerprint/target/type/track **and** the same `lastMutationId`; otherwise `mutation_id_reuse` |
| No receipt, but exact current record has the same `lastMutationId` | Same exact-witness check; duplicate without recreating the receipt |
| No receipt or matching lastMutationId | Existing optimistic account-revision and record-version checks apply. An unchanged old request is not refreshed to current versions to make it succeed |

Unresolvable old receipts stay untouched and return the existing explicit conflict. This may require a separate, evidence-based repair decision for a concrete old record; it is preferable to acknowledging an identity that cannot be established. No repair path or mass migration is introduced. Mutation-ID reuse rejection remains HTTP 409 `{error:{code:"mutation_id_reuse"}}`.

After TTL deletion, an exact surviving current record still proves the retry. If a newer record supersedes it, the unchanged old request encounters revision/version conflict. If both the receipt and target record are absent, the unchanged original account revision is stale because its first write advanced the revision. TTL alone is not a permanent mutation-ID reservation: requests with changed metadata after all durable witnesses disappear are outside that guarantee. The separate retention/replay-protection work in SEC-07 remains in the canonical plan. No claim of reproduced data loss in the normal client is made here.

## Client preservation

No APP production code changed. [accountDataService](../../patternly/src/application/account/accountDataService.ts) still validates ACK coverage and reads remote progress after upload. `duplicateMutationAcknowledgements` requires one exact remote record for each duplicate ID, comparing fingerprint/target/type/track. An old complete receipt can correctly return duplicate after a later write; if the client cannot verify that ACK by its readback, it keeps the outbox and exposes `duplicate_ack_unverified`. Receipt acceptance does not bypass this control.

## Acceptance evidence

Run on 2026-10-14 with Node v24.21.0, installed dependencies and real Firebase Admin SDK against isolated local Auth/Firestore emulators. The existing runner checks localhost ports and requires a `demo-*` project; it does not reset a shared emulator or use a live account. No iOS/Android device operation was needed or performed. The installed Node 22.9.0 is below APP's declared minimum 22.13.0; these results do not establish the release Node 22 environment.

| Check | Result / boundary |
| --- | --- |
| `node scripts/run-sync-receipt-tests.mjs` | 19/19 PASS: 7 new receipt tests plus 12 existing progress storage tests; isolated `demo-patternly-sync-receipts` |
| New receipt tests | A→retry A→B in separate batches; changed state/target/type/track and an unrelated write in the rejected batch; full receipt after newer/absent current; all 15 incomplete binding combinations; contradictory present fields; TTL-deleted receipt without recreation; adoption receipt and replay; authenticated HTTP 409 with no false ACK |
| APP focused lifecycle command below | 3/3 PASS: exact readback permits ACK; unconfirmed duplicate preserves identical outbox and last-success state; timeout retries exact persisted request. Test API with memory storage, not native MMKV/live transport |
| BACKEND `npm run typecheck`, `npm run lint`, `npm run firestore:ttl:check` | PASS; 34 unchanged TTL policies |
| BACKEND `git diff --check` | PASS |
| Independent design review and acceptance QA | Luna high, read-only reviewer; scoped local PASS, actual source/diff/tests/docs inspected independently; command results reused, not independently rerun |

Reproduce the APP check from the APP repository:

```sh
node --import tsx --test --test-name-pattern='unconfirmed duplicate|durable terminal learning commit|ambiguous account-sync timeout' src/application/account/accountLifecycle.test.ts
```

Source identities for this local acceptance (uncommitted workspace, SHA-256):

| File | SHA-256 |
| --- | --- |
| BACKEND `src/modules/progress/store.ts` | `fefb22e54322062a61a1cbca36818b44da7f7348c0f800c0d3a5c2917bd72bec` |
| BACKEND `tests/syncMutationReceipts.emulator.test.ts` | `1dae25d0521f0282d12363dcfdba78be93d361d1f5445c724719c9f766f14ce0` |
| BACKEND `scripts/run-sync-receipt-tests.mjs` | `e64c289576a191f8ac5a45a3fbfde8a7aaed09546ae86d6a6e46a5fc2f373ca4` |
| APP `src/application/account/accountDataService.ts` (unchanged) | `8fcba6bff28c90a573166707497db550fa0b6732167b0ec1196d0c4a5dd6aa77` |
| APP `src/application/account/accountLifecycle.test.ts` (unchanged) | `96ce7232403079d2b318dc026222e68bd08ffa7d495dc52f97dc3608ab0c6940` |

The TTL-deletion test deletes only its isolated fixture receipt; the absent-current test deletes only its isolated fixture progress. These are tests of missing evidence, not a production purge or a new deletion implementation. The no-write assertions compare progress, account metadata, mutation receipts and batch receipts before/after rejection.

Own package: `src/modules/progress/store.ts`, `tests/syncMutationReceipts.emulator.test.ts`, `scripts/run-sync-receipt-tests.mjs`, this contract and its retention-runbook link; canonical workspace plan/state updated at acceptance. Pre-existing ARCH-09 source/tests and APP documentation WIP remain separate and unchanged. No replaced production path was deleted: the partial permissive replay checks were replaced by one shared binding check used by both receipt producers. No new schema version, fallback, feature flag, dependency or endpoint was added. Full suites, native storage, cloud state, deployment, external CI and publication were not exercised.

Approach review: fit **0.96**, simplicity **0.94**, risk **0.86**, maintainability **0.94** (minimum **0.86**). One small binding helper keeps both writers and the replay comparator consistent; exact legacy witnesses avoid speculative migration and protect retry identity. These scores assess the chosen local approach, not release readiness.
