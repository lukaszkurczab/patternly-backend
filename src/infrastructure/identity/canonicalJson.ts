/**
 * The closed JSON profile used by the account synchronisation protocol.
 *
 * This is intentionally kept separate from the historical progress
 * fingerprint helper.  Existing records have already been fingerprinted and
 * must remain readable with their original identity; new request envelopes and
 * protocol-v3 digests use this profile.
 */
export const CANONICAL_JSON_VERSION = "canonical-json-v1" as const;

// Maximum canonical identity length for the legal recordId/trackId bounds.
// This is intentionally separate from record field limits: it only applies
// to conflict identifiers and other full-identity transport keys.
export const CANONICAL_RECORD_IDENTITY_MAX_LENGTH = 4096;

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("canonical_json_non_finite_number");
  // JSON.stringify is stable for finite ECMAScript numbers.  Normalising -0
  // avoids two encodings for the same JSON number.
  if (Object.is(value, -0)) return "0";
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("canonical_json_number_invalid");
  return serialized.replace(/e\+?(-?)0+(\d+)/u, "e$1$2");
}

function canonicalString(value: string): string {
  // JSON.stringify performs the required quote/backslash/control escaping;
  // NFC is applied before sorting keys and before writing values.
  return JSON.stringify(value.normalize("NFC"));
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return canonicalString(value);
    case "boolean": return value ? "true" : "false";
    case "number": return canonicalNumber(value);
    case "undefined":
    case "bigint":
    case "function":
    case "symbol":
      throw new TypeError("canonical_json_unsupported_value");
    default:
      break;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("canonical_json_unsupported_value");
  }
  const entries = Object.keys(value).map((key) => ({ key, normalized: key.normalize("NFC") }));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.normalized)) throw new TypeError("canonical_json_duplicate_key");
    seen.add(entry.normalized);
  }
  entries.sort((left, right) => left.normalized < right.normalized ? -1 : left.normalized > right.normalized ? 1 : 0);
  return `{${entries.map(({ key, normalized }) => `${canonicalString(normalized)}:${canonicalize((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function canonicalJsonBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}
