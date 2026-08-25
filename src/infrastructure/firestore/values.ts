import { Timestamp } from "firebase-admin/firestore";

export function now(): Timestamp {
  return Timestamp.now();
}

export function asTimestamp(value: unknown, field: string): Timestamp {
  if (value instanceof Timestamp) return value;
  if (value instanceof Date) return Timestamp.fromDate(value);
  throw new Error(`firestore_${field}_timestamp_missing`);
}

export function asIsoString(value: unknown, field: string): string {
  return asTimestamp(value, field).toDate().toISOString();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`firestore_${field}_record_missing`);
  return value;
}
