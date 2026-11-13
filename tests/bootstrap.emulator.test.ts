import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { localSmokeRevenueCatEntitlementReader } from "../scripts/localSmoke.js";
import type { ProgressMutation } from "../src/modules/progress/contracts.js";
import { createMergeRecordFingerprint } from "../src/modules/users/merge.js";
import { attemptState } from "./progressFixtures.js";
import { createEmulatorContext, createVerifiedRegisteredAuthUser, TEST_APP_CHECK_TOKEN, type EmulatorContext } from "./support.js";

const trackId = "coding-interview-dsa-problem-solving";
const deviceId = "00000000-0000-4000-8000-000000000000";
const context = createEmulatorContext({ revenueCatEntitlementReader: localSmokeRevenueCatEntitlementReader("active") });
const withoutReader = createEmulatorContext();
const accounts: string[] = [];

test.after(async () => {
  for (const id of accounts) await context.db.recursiveDelete(context.db.collection("users").doc(id));
  await context.close();
  await withoutReader.close();
});

function mutation(targetId: string): ProgressMutation {
  const state = attemptState(targetId, trackId);
  return { mutationId: `mutation-${randomUUID()}`, kind: "item", recordType: "training_attempt", trackId, targetId, expectedVersion: null, state, fingerprint: createMergeRecordFingerprint({ recordId: targetId, recordType: "training_attempt", trackId, state }) } as ProgressMutation;
}

async function account(target: EmulatorContext = context, records = 0) {
  const registered = await createVerifiedRegisteredAuthUser(target);
  accounts.push(registered.userId);
  let revision = 0;
  for (let index = 0; index < records; index += 50) {
    const batch = Array.from({ length: Math.min(50, records - index) }, (_, offset) => mutation(`bootstrap-${index + offset}`));
    revision = (await target.stores.progress.applyBatch(registered.userId, 1, deviceId, revision, batch, { sessionId: "bootstrap-seed", batchId: randomUUID(), highWatermark: 1 })).accountRevision;
  }
  await target.db.collection("users").doc(registered.userId).collection("trackAccess").doc(trackId)
    .set({ trackId, source: "subscription", status: "active", updatedAt: new Date("2026-11-13T00:00:00.000Z") });
  return { userId: registered.userId, headers: { authorization: `Bearer ${registered.idToken}`, "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } };
}

/**
 * Entitlement reads stamp wall-clock observation times, and the local RevenueCat
 * fixture derives its expiry from the read time; everything else must be identical.
 */
const WALL_CLOCK_KEYS = new Set(["serverObservedAt", "providerObservedAt", "providerExpiresAt"]);
function withoutObservationTimes(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, entry) => WALL_CLOCK_KEYS.has(key) ? "<time>" : entry));
}

async function standalone(target: EmulatorContext, url: string, headers: Record<string, string>) {
  const response = await target.app.inject({ method: "GET", url, headers });
  return { status: response.statusCode, body: response.json() as unknown };
}

test("GET /v1/bootstrap equals the standalone start-up routes component by component", async () => {
  const { headers } = await account(context, 130);
  const response = await context.app.inject({ method: "GET", url: "/v1/bootstrap", headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.match(String(response.headers["server-timing"]), /^me;dur=[\d.]+, entitlements;dur=[\d.]+, progress;dur=[\d.]+, tracks;dur=[\d.]+, total;dur=[\d.]+$/u);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ["bootstrapVersion", "components", "serverObservedAt"]);
  assert.equal(body.bootstrapVersion, 1);
  assert.deepEqual(Object.keys(body.components), ["me", "entitlements", "progress", "tracks"]);

  assert.deepEqual(body.components.me, await standalone(context, "/v1/me", headers));
  assert.deepEqual(withoutObservationTimes(body.components.entitlements), withoutObservationTimes(await standalone(context, "/v1/entitlements", headers)));
  assert.equal(body.components.entitlements.status, 200);
  assert.deepEqual(body.components.progress, await standalone(context, "/v1/progress?pageSize=100&conditional=1", headers));
  assert.deepEqual(body.components.tracks, await standalone(context, "/v1/tracks", headers));
  assert.equal(body.components.tracks.body.tracks.length, 1);

  // The first page continues through the existing paginated route with the same snapshot validator.
  const progress = body.components.progress.body;
  assert.equal(progress.records.length, 100);
  assert.equal(typeof progress.nextPageToken, "string");
  const next = await context.app.inject({ method: "GET", url: `/v1/progress?pageSize=100&conditional=1&pageToken=${encodeURIComponent(progress.nextPageToken)}`, headers });
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().records.length, 30);
  assert.equal(next.json().nextPageToken, null);
  assert.equal(next.json().snapshotToken, progress.snapshotToken);
});

