# Backend CI — checkout web API consumer

Date: 2026-09-07

## Cause

GitHub Actions run `34141451498` passed lint, typecheck, the 22-policy TTL contract, 110 emulator tests and OpenAPI verification. It then failed in `frontend:client:check` with `ENOENT` for `patternly-web/src/pages/PrivacyRequestPage.jsx`.

The contract checker reads both sibling consumers, `patternly` and `patternly-web`. The workflow checked out only the backend and mobile repository, so its filesystem did not satisfy the checker's explicit input contract.

## Change

`.github/workflows/ci.yml` now checks out `lukaszkurczab/patternly-web` from `main` into sibling path `patternly-web`, matching the existing local layout and the path used by `scripts/check-frontend-client.mjs`.

Runtime code and the client contract checker were not changed.

## Independent validation

- model: `gpt-5.6-luna`;
- reasoning effort: `max`;
- consistency: `0.94`;
- simplicity: `0.97`;
- risk: `0.86`;
- maintainability: `0.88`;
- decision: `APPROVE`.

The remaining accepted risk is that both consumer repositories use a moving `main`. This matches the existing mobile checkout strategy. Repository access by the workflow token must be proven by the post-push run.

## Verification

- local `npm run frontend:client:check`: PASS, 26 public versioned paths covered by the mobile and web consumers;
- local `npm run ci`: PASS, including lint, typecheck, 22-policy TTL contract, `110/110` emulator tests, OpenAPI check, frontend client check and build;
- workflow diff and whitespace validation: PASS;
- post-push Backend CI run through completion: pending until the fix commit is pushed.
