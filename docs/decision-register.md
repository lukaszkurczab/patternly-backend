# Backend decision register

This register is the canonical location for accepted backend decisions and deferred implementation work. It records scope and required verification; it does not grant release approval.

## BE-DEC-001 — Materialize Premium entitlement through RevenueCat (implemented)

| Field | Decision |
| --- | --- |
| Status | implemented locally; production configuration pending |
| Decision | RevenueCat webhooks are the canonical write path for the Premium entitlement projection; `/v1/entitlements` remains the authenticated read model. |
| Identity | The authenticated Patternly user ID is configured as the RevenueCat App User ID. Transfer aliases are resolved only against existing Patternly users. |
| Safety | Authorization, app, environment, product and entitlement are fail-closed. Event delivery is idempotent and projection ordering is monotonic by timestamp plus event ID. |
| Verification | Unit and Firestore Emulator tests cover purchase, renewal semantics, cancellation, expiration, refund outcome, replay, out-of-order delivery and transfer. |
| Production status | Configure the real RevenueCat/App Store identifiers and Secret Manager value, register the HTTPS webhook and complete sandbox/production provider E2E before enabling checkout. |
| Boundaries | Mobile purchase UI and SDK composition belong to ODK-E2E-059. |

Restore is represented by the provider's purchase/renewal events and transfer event, not a separate webhook type.

## BE-DEC-002 — Keep account deletion in the application

| Field | Decision |
| --- | --- |
| Status | superseded by product-owner decision on 2026-09-06 |
| Decision | Account deletion is initiated only from the authenticated application flow. Do not expose an email-initiated deletion request or a public deletion page. |
| Production status | The in-app flow remains canonical, including recent reauthentication, explicit hold confirmation, retry and proof verification. |
| Required verification | Preserve the unauthenticated proof/status endpoints needed after Firebase authentication is removed, but verify that public request/confirmation routes and application links no longer exist. |
| Boundaries | Transactional email is used only for public privacy-right requests. It must never create a second account-deletion initiation path. |

This decision removes the deferred public deletion path rather than implementing it.