test("bootstrap progress revalidates a known snapshot exactly like conditional GET", async () => {
  const { headers } = await account(context, 20);
  const first = (await context.app.inject({ method: "GET", url: "/v1/bootstrap?include=progress", headers })).json();
  assert.deepEqual(Object.keys(first.components), ["progress"]);
  const known = first.components.progress.body;
  const bySnapshot = await context.app.inject({ method: "GET", url: `/v1/bootstrap?include=progress&progressKnownSnapshot=${known.snapshotToken}`, headers });
  assert.equal(bySnapshot.statusCode, 200, bySnapshot.body);
  assert.deepEqual(bySnapshot.json().components.progress, await standalone(context, `/v1/progress?pageSize=100&conditional=1&knownSnapshot=${known.snapshotToken}`, headers));
  assert.equal(bySnapshot.json().components.progress.body.unchanged, true);
  const byScope = await context.app.inject({ method: "GET", url: `/v1/bootstrap?progressKnownScope=${known.snapshotScope}&progressKnownRevision=${known.accountRevision}`, headers });
  assert.equal(byScope.statusCode, 200, byScope.body);
  assert.deepEqual(byScope.json().components.progress, await standalone(context, `/v1/progress?pageSize=100&conditional=1&knownScope=${known.snapshotScope}&knownRevision=${known.accountRevision}`, headers));
});

test("a failing component keeps its standalone error and does not fail the aggregate", async () => {
  const { headers } = await account(withoutReader, 3);
  const response = await withoutReader.app.inject({ method: "GET", url: "/v1/bootstrap", headers });
  assert.equal(response.statusCode, 200, response.body);
  const { components } = response.json();
  assert.deepEqual(components.entitlements, { status: 503, body: { error: { code: "revenuecat_read_unavailable" } } });
  assert.deepEqual(components.entitlements, await standalone(withoutReader, "/v1/entitlements", headers));
  assert.equal(components.me.status, 200);
  assert.equal(components.progress.status, 200);
  assert.equal(components.progress.body.records.length, 3);
  assert.equal(components.tracks.status, 200);
});

test("bootstrap rejects malformed queries after authentication and before reading", async () => {
  const { headers } = await account(context);
  for (const query of ["include=content", "include=me,me", "pageSize=10", `include=me&progressKnownSnapshot=${"a".repeat(64)}`, "progressKnownRevision=1"]) {
    const response = await context.app.inject({ method: "GET", url: `/v1/bootstrap?${query}`, headers });
    assert.equal(response.statusCode, 400, query);
    assert.deepEqual(response.json(), { error: { code: "invalid_request" } });
  }
  const noAppCheck = await context.app.inject({ method: "GET", url: "/v1/bootstrap", headers: { authorization: headers.authorization } });
  assert.equal(noAppCheck.statusCode, 401);
  assert.deepEqual(noAppCheck.json(), { error: { code: "app_check_required" } });
  const noBearer = await context.app.inject({ method: "GET", url: "/v1/bootstrap", headers: { "x-firebase-appcheck": TEST_APP_CHECK_TOKEN } });
  assert.equal(noBearer.statusCode, 401);
  assert.deepEqual(noBearer.json(), { error: { code: "authentication_required" } });
});
