# Independent acceptance recorded by controller — 2026-10-26

Reviewer /root/bootstrap_qa, qa_luna/gpt-6-luna/high: final PASS after namespace correction. Controller transcription of independent responses; not a reviewer-authored file. First design minimum.92, namespace correction minimum.95.

Final v2 document ID is v2_ plus64hex SHA256 of raw ordered versioned JSONtuple, disjoint from all barehex v1. Exact v2 pair/fingerprint and legal correctly-addressed v1 pair replay are guarded transactionally before writes. Foreign legal v1 collision ignored; malformed identity fails closed. New receipts v2-only. Auth/generation/adoption lease/CAS/per-mutation guards and30-dayTTL unchanged.

Two actual REDs: delimiterpair falsemutation_id_reuse, then legal v1/v2samepreimage sync_batch_invalid. Final realFirestore31/31, APPconsumer3/3, typecheckexit0/diff-check PASS. The no-reapply old-model conclusion uses unchanged per-mutation/current-record/CAS code after missing batch lookup and equivalent real emulator branches, including retry in another batch, TTL deletion and concurrent identical100. No full old-binary runtime/original-v2response or rollbackavailability claim. Old v1 collision may still409. CCAR wire WIP preserved. Isolated services/data stopped, no Cloud/rollout/device claim. Earlier before-namespace records remain historical superseded evidence.
