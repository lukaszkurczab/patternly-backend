import assert from "node:assert/strict";
import test from "node:test";

import {
  guestMergeConfirmationSchema,
  guestMergePreviewSchema,
  validateGuestMergeConfirmation,
} from "../src/modules/users/merge.js";

const preview = guestMergePreviewSchema.parse({
  accountSnapshotVersion: 4,
  accountUserId: "11111111-1111-4111-8111-111111111111",
  conflicts: [{
    accountVersion: 2,
    conflictId: "item_progress:item-1",
    guestVersion: 3,
    recordId: "item-1",
    recordType: "item_progress",
  }],
  fingerprint: "a".repeat(64),
  guestSnapshotVersion: 7,
  guestUserId: "22222222-2222-4222-8222-222222222222",
  operationId: "33333333-3333-4333-8333-333333333333",
  protocolVersion: 1,
});

test("guest merge requires an explicit resolution for every preview conflict", () => {
  const confirmation = guestMergeConfirmationSchema.parse({
    operationId: preview.operationId,
    previewFingerprint: preview.fingerprint,
    protocolVersion: 1,
    resolutions: [{ conflictId: "item_progress:item-1", resolution: "keep_guest" }],
  });
  assert.deepEqual(validateGuestMergeConfirmation(preview, confirmation), {
    confirmation,
    preview,
    status: "ready_to_execute",
  });
});

test("guest merge rejects stale previews and unresolved conflicts", () => {
  const stale = guestMergeConfirmationSchema.parse({
    operationId: preview.operationId,
    previewFingerprint: "b".repeat(64),
    protocolVersion: 1,
    resolutions: [{ conflictId: "item_progress:item-1", resolution: "keep_account" }],
  });
  assert.throws(() => validateGuestMergeConfirmation(preview, stale), { message: "merge_preview_mismatch" });

  const unresolved = guestMergeConfirmationSchema.parse({
    operationId: preview.operationId,
    previewFingerprint: preview.fingerprint,
    protocolVersion: 1,
    resolutions: [{ conflictId: "item_progress:item-1", resolution: "manual_required" }],
  });
  assert.throws(() => validateGuestMergeConfirmation(preview, unresolved), { message: "merge_conflict_requires_manual_resolution" });
});
