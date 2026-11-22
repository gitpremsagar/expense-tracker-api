import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dateOnlyToUtc,
  isDateInRange,
  normalizeDateValue,
  resolveTimezone,
} from "./assistant.time.js";
import { APP_TIMEZONE, dateKey } from "../../utils/date.js";

test("resolveTimezone keeps valid zones and falls back for invalid ones", () => {
  assert.equal(resolveTimezone("Asia/Kolkata"), "Asia/Kolkata");
  assert.equal(resolveTimezone("America/New_York"), "America/New_York");
  assert.equal(resolveTimezone("Not/AZone"), APP_TIMEZONE);
  assert.equal(resolveTimezone(undefined), APP_TIMEZONE);
});

test("dateOnlyToUtc keeps the calendar day at local noon", () => {
  const date = dateOnlyToUtc("2026-11-21", "Asia/Kolkata");
  assert.ok(date);
  assert.equal(dateKey(date, "Asia/Kolkata"), "2026-11-21");
});

test("dateOnlyToUtc rejects impossible dates", () => {
  assert.equal(dateOnlyToUtc("2026-02-31", "Asia/Kolkata"), null);
  assert.equal(dateOnlyToUtc("not-a-date", "Asia/Kolkata"), null);
});

test("normalizeDateValue accepts ISO timestamps", () => {
  const date = normalizeDateValue("2026-11-21T10:30:00+05:30", "Asia/Kolkata");
  assert.ok(date instanceof Date);
  assert.equal(dateKey(date, "Asia/Kolkata"), "2026-11-21");
});

test("isDateInRange bounds old and future dates", () => {
  const now = new Date("2026-11-22T12:00:00.000Z");
  assert.equal(isDateInRange(new Date("2026-11-21T12:00:00.000Z"), now), true);
  assert.equal(isDateInRange(new Date("2020-01-01T12:00:00.000Z"), now), false);
  assert.equal(isDateInRange(new Date("2028-01-01T12:00:00.000Z"), now), false);
});
