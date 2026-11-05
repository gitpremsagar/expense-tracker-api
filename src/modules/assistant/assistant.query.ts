import type { CategoryType } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { formatIsoDateInTimeZone, zonedWallTimeToUtc } from "./assistant.time.js";
import type { ModelQuery } from "./assistant.validation.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const VALID_TYPES: CategoryType[] = ["INCOME", "EXPENSE", "SAVING", "INVESTMENT"];
const TYPE_LABEL: Record<CategoryType, string> = {
  INCOME: "income",
  EXPENSE: "spending",
  SAVING: "savings",
  INVESTMENT: "investments",
};
const TYPE_VERB: Record<CategoryType, string> = {
  INCOME: "received",
  EXPENSE: "spent",
  SAVING: "saved",
  INVESTMENT: "invested",
};

export type AssistantQuerySpec = {
  metric: "TOTAL" | "COUNT" | "LIST";
  types: CategoryType[];
  categoryIds: string[];
  categoryNames: string[];
  from: Date;
  to: Date;
  limit: number;
};

export type AssistantQueryTransaction = {
  id: string;
  amount: number;
  type: CategoryType;
  date: string;
  note: string | null;
  categoryName: string;
};

export type AssistantQueryResult = {
  metric: "TOTAL" | "COUNT" | "LIST";
  from: string;
  to: string;
  periodLabel: string;
  count: number;
  totals: Record<CategoryType, number>;
  net: number;
  byCategory: { id: string; name: string; type: CategoryType; total: number; count: number }[];
  transactions: AssistantQueryTransaction[];
  answer: string;
};

type CategoryLookup = { id: string; name: string; type: CategoryType };

function parseBoundary(value: string | null | undefined, timeZone: string): Date | null {
  if (!value) return null;
  const trimmed = value.trim();

  if (DATE_ONLY.test(trimmed)) {
    const [year, month, day] = trimmed.split("-").map(Number);
    if (!year || !month || !day) return null;
    return zonedWallTimeToUtc(year, month, day, 0, 0, 0, timeZone);
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function startOfMonth(date: Date, timeZone: string) {
  const iso = formatIsoDateInTimeZone(date, timeZone);
  const [year, month] = iso.split("-").map(Number);
  return zonedWallTimeToUtc(year!, month!, 1, 0, 0, 0, timeZone);
}

function addMonths(date: Date, months: number, timeZone: string) {
  const iso = formatIsoDateInTimeZone(date, timeZone);
  const [year, month] = iso.split("-").map(Number);
  const base = new Date(Date.UTC(year!, month! - 1 + months, 1));
  return zonedWallTimeToUtc(
    base.getUTCFullYear(),
    base.getUTCMonth() + 1,
    1,
    0,
    0,
    0,
    timeZone,
  );
}

function defaultPeriod(now: Date, timeZone: string) {
  const start = startOfMonth(now, timeZone);
  return { from: start, to: addMonths(start, 1, timeZone) };
}

/** Builds a safe query spec from model output, falling back to the current month. */
export function buildQuerySpec(
  query: ModelQuery | null | undefined,
  categories: CategoryLookup[],
  timeZone: string,
  now: Date,
): AssistantQuerySpec {
  const ownedCategoryIds = new Set(categories.map((category) => category.id));
  const categoriesByName = new Map(
    categories.map((category) => [category.name.toLowerCase(), category]),
  );

  const types = (query?.types ?? [])
    .map((type) => type.trim().toUpperCase() as CategoryType)
    .filter((type) => VALID_TYPES.includes(type));

  const categoryIds = [...new Set((query?.categoryIds ?? []).filter((id) => ownedCategoryIds.has(id)))];

  const categoryNames: string[] = [];
  for (const rawName of query?.categoryNames ?? []) {
    const match = categoriesByName.get(rawName.trim().toLowerCase());
    if (!match) continue;
    categoryNames.push(match.name);
    if (!categoryIds.includes(match.id)) categoryIds.push(match.id);
  }

  const rawFrom = parseBoundary(query?.from, timeZone);
  const rawTo = parseBoundary(query?.to, timeZone);
  const fallback = defaultPeriod(now, timeZone);

  let from = rawFrom ?? (rawTo ? startOfMonth(rawTo, timeZone) : fallback.from);
  let to = rawTo ?? addMonths(from, 1, timeZone);

  const lowerBound = Date.UTC(2000, 0, 1);
  const upperBound = now.getTime() + 400 * 24 * 60 * 60 * 1000;

  if (
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    from.getTime() < lowerBound ||
    to.getTime() > upperBound ||
    from.getTime() >= to.getTime()
  ) {
    from = fallback.from;
    to = fallback.to;
  }

  const metricRaw = (query?.metric ?? "TOTAL").trim().toUpperCase();
  const metric = metricRaw === "COUNT" ? "COUNT" : metricRaw === "LIST" ? "LIST" : "TOTAL";

  const limit = Math.min(50, Math.max(1, query?.limit ?? 10));

  return { metric, types, categoryIds, categoryNames, from, to, limit };
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount);
}

function formatDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function periodLabel(from: Date, to: Date, timeZone: string): string {
  // A full calendar month: first day to first day of the next month.
  const fromIso = formatIsoDateInTimeZone(from, timeZone);
  const toIso = formatIsoDateInTimeZone(to, timeZone);
  const fromParts = fromIso.split("-").map(Number);
  const toParts = toIso.split("-").map(Number);

  const isMonthStart = fromParts[2] === 1;
  const nextMonth = addMonths(from, 1, timeZone);
  const isFullMonth = isMonthStart && nextMonth.getTime() === to.getTime();
  if (isFullMonth) {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone,
      month: "long",
      year: "numeric",
    }).format(from);
  }

  // A full calendar year.
  if (
    isMonthStart &&
    fromParts[1]! === 1 &&
    toParts[1]! === 1 &&
    toParts[0]! === fromParts[0]! + 1
  ) {
    return String(fromParts[0]!);
  }

  return `${formatDate(from, timeZone)} – ${formatDate(new Date(to.getTime() - 1), timeZone)}`;
}

