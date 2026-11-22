import { prisma } from "../../lib/prisma.js";
import { dateKey, roundMoney, zonedTimeToUtc } from "../../utils/date.js";
import type { QuerySpec } from "./assistant.schema.js";

export type QueryResult = {
  total: number;
  count: number;
  average: number;
  transactions: Array<{
    id: string;
    date: string;
    amount: number;
    type: string;
    categoryName: string;
    note: string | null;
  }>;
  groups: Array<{ key: string; total: number; count: number }>;
};

function startOfLocalDay(value: string, timeZone: string): Date | null {
  const [year, month, day] = value.split("-").map((part) => Number(part));
  if (!year || !month || !day) return null;
  const date = zonedTimeToUtc({ year, month, day, hour: 0 }, timeZone);
  if (dateKey(date, timeZone) !== value) return null;
  return date;
}

function endOfLocalDay(value: string, timeZone: string): Date | null {
  const start = startOfLocalDay(value, timeZone);
  if (!start) return null;
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  return next;
}

export async function runQuery(
  userId: string,
  spec: QuerySpec,
  timeZone: string,
): Promise<QueryResult> {
  const filters = spec.filters ?? {};
  const where: Record<string, unknown> = { userId };

  const from = filters.from ? startOfLocalDay(filters.from, timeZone) : null;
  const to = filters.to ? endOfLocalDay(filters.to, timeZone) : null;

  if (from || to) {
    where.date = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lt: to } : {}),
    };
  }

  if (filters.types && filters.types.length > 0) {
    where.type = { in: filters.types };
  }

  if (filters.categoryIds && filters.categoryIds.length > 0) {
    const owned = await prisma.category.findMany({
      where: { userId, id: { in: filters.categoryIds } },
      select: { id: true },
    });
    if (owned.length > 0) {
      where.categoryId = { in: owned.map((category) => category.id) };
    }
  }

  if (filters.minAmount !== undefined || filters.maxAmount !== undefined) {
    where.amount = {
      ...(filters.minAmount !== undefined ? { gte: filters.minAmount } : {}),
      ...(filters.maxAmount !== undefined ? { lte: filters.maxAmount } : {}),
    };
  }

  const rows = (
    await prisma.transaction.findMany({
      where,
      orderBy: { date: "desc" },
      take: 2_000,
      include: { category: { select: { name: true } } },
    })
  ).filter((row) => {
    const term = filters.text?.trim().toLowerCase();
    if (!term) return true;
    return (
      row.note?.toLowerCase().includes(term) ||
      row.category.name.toLowerCase().includes(term)
    );
  });

  const total = roundMoney(rows.reduce((sum, row) => sum + row.amount, 0));
  const count = rows.length;
  const average = count === 0 ? 0 : roundMoney(total / count);

  const groups = spec.groupBy ? groupRows(rows, spec.groupBy, timeZone) : [];

  return {
    total,
    count,
    average,
    transactions: rows.slice(0, 50).map((row) => ({
      id: row.id,
      date: row.date.toISOString(),
      amount: row.amount,
      type: row.type,
      categoryName: row.category.name,
      note: row.note,
    })),
    groups,
  };
}

function groupRows(
  rows: Array<{
    amount: number;
    date: Date;
    categoryId: string;
    category: { name: string };
  }>,
  groupBy: "day" | "week" | "month" | "category",
  timeZone: string,
) {
  const map = new Map<string, { total: number; count: number }>();

  for (const row of rows) {
    let key: string;

    if (groupBy === "category") {
      key = row.category.name;
    } else if (groupBy === "month") {
      key = dateKey(row.date, timeZone).slice(0, 7);
    } else if (groupBy === "week") {
      const date = new Date(row.date);
      const day = date.getUTCDay();
      const diff = (day + 6) % 7;
      date.setUTCDate(date.getUTCDate() - diff);
      key = `week of ${dateKey(date, timeZone)}`;
    } else {
      key = dateKey(row.date, timeZone);
    }

    const current = map.get(key) ?? { total: 0, count: 0 };
    current.total = roundMoney(current.total + row.amount);
    current.count += 1;
    map.set(key, current);
  }

  return [...map.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);
}

export function composeQueryReply(result: QueryResult, spec: QuerySpec, timeZone: string): string {
  if (result.count === 0) {
    return "I could not find any transactions matching that.";
  }

  const amount = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(result.total);

  const types = spec.filters.types ?? [];
  const verb =
    types.length === 1
      ? types[0] === "INCOME"
        ? "received"
        : types[0] === "SAVING"
          ? "saved"
          : types[0] === "INVESTMENT"
            ? "invested"
            : "spent"
      : "moved";

  if (spec.aggregate === "LIST") {
    return `Here are ${result.count} transactions totalling ${amount}.`;
  }

  if (spec.aggregate === "COUNT") {
    return `That is ${result.count} transaction${result.count === 1 ? "" : "s"}.`;
  }

  if (spec.aggregate === "AVG") {
    const average = new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 0,
    }).format(result.average);
    return `The average is ${average} across ${result.count} transactions.`;
  }

  if (spec.groupBy && result.groups.length > 1) {
    const top = result.groups
      .slice(0, 3)
      .map((group) => `${group.key} (${new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(group.total)})`)
      .join(", ");
    return `You ${verb} ${amount} across ${result.count} transactions. Top groups: ${top}.`;
  }

  const dateLabel = spec.filters.from ? ` since ${spec.filters.from}` : "";

  if (spec.filters.from && spec.filters.to) {
    return `You ${verb} ${amount} across ${result.count} transactions between ${spec.filters.from} and ${spec.filters.to}.`;
  }

  return `You ${verb} ${amount} across ${result.count} transactions${dateLabel}.`;
}
