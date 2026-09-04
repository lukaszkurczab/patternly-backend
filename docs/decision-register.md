# Backend decision register

This register is the canonical location for accepted backend decisions and deferred implementation work. It records scope and required verification; it does not grant release approval.

## BE-DEC-001 — Materialize Premium entitlement through RevenueCat

| Field | Decision |
| --- | --- |
| Status | deferred |
| Confirmed gap | The backend has no canonical path that writes a Premium entitlement projection from RevenueCat. `/v1/entitlements` only reads Firestore projections. |
| Deferral reason | Deferred only by the owner's explicit decision: current individual application testing does not include a paid subscription. |
| Production status | Premium is not ready for a production launch. |
| Required before | Complete this work before paid-subscription testing or any Premium release. |
| Recommended implementation | Accept RevenueCat webhooks in the backend, verify their signatures, process provider events idempotently, and write the canonical account entitlement projection to Firestore. |
| Required verification | Add backend tests for purchase, renewal, expiration, and restore, including signature verification and idempotent replay. |
| Boundaries | Do not implement RevenueCat while this decision is deferred. Do not represent Premium as production-ready without the canonical write path and required verification. |

This is a deferred implementation decision, not evidence that RevenueCat integration or Premium production readiness exists.

## BE-DEC-002 — Compose public account-deletion email delivery

| Field | Decision |
| --- | --- |
| Status | deferred |
| Confirmed gap | The production entrypoint does not compose a `DeletionEmailSender`, while the public deletion-request route returns `deletion_email_unavailable` without one. Existing emulator tests inject a test sender and therefore do not exercise production composition. |
| Deferral reason | Deferred only by the owner's explicit decision: current individual application testing does not require production email delivery. |
| Production status | The public account-deletion request path is not ready for production availability. |
| Required before | Complete this work before exposing the public account-deletion request path in production. |
| Required implementation | Compose a production `DeletionEmailSender` in the backend entrypoint, configure its runtime data securely, and add a production-composition test. |
| Required verification | Preserve the existing emulator tests, but do not treat them as production-readiness evidence. Add a composition test proving that the configured production path does not fail because an email sender is absent. |
| Boundaries | Do not implement email delivery while this decision is deferred. Do not represent the public account-deletion path as production-ready without secure runtime configuration and composition evidence. |

This is a deferred implementation decision, not evidence that public account-deletion email delivery is configured or production-ready.
