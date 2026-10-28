# Independent acceptance recorded by controller — 2026-10-26

Reviewer /root/bootstrap_qa, qa_luna/gpt-6-luna/high: design GO .97/.95/.93/.92; final PASS. This is controller transcription of independent replies, not a reviewer-authored report.

The versioned ordered JSON tuple separates delimiter and raw Unicode identities. v2 pair/fingerprint and exact v1 pair replay are guarded before mutation-dependent reads/writes. Valid foreign v1 collision is ignored; malformed identity fails closed. New receipts are v2-only; auth/generation/adoption lease/CAS/per-mutation guards and30-dayTTL remain.

Actual RED falsemutation_id_reuse, green realFirestore30/30, APPconsumer3/3, typecheck anddiff-check PASS. Collision pairs, exact legacy/current replay, payloadreuse, concurrent100idempotency, legalUnicode, malformedreceipts, TTL/no-renewal andboundedreads verified. The no-reapply old-model conclusion uses unchanged per-mutation/current-record/CAS code after missing batch lookup and equivalent real emulator branches, including retry in another batch and TTL deletion. No full old-binary runtime or original-v2response/rollbackavailability claim. Old v1 collision can still409; not a missing local acceptance criterion. Existing CCAR wire WIP preserved.
