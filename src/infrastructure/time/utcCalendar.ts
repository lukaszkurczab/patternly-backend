function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function addUtcCalendarMonths(value: Date, months: number): Date {
  if (!Number.isInteger(months) || months < 0 || !Number.isFinite(value.getTime())) throw new Error("calendar_months_invalid");
  const targetMonthIndex = value.getUTCMonth() + months;
  const targetYear = value.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = targetMonthIndex % 12;
  const day = Math.min(value.getUTCDate(), daysInUtcMonth(targetYear, targetMonth));
  return new Date(Date.UTC(targetYear, targetMonth, day, value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(), value.getUTCMilliseconds()));
}

export function addUtcCalendarYears(value: Date, years: number): Date {
  if (!Number.isInteger(years) || years < 0 || !Number.isFinite(value.getTime())) throw new Error("calendar_years_invalid");
  const targetYear = value.getUTCFullYear() + years;
  const month = value.getUTCMonth();
  const day = Math.min(value.getUTCDate(), daysInUtcMonth(targetYear, month));
  return new Date(Date.UTC(targetYear, month, day, value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(), value.getUTCMilliseconds()));
}