function describeFilters(spec: AssistantQuerySpec): string {
  if (spec.categoryNames.length > 0) {
    return ` on ${spec.categoryNames.join(", ")}`;
  }

  return "";
}

function buildAnswer(
  spec: AssistantQuerySpec,
  period: string,
  totals: Record<CategoryType, number>,
  count: number,
  net: number,
  transactions: AssistantQueryTransaction[],
  byCategory: AssistantQueryResult["byCategory"],
): string {
  if (count === 0 && transactions.length === 0) {
    return `No matching transactions found for ${period}.`;
  }

  if (spec.metric === "LIST") {
    const label = spec.types.length === 1 ? `${TYPE_LABEL[spec.types[0]!]} ` : "";
    return `Here ${transactions.length === 1 ? "is" : "are"} your ${transactions.length} most recent ${label}transaction${
      transactions.length === 1 ? "" : "s"
    } for ${period}.`;
  }

  if (spec.metric === "COUNT") {
    return `You have ${count} matching transaction${count === 1 ? "" : "s"} for ${period}.`;
  }

  const filters = describeFilters(spec);

  if (byCategory.length === 1 && spec.types.length === 1) {
    const category = byCategory[0]!;
    return `You ${TYPE_VERB[spec.types[0]!]} ${formatCurrency(category.total)} on ${category.name} in ${period}.`;
  }

  if (spec.types.length === 1) {
    const type = spec.types[0]!;
    let answer = `You ${TYPE_VERB[type]} ${formatCurrency(totals[type])}${filters} in ${period}.`;
    if (byCategory.length > 1) {
      const top = byCategory
        .slice(0, 3)
        .map((item) => `${item.name} ${formatCurrency(item.total)}`)
        .join(", ");
      answer += ` Top categories: ${top}.`;
    }
    return answer;
  }

  const parts: string[] = [];
  for (const type of VALID_TYPES) {
    if (totals[type] > 0) {
      parts.push(`${TYPE_VERB[type]} ${formatCurrency(totals[type])}`);
    }
  }

  if (parts.length === 0) {
    return `No matching transactions found for ${period}.`;
  }

  return `In ${period}${filters}, you ${parts.join(", ")}. Net balance: ${formatCurrency(net)}.`;
}

