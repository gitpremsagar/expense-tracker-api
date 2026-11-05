const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );

  const hour = Number(parts["hour"]) % 24;
  const asUtc = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    hour,
    Number(parts["minute"]),
    Number(parts["second"]),
  );

  return asUtc - date.getTime();
}

/** Converts a wall-clock time in the given IANA timezone to a UTC instant. */
export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffset = timeZoneOffsetMs(new Date(guess), timeZone);
  const first = guess - firstOffset;
  const secondOffset = timeZoneOffsetMs(new Date(first), timeZone);

  return new Date(secondOffset === firstOffset ? first : guess - secondOffset);
}

/**
 * Parses the date strings the model may return:
 * - full ISO 8601 with offset/Z
 * - date only (treated as noon in the user's timezone)
 * - local datetime without offset (treated as the user's timezone)
 */
export function parseModelDate(
  value: string | null | undefined,
  timeZone: string,
): Date | null {
  if (!value) return null;

  const trimmed = value.trim();

  if (DATE_ONLY.test(trimmed)) {
    const [year, month, day] = trimmed.split("-").map(Number);
    return zonedWallTimeToUtc(year!, month!, day!, 12, 0, 0, timeZone);
  }

  const local = LOCAL_DATETIME.exec(trimmed);
  if (local) {
    return zonedWallTimeToUtc(
      Number(local[1]),
      Number(local[2]),
      Number(local[3]),
      Number(local[4]),
      Number(local[5]),
      Number(local[6] ?? 0),
      timeZone,
    );
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Guards against model output with wildly out-of-range dates. */
export function isSaneTransactionDate(date: Date, now: Date): boolean {
  const min = Date.UTC(2000, 0, 1);
  const max = now.getTime() + 24 * 60 * 60 * 1000;
  return date.getTime() >= min && date.getTime() <= max;
}

export function formatNowInTimeZone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

export function formatIsoDateInTimeZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
