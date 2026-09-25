import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { loadEnvironment } from "../src/config/environment.js";
import { createOperatorTokenVerifier, createPublicOnlyLookup } from "../src/infrastructure/operator/oidcVerifier.js";

const issuer = "https://accounts.example.test";
const audience = "patternly-operators";
const jwksUrl = "https://keys.example.test/.well-known/jwks.json";
const subject = "operator-sensitive-subject";
const baseNow = Date.parse("2026-09-25T12:00:00.000Z");

const environment = loadEnvironment({
  NODE_ENV: "test",
  REPORT_RATE_LIMIT_HASH_SECRET: "test-only-report-rate-limit-secret-0123456789",
  DELETION_PSEUDONYM_KEYS_JSON: "[]",
  PRIVACY_RESPONSE_KEY_BASE64: "test-only-privacy-response-key",
  PRIVACY_AUDIT_HMAC_SECRET: "test-only-privacy-audit-secret-0123456789",
  OPERATOR_OIDC_ISSUER: issuer,
  OPERATOR_OIDC_AUDIENCE: audience,
  OPERATOR_OIDC_JWKS_URL: jwksUrl,
  OPERATOR_ALLOWLIST_JSON: JSON.stringify([{ subject, role: "privacy_operator", actions: ["privacy_requests:read", "privacy_requests:action"] }]),
});

const first = generateKeyPairSync("rsa", { modulusLength: 2048 });
const second = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = (key: typeof first.publicKey, kid: string) => ({ ...key.export({ format: "jwk" }), kid, kty: "RSA", use: "sig", alg: "RS256" });

