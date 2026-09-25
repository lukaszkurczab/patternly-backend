import { createHmac, createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";
import { lookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { z } from "zod";
import type { Environment } from "../../config/environment.js";
import type { OperatorAction } from "../../modules/operator-access/contracts.js";

const headerSchema = z.object({ alg: z.literal("RS256"), kid: z.string().min(1).max(256), typ: z.string().optional() }).passthrough();
const claimsSchema = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string().min(1).max(512),
  exp: z.number().int(),
  iat: z.number().int(),
  nbf: z.number().int().optional(),
}).passthrough();
const jwksSchema = z.object({ keys: z.array(z.object({ kty: z.literal("RSA"), kid: z.string().min(1).max(256), use: z.literal("sig").optional(), alg: z.literal("RS256").optional(), n: z.string().min(1), e: z.string().min(1) }).passthrough()).max(100) }).strict();

const MAX_JWKS_BYTES = 256 * 1024;
const DEFAULT_CACHE_SECONDS = 300;
const MAX_CACHE_SECONDS = 3_600;
const CLOCK_TOLERANCE_SECONDS = 30;
const JWKS_TIMEOUT_MS = 5_000;
const UNKNOWN_KID_COOLDOWN_MS = 60_000;

export type VerifiedOperatorIdentity = Readonly<{
  actorPseudonym: string;
  role: string;
  action: OperatorAction;
}>;

export interface OperatorTokenVerifier {
  verifyAndAuthorize(idToken: string, action: OperatorAction): Promise<VerifiedOperatorIdentity>;
}

type FetchLike = typeof fetch;
type Clock = () => number;

export function createOperatorTokenVerifier(
  environment: Environment,
  options: Readonly<{ fetch?: FetchLike; now?: Clock; jwksTimeoutMs?: number }> = {},
): OperatorTokenVerifier | null {
  const configuration = environment.operatorAccess;
  if (!configuration) return null;
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const jwksTimeoutMs = options.jwksTimeoutMs ?? JWKS_TIMEOUT_MS;
  const operators = new Map(configuration.operators.map((entry) => [entry.subject, entry] as const));
  let cache: Readonly<{ expiresAt: number; keys: ReadonlyMap<string, JsonWebKey> }> | null = null;
  let refresh: Promise<ReadonlyMap<string, JsonWebKey>> | null = null;
  let refreshGeneration = 0;
  let nextUnknownKidRefreshAt = 0;
  const unknownKids = new Map<string, number>();

  const loadKeys = async (force: boolean): Promise<ReadonlyMap<string, JsonWebKey>> => {
    if (!force && cache && cache.expiresAt > now()) return cache.keys;
    if (refresh) return refresh;
    refresh = (async () => {
      const loaded = options.fetch
        ? await fetchInjectedJwks(fetcher, configuration.jwksUrl, jwksTimeoutMs)
        : await fetchPinnedJwks(configuration.jwksUrl, jwksTimeoutMs);
      let json: unknown;
      try { json = JSON.parse(loaded.text); } catch { throw new Error("operator_token_invalid"); }
      const parsed = jwksSchema.safeParse(json);
      if (!parsed.success) throw new Error("operator_token_invalid");
      const keys = new Map<string, JsonWebKey>();
      for (const key of parsed.data.keys) {
        if (keys.has(key.kid)) throw new Error("operator_token_invalid");
        keys.set(key.kid, key);
      }
      const maxAge = parseMaxAge(loaded.cacheControl);
      cache = Object.freeze({ expiresAt: now() + maxAge * 1_000, keys });
      refreshGeneration += 1;
      return keys;
    })().finally(() => { refresh = null; });
    return refresh;
  };

  return Object.freeze({
    async verifyAndAuthorize(idToken: string, action: OperatorAction): Promise<VerifiedOperatorIdentity> {
      try {
        const [encodedHeader, encodedClaims, encodedSignature, extra] = idToken.split(".");
        if (!encodedHeader || !encodedClaims || !encodedSignature || extra !== undefined) throw new Error("invalid");
        const header = headerSchema.parse(parseSegment(encodedHeader));
        const claims = claimsSchema.parse(parseSegment(encodedClaims));
        if (claims.iss !== configuration.issuer || claims.aud !== configuration.audience) throw new Error("invalid");
        const currentSeconds = Math.floor(now() / 1_000);
        if (claims.exp <= currentSeconds - CLOCK_TOLERANCE_SECONDS || claims.iat > currentSeconds + CLOCK_TOLERANCE_SECONDS || (claims.nbf !== undefined && claims.nbf > currentSeconds + CLOCK_TOLERANCE_SECONDS)) throw new Error("invalid");
        const operator = operators.get(claims.sub);
        if (!operator || !operator.actions.includes(action)) throw new Error("invalid");
        const generationBeforeLookup = refreshGeneration;
        let keys = await loadKeys(false);
        let jwk = keys.get(header.kid);
        if (!jwk && refreshGeneration === generationBeforeLookup) {
          const retryAfter = unknownKids.get(header.kid) ?? 0;
          if (retryAfter > now() || nextUnknownKidRefreshAt > now()) throw new Error("invalid");
          nextUnknownKidRefreshAt = now() + UNKNOWN_KID_COOLDOWN_MS;
          keys = await loadKeys(true);
          jwk = keys.get(header.kid);
        }
        if (!jwk) {
          if (unknownKids.size >= 1_000) unknownKids.clear();
          unknownKids.set(header.kid, now() + UNKNOWN_KID_COOLDOWN_MS);
          throw new Error("invalid");
        }
        unknownKids.delete(header.kid);
        const publicKey = createPublicKey({ key: jwk, format: "jwk" });
        const signature = decodeSegment(encodedSignature);
        const valid = verifySignature("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii"), publicKey, signature);
        if (!valid) throw new Error("invalid");
        const actorPseudonym = createHmac("sha256", environment.privacyAuditHmacSecret)
          .update(`operator:${configuration.issuer}\0${claims.sub}`, "utf8")
          .digest("base64url");
        return Object.freeze({ actorPseudonym, role: operator.role, action });
      } catch {
        throw new Error("operator_token_invalid");
      }
    },
  });
}

