import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDescription, statementFingerprint } from "./statement.dedupe.js";

test("normalizeDescription removes banking noise and punctuation", () => {
  assert.equal(normalizeDescription("UPI/ SWIGGY  Ref 12345"), "swiggy 12345");
  assert.equal(normalizeDescription("NEFT TO Ravi"), "ravi");
});

test("statementFingerprint is stable for the same transaction", () => {
  const input = {
    userId: "user_1",
    date: "2026-11-01",
    amount: 450,
    type: "EXPENSE",
    description: "UPI/SWIGGY",
  };
  assert.equal(statementFingerprint(input), statementFingerprint(input));
});

test("statementFingerprint changes when the amount or date changes", () => {
  const base = {
    userId: "user_1",
    date: "2026-11-01",
    amount: 450,
    type: "EXPENSE",
    description: "UPI/SWIGGY",
  };

  assert.notEqual(
    statementFingerprint(base),
    statementFingerprint({ ...base, amount: 451 }),
  );
  assert.notEqual(
    statementFingerprint(base),
    statementFingerprint({ ...base, date: "2026-11-02" }),
  );
});
