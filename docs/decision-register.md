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

## BE-DEC-003 — Keep all user data-rights initiation in application Settings

| Field | Decision |
| --- | --- |
| Status | accepted by Product Owner on 2026-09-10; implementation and removal work pending |
| Decision | Every user-initiated privacy and data-rights request starts only in the Patternly application under `Settings`. The hosted public web does not expose intake, verification-link, response-session or account-login routes. |
| Web boundary | The hosted site is marketing-only. The administrator panel is a Product Owner-only local workspace and is never hosted or bundled into the public artifact. |
| Current conflict | The existing `/v1/public/privacy-requests` API family, `PrivacyRequestPage`, Firebase Hosting rewrites, public-origin/SMTP flow and hosted admin entry contradict the accepted target and require scoped removal or replacement. |
| Required follow-up | Define the authenticated and guest states of the in-app Settings flow, remove obsolete public-browser contracts and evidence, split local admin from the public build, and add negative deployment tests. |
| Safety | Removing the public browser path must not remove the in-app ability to exercise applicable data rights or the local Product Owner workflow for reviewing requests. |

The Product Owner approved the account-state split on 2026-09-10: authenticated requests are account-bound; guests reset device-only data locally and may submit an in-app email-based request for data created through network features. Guest verification must return to the application or another non-web completion mechanism; it cannot recreate the removed public browser response surface.

BE-DEC-003 supersedes the BE-DEC-002 boundary that reserved transactional email for public privacy-right requests. BE-DEC-002 remains authoritative for application-only account deletion.

## BE-DEC-004 — Require App Check for protected mobile requests

| Field | Decision |
| --- | --- |
| Status | accepted by Product Owner on 2026-09-10; implementation is partial; real-provider verification pending |
| Decision | App Check proves application authenticity, not user identity. Every protected mobile request requires valid App Check. Signed-in operations additionally retain Firebase Authentication and recent reauthentication where required. |
| Anonymous mobile | Content reports and guest legal/data/privacy requests initiated in the application require App Check plus their existing rate-limit, schema and idempotency controls. |
| Failure | Missing, invalid or unavailable attestation fails closed. Production has no bypass or optimistic success. The application exposes unavailable/retry, and backend operations monitor sanitized rejection counts and reasons. |
| Web and admin | Hosted web is marketing-only and receives no mobile App Check. The legacy public privacy flow is removed under BE-DEC-003 rather than attested. The loopback-only administrator workspace uses Firebase Authentication and administrator authorization, not mobile App Check. |
| Test boundary | Local/emulator tests use explicit debug configuration/tokens. Production artifacts reject debug configuration. |
| Canonical plan | `../../docs/APP-CHECK-DECISION-AND-DELIVERY-PLAN.md` owns the channel matrix, APPCHK-01–04 delivery tasks and ODK-E2E-084 provider evidence. |

Current source and OpenAPI prove only a partial implementation and remain evidence to reconcile in APPCHK-01/02. They do not prove the accepted matrix or a real provider.
