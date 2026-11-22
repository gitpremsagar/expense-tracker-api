import { APP_TIMEZONE, dateKey, zonedTimeToUtc } from "../../utils/date.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Validate an IANA timezone supplied by a client; fall back to the app timezone. */
export function resolveTimezone(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return APP_TIMEZONE;
  const candidate = value.trim();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return APP_TIMEZONE;
  }
}

export function todayInTimezone(timeZone: string): string {
  return dateKey(new Date(), timeZone);
}

export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value);
}

/**
 * Convert a date-only value to a UTC instant at local noon. Noon keeps the
 * calendar day stable for every timezone in the app's range while still being a
 * normal DateTime for Prisma/reporting.
 */
export function dateOnlyToUtc(value: string, timeZone: string): Date | null {
  if (!isDateOnly(value)) return null;
  const [year, month, day] = value.split("-").map((part) => Number(part));
  if (!year || !month || !day) return null;

  const date = zonedTimeToUtc({ year, month, day, hour: 12 }, timeZone);
  // Reject impossible dates such as 2026-02-31 (JS rolls them over).
  if (dateKey(date, timeZone) !== value) return null;
  return date;
}

/** Accept a date-only string or a full ISO timestamp and return a sane Date. */
export function normalizeDateValue(value: unknown, timeZone: string): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const trimmed = value.trim();

  if (isDateOnly(trimmed)) return dateOnlyToUtc(trimmed, timeZone);

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export function isDateInRange(date: Date, now = new Date()): boolean {
  const min = new Date(now);
  min.setFullYear(min.getFullYear() - 2);
  const max = new Date(now);
  max.setDate(max.getDate() + 1);
  return date >= min && date <= max;
}

export function usageDay(): string {
  return dateKey(new Date(), APP_TIMEZONE);
}
