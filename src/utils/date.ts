/**
 * All reporting and calendar grouping is done in one timezone so that a
 * transaction never lands on a different day (or month) depending on where the
 * API process happens to be running. The product is INR/India focused, so the
 * default is Asia/Kolkata and can be overridden with APP_TIMEZONE.
 *
 * This module deliberately does not import the full env schema so it can be
 * unit-tested without database/JWT secrets.
 */
export const APP_TIMEZONE = process.env.APP_TIMEZONE?.trim() || "Asia/Kolkata";

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  formatterCache.set(timeZone, formatter);
  return formatter;
}

export type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsOf(date: Date, timeZone: string): DateTimeParts {
  const parts = getFormatter(timeZone).formatToParts(date);
  const values: Record<string, number> = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }

  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

/** Offset of the timezone at that instant: local - UTC in milliseconds. */
function offsetMs(date: Date, timeZone: string): number {
  const parts = partsOf(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - date.getTime();
}

/** Convert wall-clock time in `timeZone` to the corresponding UTC instant. */
export function zonedTimeToUtc(
  input: {
    year: number;
    month: number;
    day: number;
    hour?: number;
    minute?: number;
    second?: number;
  },
  timeZone: string = APP_TIMEZONE,
): Date {
  const guess = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour ?? 0,
    input.minute ?? 0,
    input.second ?? 0,
  );

  // Two passes handle zones with daylight-saving transitions.
  let result = guess - offsetMs(new Date(guess), timeZone);
  result = guess - offsetMs(new Date(result), timeZone);
  return new Date(result);
}

export function dateKey(date: Date, timeZone: string = APP_TIMEZONE): string {
  const parts = partsOf(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function monthKey(date: Date, timeZone: string = APP_TIMEZONE): string {
  const parts = partsOf(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
}

export function parseMonthKey(month: string): { year: number; month: number } {
  const [year, mon] = month.split("-").map((part) => parseInt(part, 10));
  return { year: year ?? 1970, month: mon ?? 1 };
}

export function getMonthRange(month: string): { start: Date; end: Date } {
  const { year, month: mon } = parseMonthKey(month);
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMonth = mon === 12 ? 1 : mon + 1;

  return {
    start: zonedTimeToUtc({ year, month: mon, day: 1 }),
    end: zonedTimeToUtc({ year: nextYear, month: nextMonth, day: 1 }),
  };
}

export function getYearRange(year: number): { start: Date; end: Date } {
  return {
    start: zonedTimeToUtc({ year, month: 1, day: 1 }),
    end: zonedTimeToUtc({ year: year + 1, month: 1, day: 1 }),
  };
}

export function currentMonthKey(timeZone: string = APP_TIMEZONE): string {
  return monthKey(new Date(), timeZone);
}

export function currentYear(timeZone: string = APP_TIMEZONE): number {
  return partsOf(new Date(), timeZone).year;
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