async function fetchInjectedJwks(fetcher: FetchLike, url: string, timeoutMs: number): Promise<Readonly<{ text: string; cacheControl: string | null }>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try { response = await fetcher(url, { headers: { accept: "application/json" }, redirect: "manual", signal: controller.signal }); }
  catch { clearTimeout(timeout); throw new Error("operator_token_invalid"); }
  try {
    if (!response.ok || response.status < 200 || response.status >= 300) throw new Error("operator_token_invalid");
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_JWKS_BYTES) throw new Error("operator_token_invalid");
    return Object.freeze({ text: await readBoundedResponse(response, MAX_JWKS_BYTES), cacheControl: response.headers.get("cache-control") });
  } finally { clearTimeout(timeout); }
}

function fetchPinnedJwks(url: string, timeoutMs: number): Promise<Readonly<{ text: string; cacheControl: string | null }>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishError = () => { if (!settled) { settled = true; reject(new Error("operator_token_invalid")); } };
    const requestHandle = request(url, {
      method: "GET",
      headers: { accept: "application/json" },
      lookup: createPublicOnlyLookup(),
    }, (response) => {
      const status = response.statusCode ?? 0;
      const lengthHeader = response.headers["content-length"];
      const contentLength = typeof lengthHeader === "string" ? Number(lengthHeader) : Number.NaN;
      if (status < 200 || status >= 300 || (Number.isFinite(contentLength) && contentLength > MAX_JWKS_BYTES)) {
        response.destroy();
        finishError();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_JWKS_BYTES) { response.destroy(); finishError(); return; }
        chunks.push(chunk);
      });
      response.once("end", () => {
        if (settled) return;
        settled = true;
        const cacheHeader = response.headers["cache-control"];
        resolve(Object.freeze({ text: Buffer.concat(chunks, bytes).toString("utf8"), cacheControl: typeof cacheHeader === "string" ? cacheHeader : null }));
      });
      response.once("error", finishError);
    });
    const timeout = setTimeout(() => { requestHandle.destroy(); finishError(); }, timeoutMs);
    requestHandle.once("close", () => clearTimeout(timeout));
    requestHandle.once("error", finishError);
    requestHandle.end();
  });
}

type LookupAll = (hostname: string, options: Readonly<{ all: true; verbatim: true }>, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

export function createPublicOnlyLookup(resolver: LookupAll = lookup as unknown as LookupAll): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error || addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
        callback(new Error("operator_token_invalid"), "");
        return;
      }
      if (options.all === true) callback(null, addresses);
      else {
        const selected = addresses[0]!;
        callback(null, selected.address, selected.family);
      }
    });
  };
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) throw new Error("operator_token_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) throw new Error("operator_token_invalid");
      chunks.push(result.value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("operator_token_invalid");
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function isPublicAddress(value: string): boolean {
  const family = isIP(value);
  if (family === 4) return !NON_PUBLIC_ADDRESSES.check(value, "ipv4");
  if (family === 6) return !NON_PUBLIC_ADDRESSES.check(value, "ipv6");
  return false;
}

const NON_PUBLIC_ADDRESSES = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv6");

function parseSegment(value: string): unknown {
  const decoded = decodeSegment(value);
  if (decoded.toString("base64url") !== value) throw new Error("invalid");
  return JSON.parse(decoded.toString("utf8"));
}

function decodeSegment(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid");
  return Buffer.from(value, "base64url");
}

function parseMaxAge(value: string | null): number {
  const match = value?.match(/(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/iu);
  if (!match) return DEFAULT_CACHE_SECONDS;
  return Math.min(Number(match[1]), MAX_CACHE_SECONDS);
}
