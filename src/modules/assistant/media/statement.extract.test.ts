import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chunkPages,
  parseStatementAmount,
  parseStatementDate,
  parseTableRows,
} from "./statement.extract.js";

test("parseStatementDate handles Indian and ISO formats", () => {
  assert.equal(parseStatementDate("01/11/2026"), "2026-11-01");
  assert.equal(parseStatementDate("1-11-26"), "2026-11-01");
  assert.equal(parseStatementDate("2026-11-01"), "2026-11-01");
  assert.equal(parseStatementDate("1-Nov-26"), "2026-11-01");
  assert.equal(parseStatementDate("Nov 1, 2026"), "2026-11-01");
  assert.equal(parseStatementDate("31/02/2026"), null);
  assert.equal(parseStatementDate("hello"), null);
});

test("parseStatementAmount handles commas, Dr/Cr and parentheses", () => {
  assert.deepEqual(parseStatementAmount("1,234.50"), { amount: 1234.5, direction: null });
  assert.deepEqual(parseStatementAmount("450.00 Dr"), { amount: 450, direction: "DEBIT" });
  assert.deepEqual(parseStatementAmount("85,000.00 Cr"), { amount: 85000, direction: "CREDIT" });
  assert.deepEqual(parseStatementAmount("(1,200.00)"), { amount: 1200, direction: "DEBIT" });
  assert.equal(parseStatementAmount(""), null);
});

test("parseTableRows detects debit/credit columns", () => {
  const rows = parseTableRows([
    ["Date", "Narration", "Debit", "Credit", "Balance"],
    ["01/11/2026", "UPI/SWIGGY", "450.00", "", "12,450.00"],
    ["02/11/2026", "SALARY CREDIT", "", "85,000.00", "97,450.00"],
    ["", "", "", "", ""],
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.type, "EXPENSE");
  assert.equal(rows[0]?.amount, 450);
  assert.equal(rows[1]?.type, "INCOME");
  assert.equal(rows[1]?.amount, 85000);
});

test("parseTableRows ignores rows without a date or amount", () => {
  const rows = parseTableRows([
    ["Date", "Description", "Amount", "Balance"],
    ["", "Opening balance", "", "1000"],
    ["01/11/2026", "Coffee", "120.00", "880"],
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.type, "EXPENSE");
});

test("chunkPages keeps chunks under the limit", () => {
  const chunks = chunkPages(["line one\nline two\nline three"], 12);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 12));
});
