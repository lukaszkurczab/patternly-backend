# Retention runbook

This is the canonical retention matrix for backend-owned Firestore records.
`expiresAt` is an application-written timestamp; Firestore TTL is an eventual
deletion service, not a transactional expiry guarantee. Readers that expose a
time-limited record must fail closed when its `expiresAt` is in the past.

## Matrix

| Collection group | Terminality/status | Expiry source | Period | Mechanism | Legacy/backfill owner |
| --- | --- | --- | --- | --- | --- |
| `syncOperations` | Created only after a confirmed adoption is materialized | immutable `createdAt` | 30 days | TTL | application TTL writer; user recursive lifecycle owns descendant deletion |
| `syncMutations` | Created only for an applied batch/adoption mutation; conflicts create none | immutable `createdAt` | 30 days | TTL | application TTL writer; user recursive lifecycle owns descendant deletion |
| `contentReports` | Set once at creation; status/unlink does not change it | immutable `createdAt` | 30 days anonymous; 180 days with `accountId` or `contactEmail` at creation | TTL | no automatic backfill |
| `audit` below `contentReports` | Only a non-duplicate status transition | exact verified parent `contentReports.expiresAt` | inherits parent | TTL collection group | historic records without expiry are ODK081 recursive-purge scope |
| `deletionProofs` | `status: deleted` | immutable `completedAt` | 3 years | TTL | no backfill |
| `accountDeletionOperations` | `phase: complete` only | immutable `completedAt` | 3 years | TTL | application TTL writer; pending rows have no expiry |
| `deletedIdentities` | deletion tombstone | immutable `deletedAt` | 45 days | TTL | no backfill |
| `accountDataExportAudits` | completed export audit | creation/completion timestamp | 30 days | TTL | no backfill |
| `accountDataExportRateLimits` | rate-limit window | window start | request window | TTL | no backfill |
| `privacyRequests`, `privacyRequestSecrets`, `privacyResponseArtifacts`, `privacyResponseChunks`, `privacyRequestRateLimits`, `audit` below `privacyRequests` | see privacy-request state machine | store-specific closure/delivery timestamp | module-defined | TTL | privacy-request lifecycle; no manual generic purge |
| `securityIncidents`, `securityIncidentSecrets`, `audit` below `securityIncidents` | closed unless legal hold | immutable `closedAt` | 6 calendar years | TTL | security-incident lifecycle; legal hold writes `null` expiry; no manual generic purge |
| `legalRequests`, `audit` below `legalRequests` | consumer case closed unless legal hold | immutable `closedAt` | 6 calendar years | TTL | complaints, withdrawals, non-personal data recovery and suspension appeals; legal hold writes `null` expiry |
| `legalRequestRateLimits` | first public intake in an hourly bucket | bucket start | 1 hour | TTL | abuse prevention; HMAC key, no raw email |
| `securityIncidentArtifacts`, `securityIncidentDeliveries`, `securityIncidentDeliveryKeys`, `securityIncidentReminders` | artifact/delivery/reminder unless legal hold | immutable creation timestamp | 1 calendar year | TTL | security-incident module; legal hold writes `null` expiry |

`deletionRequests` deliberately has no new TTL policy. It is a historic,
deprecated collection; its identified expired record was removed in the ODK066
approved cloud phase. ODK081 does not own it and must not introduce a generic
automatic delete path.

## Repository and cloud procedure

1. Run `npm run firestore:ttl:check`. It asserts exactly the 20 approved
   collection-group/`expiresAt` policies, including the shared `audit` group.
2. Review the target project and its active TTL policies. The emulator verifies
   writer fields and transaction behavior; it does **not** prove the managed
   Firestore TTL service is enabled or has deleted any document.
3. In the separate approved cloud phase, run
   `npm run firestore:ttl:apply -- --project <project-id>`, then list and
   compare all active TTL policies with `config/firestore-ttl.json`.
4. Record the result, any provider propagation delay and a sample of
   application fail-closed reads. Never use this runbook to delete a live
   document manually.

## Verified cloud state

Read-only discovery for `patternly-app-sandbox` found Firestore Native
STANDARD in `europe-central2`, with PITR disabled and
`versionRetentionPeriod` of `3600s`. It found zero backups, zero backup
schedules and zero active Firestore TTL policies before apply.

The approved cloud phase completed on 2026-09-07:

- all 20 repository-owned Firestore TTL policies report `ACTIVE`;
- PITR reports `POINT_IN_TIME_RECOVERY_ENABLED` with a
  `versionRetentionPeriod` of `604800s` (7 days);
- no additional Firestore backup or backup schedule is configured;
- operational logs remain in `_Default` for 30 days;
- bucket `patternly-security` is active in `europe-central2` with 180-day
  retention;
- sink `patternly-security-retention` routes warning/error events,
  `account_sync_rejected`, `request_failed`, and HTTP 401/403 request logs for
  Cloud Run service `patternly-backend-sandbox` to that bucket;
- the single expired deprecated `deletionRequests` record was deleted with an
  update-time precondition, and a post-delete aggregate query returned zero
  records.

The managed TTL service remains asynchronous even when a policy is `ACTIVE`.
ODK-E2E-081 is limited to controlled cleanup evidence for `contentReports` and
their exact direct `audit` children; it is not a cross-collection orphan purge.

## Reviewed historical content-report purge (ODK-E2E-081)

The non-HTTP command below is the only manual cleanup path. It requires an
explicit target, defaults to dry-run, emits one structural JSON object and has
no scope override:

```sh
npm run retention:purge -- --project <project-id> --database '(default)'
npm run retention:purge -- --project <project-id> --database '(default)' --execute --max-deletes 100
```

It examines only `contentReports` parents and exact
`contentReports/{reportId}/audit/{auditId}` children. A due parent is deleted
with Firestore Admin `recursiveDelete`, which removes its direct audit children.
It may delete an expired audit directly only after a Firestore transaction
rechecks its exact path, current expiry and that its content-report parent still
does not exist. Missing or malformed `expiresAt` and an
unknown `audit` path are reported as incomplete/unresolved; they are never
deleted. `--page-size` only controls deterministic Firestore
pages; it never truncates the scan. `--max-deletes` is the separate, bounded
execution budget (default 100, maximum 1000). Re-run until `complete: true`, `remainingDue: false`
and `unresolved: 0` are reported. `complete` proves the final observed
postcondition for the fixed command cutoff: no due content-report parent and no
due exact orphan audit was observed after cleanup. It does not claim a permanent
quiescent state; valid runtime writers never create an already-expired report.

The shared `audit` TTL policy remains the normal lifecycle mechanism. The purge
never manually touches privacy-request or security-incident audit records:
their lifecycle and legal-hold rules can race a generic cleanup. Firestore TTL
can therefore leave an eventual orphan window after a parent deletion; this
command addresses only the reviewed content-report shape.
