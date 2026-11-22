import assert from "node:assert/strict";
import test from "node:test";
import {
  dateKey,
  getMonthRange,
  getYearRange,
  monthKey,
  roundMoney,
} from "./date.js";

test("dateKey uses the app calendar day, not the UTC day", () => {
  // 00:30 on 1 Nov in IST is still 31 Oct in UTC.
  assert.equal(dateKey(new Date("2026-10-31T19:00:00.000Z")), "2026-11-01");
  assert.equal(monthKey(new Date("2026-10-31T19:00:00.000Z")), "2026-11");
});

test("month range is midnight-to-midnight in IST", () => {
  const { start, end } = getMonthRange("2026-11");
  assert.equal(start.toISOString(), "2026-10-31T18:30:00.000Z");
  assert.equal(end.toISOString(), "2026-11-30T18:30:00.000Z");
});

test("year range covers the local calendar year", () => {
  const { start, end } = getYearRange(2026);
  assert.equal(start.toISOString(), "2025-12-31T18:30:00.000Z");
  assert.equal(end.toISOString(), "2026-12-31T18:30:00.000Z");
});

test("roundMoney avoids floating point drift", () => {
  assert.equal(roundMoney(0.1 + 0.2), 0.3);
  assert.equal(roundMoney(1234.567), 1234.57);
});
