# Current canonical ACM.B01 APP account-wire fixture

- APP private source: `../.agent/private/acm-close-contract-20261030/current-bank-account-wire-fixture.json` relative to the APP repository root (workspace private evidence package).
- Versioned BACKEND copy: `tests/fixtures/account-wire/acm-actual-export.json`.
- SHA-256: `35588c58c39b32315da0fd8b7724421d00467235d424f49c35bcfcc448f9b82d`; source and backend copy are exact byte copies.
- Producer: `buildAccountDataSnapshot()` in `approachChallengeLifecycleJournal.test.ts`, using `startActualProductionBankSession()` and canonical problem `acm-b01-01`; the test drives Q1 partial/0, Q2 correct/1, completes the real lifecycle, validates the account snapshot, applies it to fresh in-memory storage, checks restored attempts/session/result pins, then resolves imported detailed history against the exact ACM artifact.
- Reproduce from the APP repository root with: `ACM_CURRENT_BANK_WRITE_ACCOUNT_WIRE_FIXTURE=1 node --import tsx --test --test-concurrency=1 --test-name-pattern='current canonical ACM.B01 bank exports and restores exact pinned account-wire records' src/application/coding-interview/approachChallengeLifecycleJournal.test.ts`.
- Source bank identity: track `coding-interview-dsa-problem-solving`, content version `coding-interview-dsa-problem-solving-authoring-v2026.10.02-bizq01-04-bizq02-v2-bizq03-planning-v2-dsa-20261024-fixes-v1`, canonical source artifact SHA-256 `f1f3277cc0a5a50289bc8edc921270aebed8d8bf4080ad328e9000d90c7159e1`.
- ACM runtime/session/item identity: same track/content version, raw source artifact SHA-256 `f1f3277cc0a5a50289bc8edc921270aebed8d8bf4080ad328e9000d90c7159e1`.
- Ordinary training identity: same track/content version, predecessor artifact SHA-256 `a85fb2ca9f57315d76f34627c109aa8ebc25536c4b4684356d97236a09145a2d`; it remains unchanged by the ACM-specific runtime view.
- Records: exactly four: completed session summary, Q1 attempt `acm-b01-01-q1` (`approach_choice`, partial/0), Q2 attempt `acm-b01-01-q2` (`choice_single`, correct/1), and ACM session result. No legacy record is synthesized into this fixture; the contract suite separately checks the APP-produced legacy fixture.
- The historical ACM.5 private fixture at `patternly/.agent/private/acm5-20261030/account-wire-fixture.json` is preserved and is not the source for this current-bank fixture.
