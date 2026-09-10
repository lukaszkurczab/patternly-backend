/**
 * Historical per-record guard. It remains in place so an individual record
 * cannot monopolise a sync batch and so old clients keep their behaviour.
 */
export const MAX_SERIALIZED_JSON_UTF16_CODE_UNITS = 128 * 1024;

/** Maximum UTF-8 size of a complete canonical-json-v1 sync envelope. */
export const MAX_SYNC_ENVELOPE_UTF8_BYTES = 512 * 1024;
