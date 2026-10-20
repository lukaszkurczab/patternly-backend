import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Compare complete matching COST-02 matrices, including opt-in repeated-history
// observations. Historical price input is the accepted COST-02 snapshot, not a
// refreshed quote. Local duration/RSS are observations, never Cloud Run billing.
export function compare(before, after, prices) {
  assert.equal(before.schema, "cost02-client-matrix-v1");
  assert.equal(after.schema, before.schema);
  assert.equal(after.source.frontendSha, before.source.frontendSha);
  assert.equal(after.source.backendHead, before.source.backendHead);
  assert.equal(after.source.backendHarnessSha256, before.source.backendHarnessSha256);
  for (const key of ["packageFixtureSha256", "packageFixtureManifestSha256", "packageFixtureProvenanceSha256", "lifecycleHelperSha256"]) assert.equal(after.source[key], before.source[key]);
  const a = new Map(before.scenarios.map((row) => [row.name, row]));
  assert.equal(a.size, before.scenarios.length);
  assert.deepEqual(after.scenarios.map((row) => row.name), before.scenarios.map((row) => row.name));
  const rows = after.scenarios.map((next) => {
    const previous = a.get(next.name);
    assert.deepEqual(next.metadata, previous.metadata);
    assert.equal(next.error, previous.error, next.name);
    if (next.name.includes("history_")) assert.deepEqual(next.result, previous.result);
    const oldFlow = before.flowObservations.find((row) => row.id === next.name);
    const newFlow = after.flowObservations.find((row) => row.id === next.name);
    const counts = (s, f) => ({ http: s.metrics.httpAttempts, authRpc: s.metrics.authSdkRequests, sdkDocumentSnapshots: s.metrics.observedSdkReadDocuments,
      estimatedDocumentReadUnits: f.firestoreReadsBillableEstimate, writes: s.metrics.firestoreWrites, deletes: s.metrics.firestoreDeletes,
      responseJsonBytes: s.metrics.responseBodyBytes, elapsedMs: s.metrics.elapsedMs, nodeCpuMs: s.metrics.nodeCpuUserMs + s.metrics.nodeCpuSystemMs,
      rssBeforeBytes: s.metrics.rssBeforeBytes, rssAfterBytes: s.metrics.rssAfterBytes });
    const b = counts(previous, oldFlow); const n = counts(next, newFlow);
    assert.equal(n.authRpc, b.authRpc, next.name);
    assert.equal(n.writes, b.writes, next.name);
    assert.equal(n.deletes, b.deletes, next.name);
    assert.ok(n.http <= b.http, next.name);
    assert.ok(n.estimatedDocumentReadUnits <= b.estimatedDocumentReadUnits, next.name);
    const saved = { estimatedDocumentReadUnits: b.estimatedDocumentReadUnits - n.estimatedDocumentReadUnits, http: b.http - n.http, responseJsonBytes: b.responseJsonBytes - n.responseJsonBytes };
    const per1000 = { documentReads: saved.estimatedDocumentReadUnits * prices.rates.firestore.readsPer100000 / 100,
      responseEgress: saved.responseJsonBytes * 1000 / 2 ** 30 * prices.rates.cloudRun.internetEgressEurope[0].pricePerGiB,
      requestCount: saved.http * prices.rates.cloudRun.requestsPerMillion / 1000 };
    return { name: next.name, before: b, after: n, saved, modeledUsdPer1000IdenticalOperations: { ...per1000, subtotal: Object.values(per1000).reduce((sum, value) => sum + value, 0) } };
  });
  const repeats = rows.filter((row) => /^account_history_\d+_unchanged$/u.test(row.name));
  const changed = rows.filter((row) => /^account_history_\d+_changed_sync$/u.test(row.name));
  assert.ok(changed.length === 0 || changed.length === 4);
  assert.equal(repeats.length, 4);
  for (const row of repeats) {
    assert.equal(row.after.http, 1);
    assert.equal(row.after.sdkDocumentSnapshots, 8);
    assert.ok(changed.length === 0 ? row.saved.estimatedDocumentReadUnits > 0 : row.saved.estimatedDocumentReadUnits >= 0);
  }
  for (const row of changed) {
    assert.equal(row.after.http, 2, "one unchanged write request plus one guarded revalidation");
    assert.ok(row.saved.estimatedDocumentReadUnits > 0);
  }
  return { schema: "cost03-comparison-v1", scope: `same COST-02 workloads plus four repeated-history probes${changed.length ? " and four owned changed-sync probes; baseline includes accepted unchanged-read optimization" : ""}; live adapter cache only`, pricesSnapshotDate: prices.pricingVerifiedOn,
    costBoundary: "USD gross list rates from accepted COST-02 input, document-unit estimate plus response JSON egress in first Europe tier and request count only; no free tiers, FX, VAT, index-entry reads, TLS/header bytes, CPU savings or whole-project forecast. Emulator counts do not establish provider billing.",
    lifecycleBoundary: "The COST-02 cold_start_account fixture restarts Auth SDK but reuses this adapter; its cache saving is not a native/JS process restart saving. A new adapter always downloads a full sweep.", rows };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [beforePath, afterPath, outputPath] = process.argv.slice(2);
  if (!beforePath || !afterPath || !outputPath) throw new Error("cost03_comparison_paths_required");
  const inputs = await Promise.all([beforePath, afterPath, new URL("../cost02/cost02-prices.json", import.meta.url)].map((path) => readFile(path)));
  const result = compare(...inputs.map((bytes) => JSON.parse(bytes.toString())));
  result.inputSha256 = inputs.map((bytes) => createHash("sha256").update(bytes).digest("hex"));
  await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");
  const summarize = (row) => ({ name: row.name, saved: row.saved, modeledUsdPer1000: row.modeledUsdPer1000IdenticalOperations.subtotal });
  console.log(JSON.stringify({ result: "PASS", scenarios: result.rows.length,
    repeats: result.rows.filter((row) => row.name.endsWith("_unchanged")).map(summarize),
    changedSync: result.rows.filter((row) => row.name.endsWith("_changed_sync")).map(summarize) }));
}
