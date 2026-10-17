// Explicit scope for injected reader doubles; never used by a service loader.
export const premiumSnapshotScope = Object.freeze({
  projectId: "fixture-project",
  mapVersion: "premium-map-fixture-v1",
  environment: "SANDBOX" as const,
  reason: null,
  sources: [],
});
