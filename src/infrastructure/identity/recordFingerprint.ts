/** Static byte profile; deliberately absent from the preimage to retain existing APP identities. */
export const RECORD_FINGERPRINT_PROFILE = "record-fingerprint-json-utf8-v1" as const;

export type RecordFingerprintInput = Readonly<{
  recordId: string;
  recordType: string;
  state: Readonly<Record<string, unknown>>;
  trackId: string;
}>;

/** Exact strings, raw UTF-16 key ordering, finite ECMAScript JSON numbers, ordered dense arrays.
 * NFC is used only to detect ambiguous keys, never to rewrite payload bytes.
 * Other protocol digests have their own serializers.
 */
export function recordFingerprintPayload(record: RecordFingerprintInput): string {
  const ancestors = new Set<object>();
  const serialize = (value: unknown): string => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (typeof value !== "object" || value === null || ancestors.has(value)) throw new TypeError("record_fingerprint_unsupported_value");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("record_fingerprint_unsupported_value");
        for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) throw new TypeError("record_fingerprint_unsupported_value");
        return `[${value.map(serialize).join(",")}]`;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("record_fingerprint_unsupported_value");
      const keys = Object.keys(value).sort();
      if (new Set(keys.map((key) => key.normalize("NFC"))).size !== keys.length) throw new TypeError("record_fingerprint_duplicate_key");
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize((value as Record<string, unknown>)[key])}`).join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  };
  return serialize({ recordId: record.recordId, recordType: record.recordType, state: record.state, trackId: record.trackId });
}
