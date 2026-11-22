import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTableRows } from "./statement.normalize.js";

const categories = [
  { id: "cat_food", name: "Food & Dining", type: "EXPENSE" as const },
  { id: "cat_grocery", name: "Groceries", type: "EXPENSE" as const },
  { id: "cat_transport", name: "Transport", type: "EXPENSE" as const },
  { id: "cat_salary", name: "Salary", type: "INCOME" as const },
  { id: "cat_other", name: "Other", type: "EXPENSE" as const },
];

test("normalizeTableRows suggests categories from narration keywords", () => {
  const rows = normalizeTableRows(
    [
      {
        date: "2026-11-01",
        amount: 450,
        type: "EXPENSE",
        description: "UPI/SWIGGY ORDER",
        confidence: 0.95,
      },
      {
        date: "2026-11-02",
        amount: 85000,
        type: "INCOME",
        description: "SALARY CREDIT",
        confidence: 0.95,
      },
      {
        date: "2026-11-03",
        amount: 120,
        type: "EXPENSE",
        description: "SOMETHING UNKNOWN",
        confidence: 0.8,
      },
    ],
    categories,
  );

  assert.equal(rows[0]?.categoryId, "cat_food");
  assert.equal(rows[1]?.categoryId, "cat_salary");
  assert.equal(rows[2]?.categoryId, "cat_other");
});

test("normalizeTableRows drops invalid dates and amounts", () => {
  const rows = normalizeTableRows(
    [
      {
        date: "not-a-date",
        amount: 100,
        type: "EXPENSE",
        description: "X",
        confidence: 0.5,
      },
      {
        date: "2026-11-01",
        amount: 0,
        type: "EXPENSE",
        description: "Y",
        confidence: 0.5,
      },
    ],
    categories,
  );

  assert.equal(rows.length, 0);
});