function token(input: Readonly<{ kid?: string; alg?: string; claims?: Record<string, unknown>; key?: typeof first.privateKey }> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: input.alg ?? "RS256", kid: input.kid ?? "key-1", typ: "JWT" })).toString("base64url");
  const seconds = Math.floor(baseNow / 1_000);
  const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, sub: subject, iat: seconds - 5, exp: seconds + 300, ...input.claims })).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`, "ascii"), input.key ?? first.privateKey).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

function response(keys: unknown[], cacheControl = "public, max-age=600"): Response {
  return new Response(JSON.stringify({ keys }), { status: 200, headers: { "content-type": "application/json", "cache-control": cacheControl } });
}

test("operator verifier authenticates, authorizes exact action, caches keys, and returns only pseudonymous identity", async () => {
  let fetches = 0;
  const verifier = createOperatorTokenVerifier(environment, { now: () => baseNow, fetch: async () => { fetches += 1; return response([jwk(first.publicKey, "key-1")]); } })!;
  const identity = await verifier.verifyAndAuthorize(token(), "privacy_requests:read");
  assert.deepEqual(Object.keys(identity).sort(), ["action", "actorPseudonym", "role"]);
  assert.equal(identity.role, "privacy_operator");
  assert.equal(identity.action, "privacy_requests:read");
  assert.equal(identity.actorPseudonym.includes(subject), false);
  await verifier.verifyAndAuthorize(token(), "privacy_requests:action");
  assert.equal(fetches, 1);
  await assert.rejects(verifier.verifyAndAuthorize(token(), "legal_requests:read"), { message: "operator_token_invalid" });
  assert.equal(fetches, 1);
});

test("operator verifier rejects malformed, mismatched, expired, future, and incorrectly signed tokens without leaking details", async () => {
  const verifier = createOperatorTokenVerifier(environment, { now: () => baseNow, fetch: async () => response([jwk(first.publicKey, "key-1")]) })!;
  const seconds = Math.floor(baseNow / 1_000);
  const invalid = [
    "not-a-jwt",
    token({ alg: "HS256" }),
    token({ claims: { iss: "https://other.example.test" } }),
    token({ claims: { aud: "other-audience" } }),
    token({ claims: { sub: "unlisted-subject" } }),
    token({ claims: { exp: seconds - 31 } }),
    token({ claims: { iat: seconds + 31 } }),
    token({ claims: { nbf: seconds + 31 } }),
    token({ key: second.privateKey }),
  ];
  for (const candidate of invalid) {
    await assert.rejects(verifier.verifyAndAuthorize(candidate, "privacy_requests:read"), (error: unknown) => {
      assert.equal(error instanceof Error ? error.message : "", "operator_token_invalid");
      assert.equal(String(error).includes(subject), false);
      assert.equal(String(error).includes(candidate), false);
      return true;
    });
  }
});

test("unknown kid performs one shared refresh and global cooldown blocks sequential or rotating misses", async () => {
  let fetches = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const verifier = createOperatorTokenVerifier(environment, {
    now: () => baseNow,
    fetch: async () => {
      fetches += 1;
      if (fetches === 2) await gate;
      return response([jwk(first.publicKey, "key-1")], "max-age=3600");
    },
  })!;
  await verifier.verifyAndAuthorize(token(), "privacy_requests:read");
  const unknown = token({ kid: "missing", key: second.privateKey });
  const left = verifier.verifyAndAuthorize(unknown, "privacy_requests:read");
  const right = verifier.verifyAndAuthorize(unknown, "privacy_requests:read");
  release!();
  await Promise.all([
    assert.rejects(left, { message: "operator_token_invalid" }),
    assert.rejects(right, { message: "operator_token_invalid" }),
  ]);
  assert.equal(fetches, 2);
  await assert.rejects(verifier.verifyAndAuthorize(unknown, "privacy_requests:read"), { message: "operator_token_invalid" });
  await assert.rejects(verifier.verifyAndAuthorize(token({ kid: "different-missing", key: second.privateKey }), "privacy_requests:read"), { message: "operator_token_invalid" });
  assert.equal(fetches, 2);
});

test("failed unknown-kid refresh also starts the global cooldown", async () => {
  let fetches = 0;
  const verifier = createOperatorTokenVerifier(environment, {
    now: () => baseNow,
    fetch: async () => {
      fetches += 1;
      if (fetches > 1) throw new Error("jwks unavailable");
      return response([jwk(first.publicKey, "key-1")]);
    },
  })!;
  await verifier.verifyAndAuthorize(token(), "privacy_requests:read");
  await assert.rejects(verifier.verifyAndAuthorize(token({ kid: "missing-a", key: second.privateKey }), "privacy_requests:read"), { message: "operator_token_invalid" });
  await assert.rejects(verifier.verifyAndAuthorize(token({ kid: "missing-b", key: second.privateKey }), "privacy_requests:read"), { message: "operator_token_invalid" });
  assert.equal(fetches, 2);
});

test("JWKS redirect, oversized body, duplicate kid, and network failure are rejected", async () => {
  const fetchers = [
    async () => new Response(null, { status: 302, headers: { location: "https://other.example.test/jwks" } }),
    async () => new Response(JSON.stringify({ keys: [] }), { status: 200, headers: { "content-length": String(300 * 1024) } }),
    async () => response([jwk(first.publicKey, "key-1"), jwk(second.publicKey, "key-1")]),
    async () => { throw new Error("sensitive network failure"); },
  ];
  for (const fetcher of fetchers) {
    const verifier = createOperatorTokenVerifier(environment, { now: () => baseNow, fetch: fetcher })!;
    await assert.rejects(verifier.verifyAndAuthorize(token(), "privacy_requests:read"), { message: "operator_token_invalid" });
  }
});

test("JWKS streaming limit rejects a chunked oversized body before consuming its tail", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(130 * 1024)); },
    cancel() { cancelled = true; },
  });
  const verifier = createOperatorTokenVerifier(environment, { now: () => baseNow, fetch: async () => new Response(body, { status: 200 }) })!;
  await assert.rejects(verifier.verifyAndAuthorize(token(), "privacy_requests:read"), { message: "operator_token_invalid" });
  assert.equal(cancelled, true);
});

test("JWKS fetch deadline aborts a stalled request", async () => {
  let aborted = false;
  const verifier = createOperatorTokenVerifier(environment, {
    now: () => baseNow,
    jwksTimeoutMs: 20,
    fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
    }),
  })!;
  await assert.rejects(verifier.verifyAndAuthorize(token(), "privacy_requests:read"), { message: "operator_token_invalid" });
  assert.equal(aborted, true);
});

test("production HTTPS lookup returns the Node all-address callback shape and rejects any non-public answer", async () => {
  const publicLookup = createPublicOnlyLookup((_hostname, _options, callback) => callback(null, [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]));
  const all = await new Promise<unknown>((resolve, reject) => publicLookup("keys.example.test", { all: true }, (error, address) => error ? reject(error) : resolve(address)));
  assert.deepEqual(all, [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]);
  const single = await new Promise<unknown>((resolve, reject) => publicLookup("keys.example.test", {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(single, { address: "8.8.8.8", family: 4 });
  const denied = createPublicOnlyLookup((_hostname, _options, callback) => callback(null, [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]));
  await assert.rejects(new Promise((resolve, reject) => denied("keys.example.test", { all: true }, (error, address) => error ? reject(error) : resolve(address))), { message: "operator_token_invalid" });
});

test("absent operator configuration produces no verifier", () => {
  const withoutOperator = loadEnvironment({
    NODE_ENV: "test",
    REPORT_RATE_LIMIT_HASH_SECRET: "test-only-report-rate-limit-secret-0123456789",
    DELETION_PSEUDONYM_KEYS_JSON: "[]",
    PRIVACY_RESPONSE_KEY_BASE64: "test-only-privacy-response-key",
    PRIVACY_AUDIT_HMAC_SECRET: "test-only-privacy-audit-secret-0123456789",
  });
  assert.equal(createOperatorTokenVerifier(withoutOperator), null);
});
