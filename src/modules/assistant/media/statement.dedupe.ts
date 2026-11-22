import { createHash } from "node:crypto";
import { prisma } from "../../../lib/prisma.js";
import { APP_TIMEZONE, dateKey, roundMoney } from "../../../utils/date.js";
import type { NormalizedStatementRow } from "./statement.normalize.js";

export type DedupedRow = NormalizedStatementRow & {
  dedupeKey: string;
  status: "PENDING" | "DUPLICATE";
  duplicateReason: "FILE" | "EXACT" | "FUZZY" | null;
};

export function normalizeDescription(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(upi|neft|imps|rtgs|txn|transaction|ref|reference|payment|paid|to|from|the|a|and)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function statementFingerprint(input: {
  userId: string;
  date: string;
  amount: number;
  type: string;
  description: string;
}): string {
  const value = [
    input.userId,
    input.date,
    roundMoney(input.amount).toFixed(2),
    input.type,
    normalizeDescription(input.description),
  ].join("|");
  return createHash("sha256").update(value).digest("hex");
}

function fuzzyTokens(value: string): Set<string> {
  return new Set(
    normalizeDescription(value)
      .split(" ")
      .filter((token) => token.length > 2 && !/^\d+$/.test(token)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export async function markDuplicates(
  userId: string,
  rows: NormalizedStatementRow[],
): Promise<DedupedRow[]> {
  if (rows.length === 0) return [];

  const dates = rows.map((row) => new Date(`${row.date}T12:00:00.000Z`).getTime());
  const min = new Date(Math.min(...dates) - 3 * 86_400_000);
  const max = new Date(Math.max(...dates) + 3 * 86_400_000);

  const existing = await prisma.transaction.findMany({
    where: { userId, date: { gte: min, lte: max } },
    select: { amount: true, type: true, date: true, note: true, dedupeKey: true },
    take: 5_000,
  });

  const existingKeys = new Set<string>();
  const existingFuzzy = existing.map((transaction) => {
    const computedKey = statementFingerprint({
      userId,
      date: dateKey(transaction.date, APP_TIMEZONE),
      amount: transaction.amount,
      type: transaction.type,
      description: transaction.note ?? "",
    });

    if (transaction.dedupeKey) existingKeys.add(transaction.dedupeKey);
    existingKeys.add(computedKey);

    return {
      amount: roundMoney(transaction.amount),
      type: transaction.type,
      day: new Date(transaction.date).getTime(),
      tokens: fuzzyTokens(transaction.note ?? ""),
      key: computedKey,
    };
  });

  const seen = new Set<string>();
  const result: DedupedRow[] = [];

  for (const row of rows) {
    const dedupeKey = statementFingerprint({
      userId,
      date: row.date,
      amount: row.amount,
      type: row.type,
      description: row.description,
    });

    let status: "PENDING" | "DUPLICATE" = "PENDING";
    let duplicateReason: DedupedRow["duplicateReason"] = null;

    if (seen.has(dedupeKey)) {
      status = "DUPLICATE";
      duplicateReason = "FILE";
    } else if (existingKeys.has(dedupeKey)) {
      status = "DUPLICATE";
      duplicateReason = "EXACT";
    } else {
      const rowDay = new Date(`${row.date}T12:00:00.000Z`).getTime();
      const tokens = fuzzyTokens(row.description);

      const fuzzy = existingFuzzy.some((transaction) => {
        if (transaction.amount !== roundMoney(row.amount)) return false;
        if (transaction.type !== row.type) return false;
        if (Math.abs(transaction.day - rowDay) > 2 * 86_400_000) return false;
        return jaccard(transaction.tokens, tokens) >= 0.8;
      });

      if (fuzzy) {
        status = "DUPLICATE";
        duplicateReason = "FUZZY";
      }
    }

    seen.add(dedupeKey);

    result.push({
      ...row,
      dedupeKey,
      status,
      duplicateReason,
    });
  }

  return result;
}

export function transactionDedupeKey(transaction: {
  userId: string;
  amount: number;
  type: string;
  date: Date;
  note: string | null;
}): string {
  return statementFingerprint({
    userId: transaction.userId,
    date: dateKey(transaction.date, APP_TIMEZONE),
    amount: transaction.amount,
    type: transaction.type,
    description: transaction.note ?? "",
  });
}
