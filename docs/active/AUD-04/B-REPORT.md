# AUD-04-B — backend node package boundary

**Status:** PASS; verified local-only backend slice. No deployment.  
**Date:** 25 September 2026  
**Scope:** package manifest validation, immutable local byte storage, Firestore current pointer, entitlement-gated download, OpenAPI and backend verification. No app or content repository files changed.

## Contract implemented

`patternly-content-node-package-v1` is strict (`additionalProperties: false` by exact key validation) and contains `trackId`, `nodeId`, `contentVersion`, `artifactSha256`, `packageSha256`, `contentReleaseId`, `minimumAppVersion`, `packageFormat: gzip`, `compressedSizeBytes`, `artifactSizeBytes`, and `packagePath`.

Per the content/backend owner decision for B, the payload is opaque canonical bytes. `packageSha256` hashes the exact gzip bytes; `artifactSha256` hashes the exact bytes after bounded gzip decompression. B does not interpret payload JSON or claim to validate its content semantics or canonicality; that is AUD-04-C producer responsibility. Publication and reads verify both SHA-256 values, both exact sizes, gzip validity, and the configured size limits.

The relative package path is derived exactly as `packages/{trackId}/{nodeId}/{packageSha256}.gzip`. IDs are constrained before path construction, containment is checked against the configured root including resolved parent directories, and symlink/hard-link package files are rejected. Package bytes are immutable. Publication writes and verifies bytes, writes an immutable Firestore manifest, then transactionally switches the `(trackId,nodeId)` pointer. A pre-pointer interruption can leave an unreachable orphan; it cannot replace the active pointer. Old package files and manifests are retained.

Storage has one service boundary and a local filesystem adapter. Configure `CONTENT_PACKAGE_LOCAL_ROOT` with an absolute existing directory for local use. Production configuration rejects this setting; B does not claim to supply a cloud storage adapter or production Premium deployment. `/v1/content/versions` remains unchanged.

`GET /v1/content/packages/{trackId}/{nodeId}` uses `app_check_bearer` and calls the existing RevenueCat reader for the authenticated `request.userId` before looking up a pointer or reading/decompressing package bytes. Active and grace are accepted only when the matching expiry parses to a finite timestamp later than the current time. Denied states return `403 entitlement_required` identically for existing and unpublished nodes, without package-store reads. Reader missing, unavailable, or throwing returns `503 entitlement_unavailable`; invalid IDs return 400; an entitled request for an unknown package returns 404; missing/corrupt stored bytes return `503 package_unavailable`. Success streams exact gzip bytes with `Content-Length`, `Cache-Control: private, no-store`, and the package/artifact hashes and content version headers. No package URI, public URL, or redirect is returned.

OpenAPI declares the gzip response and headers; generated `openapi/patternly-v1.json` matches the runtime route inventory. The shared response-schema check now accepts schemas under any declared response media type, including binary gzip.

## Verification

- Unit package tests: strict manifest, path traversal rejection, package/artifact hash verification, immutable bytes, pointer activation ordering and failed-publication pointer safety.
- Emulator route test: Firebase bearer plus App Check enforcement, unknown package, invalid ID, fresh reader user identity, active/grace delivery, hold/expired/refunded denial, past and unparseable active/grace expiry denial, identical denied responses for existing/unpublished IDs with zero package reads, unavailable/throwing reader, missing/corrupt files, and exact compressed-byte response. Its gzip fixture is written under a temporary local storage root and published through the Firestore pointer adapter.
- `npm run typecheck`: passed.
- `npm run openapi:generate` and `npm run openapi:check`: passed; 58 operations match.
- Targeted package/environment unit tests: 5 passed; targeted emulator route test: passed; `git diff --check`: passed.
- Full backend suite: a first run had 231 passes and two failures. The expected route inventory count (57→58) was corrected; the unrelated concurrent Firestore sync retry test passed in isolation. After the implementation and fail-closed expiry corrections, a controlled repeat against the existing Auth and Firestore emulators passed **233/233**. The earlier concurrency failure was transient and is not hidden from this evidence history.

## Boundary and limitations

This is backend infrastructure with test fixtures only; it does not publish or accept an actual Premium node artifact. There is no content producer, approved node payload semantic validator, cloud object-store adapter, production storage configuration, or mobile installer in this slice. It does not change bundle contents, current mobile runtime ownership, Premium discovery, or `/v1/content/versions`. Local package files are intentionally unsuitable as production storage.

## Assessment

- Objective/architecture fit: **0.91** — uses the existing entitlement reader, App Check bearer guard, and Firestore boundary while leaving `/v1/content/versions` intact.
- Simplicity: **0.86** — one service/storage boundary, one immutable manifest per compressed digest, one mutable pointer per node.
- Risk: **0.83** — bytes/hash and activation ordering are enforced; production serving is intentionally unavailable until cloud storage is separately specified and implemented.
- Maintainability: **0.89** — explicit errors, bounded decompression, strict manifest and immutable paths; no hidden URI fallback.
- Minimum score: **0.83**.
