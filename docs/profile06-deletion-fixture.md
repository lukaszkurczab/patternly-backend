# PROFILE-06 account deletion fixture inspector

The inspector resolves an emulator Auth user by email, then requires exactly one `identityMappings` record with `provider: "firebase"` and `subject` equal to the Auth UID. It stores both that local emulator `authUid` and the mapped internal UUID `accountId` in the local fixture manifest: Auth existence/deletion uses `authUid`, while every Firestore account root/query uses `accountId`. `authUid` is only local fixture identity data and must not be copied into repository evidence. The manifest also contains a fixture ID, SHA-256 email digest, signed pre-deletion operation/proof ID baselines, captured Firestore paths, and expected tombstone pseudonyms; the operation and proof IDs are selected only after successful post-delete assertion. It never stores the email, password, token, raw identity subject, or HMAC key. Missing, mismatched, or multiple identity mappings fail closed.

For each fixture run, generate a fresh 32-byte secret as 64 lowercase hexadecimal characters. Keep shell tracing disabled and keep the same private shell/session open through bind, snapshot, assert, and cleanup; do not print, paste, save, or capture the secret in logs. The inspector HMAC-signs the manifest and verifies it before snapshot, assertion, or cleanup. The key never enters the manifest or command output. Placeholder text is rejected by the exact hex-format check. A modified manifest is rejected before destructive work.

Run it from `patternly-backend` with Node 22. Every command requires the exact sandbox project and emulator endpoints:

```sh
export FIREBASE_PROJECT_ID=patternly-app-sandbox
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:19099
export FIRESTORE_EMULATOR_HOST=127.0.0.1:18081
export DELETION_PSEUDONYM_KEYS_JSON='[...]' # same local test key ring used by the backend
set +x
PROFILE06_FIXTURE_HMAC_SECRET="$(openssl rand -hex 32)"
export PROFILE06_FIXTURE_HMAC_SECRET
node --import tsx scripts/profile06-deletion-fixture.ts bind --email fixture@example.test --manifest /tmp/profile06-fixture.json
node --import tsx scripts/profile06-deletion-fixture.ts snapshot-before --manifest /tmp/profile06-fixture.json
```

Complete account deletion for that same Auth user through the normal application flow. The deletion flow generates its operation ID; do not supply or reuse a fixture-selected ID. Then run:

```sh
node --import tsx scripts/profile06-deletion-fixture.ts assert-deleted --manifest /tmp/profile06-fixture.json
node --import tsx scripts/profile06-deletion-fixture.ts cleanup --manifest /tmp/profile06-fixture.json
```

`snapshot-before` refuses to record evidence unless Auth, the exact identity mapping, and a populated `users/{accountId}` root exist. It signs all existing deletion-operation and proof document IDs as baselines. `assert-deleted` requires exactly one operation and exactly one proof added since that snapshot, verifies the proof is bound to that operation, and records both IDs only after verifying Auth absence by `authUid`, the known `users/{accountId}` subtree and account-owned roots are absent, report documents retain their expiry and audit children while account contact fields are removed, tombstones match the captured provider/key-version/HMAC values and 45-day TTL, and the operation/proof pair satisfies the complete stored contract and three-year retention. Zero/multiple additions or any mismatch fail closed. Cleanup is refused until that evidence is present and deletes only paths listed or deterministically bound by the integrity-checked manifest.

Privacy requests and their artifacts/audits, legal requests and their artifacts/audits, security incidents and their artifacts/audits, and global `rateLimitBuckets` are independent retained data. This fixture does not inspect or modify them. Cleanup only targets the account deletion fixture paths captured in its manifest.

Before cleanup, each surviving `identityMappings`, `recoveryCodeIndex`, `sessionRevocationOperations`, or export-audit document is reread and must still name the manifest `accountId`; rate-limit cleanup is allowed only at `accountDataExportRateLimits/{accountId}`. Deletes use a Firestore transaction that rechecks ownership, so an intervening write cannot redirect cleanup to another account's allowed-root document.