export async function executeQuery(
  userId: string,
  spec: AssistantQuerySpec,
  timeZone: string,
): Promise<AssistantQueryResult> {
  const types = spec.types.length > 0 ? spec.types : VALID_TYPES;
  const where = {
    userId,
    type: { in: types },
    ...(spec.categoryIds.length > 0 ? { categoryId: { in: spec.categoryIds } } : {}),
    date: { gte: spec.from, lt: spec.to },
  };

  const period = periodLabel(spec.from, spec.to, timeZone);

  if (spec.metric === "LIST") {
    const rows = await prisma.transaction.findMany({
      where,
      orderBy: { date: "desc" },
      take: spec.limit,
      include: { category: { select: { name: true } } },
    });

    const transactions: AssistantQueryTransaction[] = rows.map((row) => ({
      id: row.id,
      amount: row.amount,
      type: row.type,
      date: row.date.toISOString(),
      note: row.note,
      categoryName: row.category.name,
    }));

    const totals = { INCOME: 0, EXPENSE: 0, SAVING: 0, INVESTMENT: 0 } as Record<
      CategoryType,
      number
    >;
    for (const row of rows) totals[row.type] += row.amount;

    const answer = buildAnswer(spec, period, totals, rows.length, 0, transactions, []);

    return {
      metric: "LIST",
      from: spec.from.toISOString(),
      to: spec.to.toISOString(),
      periodLabel: period,
      count: rows.length,
      totals,
      net: 0,
      byCategory: [],
      transactions,
      answer,
    };
  }

  const grouped = await prisma.transaction.groupBy({
    by: ["type", "categoryId"],
    where,
    _sum: { amount: true },
    _count: { _all: true },
  });

  const totals = { INCOME: 0, EXPENSE: 0, SAVING: 0, INVESTMENT: 0 } as Record<
    CategoryType,
    number
  >;
  let count = 0;
  const categoryTotals = new Map<string, { total: number; count: number }>();

  for (const group of grouped) {
    const amount = group._sum.amount ?? 0;
    const groupCount = group._count._all;
    totals[group.type] += amount;
    count += groupCount;

    const existing = categoryTotals.get(group.categoryId) ?? { total: 0, count: 0 };
    existing.total += amount;
    existing.count += groupCount;
    categoryTotals.set(group.categoryId, existing);
  }

  const categoryRows =
    categoryTotals.size > 0
      ? await prisma.category.findMany({
          where: { id: { in: [...categoryTotals.keys()] }, userId },
          select: { id: true, name: true, type: true },
        })
      : [];

  const byCategory = categoryRows
    .map((category) => {
      const entry = categoryTotals.get(category.id)!;
      return {
        id: category.id,
        name: category.name,
        type: category.type,
        total: Math.round(entry.total * 100) / 100,
        count: entry.count,
      };
    })
    .sort((a, b) => b.total - a.total);

  for (const type of VALID_TYPES) {
    totals[type] = Math.round(totals[type] * 100) / 100;
  }

  const net =
    Math.round((totals.INCOME - totals.EXPENSE - totals.SAVING - totals.INVESTMENT) * 100) / 100;

  const answer = buildAnswer(spec, period, totals, count, net, [], byCategory);

  return {
    metric: spec.metric,
    from: spec.from.toISOString(),
    to: spec.to.toISOString(),
    periodLabel: period,
    count,
    totals,
    net,
    byCategory: byCategory.slice(0, 10),
    transactions: [],
    answer,
  };
}
