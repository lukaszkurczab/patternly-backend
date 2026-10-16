import { Timestamp } from "firebase-admin/firestore";
import { addUtcCalendarMonths } from "../../infrastructure/time/utcCalendar.js";

export function nextWorkingReviewAt(at: Date): Date {
  const next = new Date(at);
  do { next.setUTCDate(next.getUTCDate() + 1); } while (next.getUTCDay() === 0 || next.getUTCDay() === 6);
  next.setUTCHours(0, 0, 0, 0);
  return next;
}

export function validateReviewDate(value: string, now: Date, months: number): Timestamp {
  const next = new Date(value);
  if (!Number.isFinite(next.getTime()) || next <= now || next > addUtcCalendarMonths(now, months)) throw new Error("retention_review_date_invalid");
  return Timestamp.fromDate(next);
}

/** Closed records must have a valid deadline; active cases are never silently expired. */
export function archiveIsLive(data: Record<string, unknown>, months: number, now = Date.now()): boolean {
  if (data.legalHold === true) return true;
  if (!data.closedAt) return data.expiresAt == null || data.expiresAt instanceof Timestamp && data.expiresAt.toMillis() > now;
  if (!(data.closedAt instanceof Timestamp) || !(data.expiresAt instanceof Timestamp)) return false;
  return Math.min(data.expiresAt.toMillis(), addUtcCalendarMonths(data.closedAt.toDate(), months).getTime()) > now;
}
