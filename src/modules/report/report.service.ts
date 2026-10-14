import { prisma } from "../../lib/prisma.js";

function parseMonth(month: string): { start: Date; end: Date } {
  const parts = month.split("-");
  const year = parseInt(parts[0] ?? "0", 10);
  const mon = parseInt(parts[1] ?? "1", 10);
  return {
    start: new Date(year, mon - 1, 1),
    end: new Date(year, mon, 1),
  };
}

function parseYear(year: number): { start: Date; end: Date } {
  return {
    start: new Date(year, 0, 1),
    end: new Date(year + 1, 0, 1),
  };
}

function monthKey(year: number, monthIndex: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
}

function percentageOf(total: number, part: number): number {
  return total > 0 ? +((part / total) * 100).toFixed(1) : 0;
}

const categoryInclude = {
  category: {
    select: { id: true, name: true, group: { select: { id: true, name: true } } },
  },
} as const;

type CategoryTotal = {
  id: string;
  name: string;
  type: string;
  groupId: string | null;
  groupName: string | null;
  total: number;
};

type CategoryBreakdownItem = CategoryTotal & { percentage: number };

function buildGroupBreakdown(
  categoryBreakdown: CategoryBreakdownItem[],
  typeTotals: Record<string, number>,
) {
  const groupMap = new Map<
    string,
    {
      id: string | null;
      name: string;
      type: string;
      total: number;
      categories: { id: string; name: string; total: number; percentage: number }[];
    }
  >();

  for (const cat of categoryBreakdown) {
    const key = `${cat.type}:${cat.groupId ?? "ungrouped"}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        id: cat.groupId,
        name: cat.groupName ?? "Ungrouped",
        type: cat.type,
        total: 0,
        categories: [],
      });
    }
    const group = groupMap.get(key)!;
    group.total += cat.total;
    group.categories.push({ id: cat.id, name: cat.name, total: cat.total, percentage: cat.percentage });
  }

  return Array.from(groupMap.values())
    .map((group) => ({
      ...group,
      total: +group.total.toFixed(2),
      percentage: percentageOf(typeTotals[group.type] ?? 0, group.total),
      categories: group.categories.sort((a, b) => b.total - a.total),
    }))
    .sort((a, b) => b.total - a.total);
}

function findDebtRepayments(userId: string, start: Date, end: Date) {
  return prisma.debtPayment.findMany({
    where: { userId, date: { gte: start, lt: end }, debt: { type: "TAKEN" } },
    select: { amount: true, date: true },
  });
}

export async function getMonthlyReport(userId: string, month: string) {
  const { start, end } = parseMonth(month);

  const [transactions, debtRepayments] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId, date: { gte: start, lt: end } },
      include: categoryInclude,
      orderBy: { date: "asc" },
    }),
    findDebtRepayments(userId, start, end),
  ]);

  let totalIncome = 0;
  let totalExpense = 0;
  let totalSaving = 0;
  let totalInvestment = 0;
  let totalDebtRepayment = 0;

  const categoryMap = new Map<string, CategoryTotal>();

  const dailyMap = new Map<
    string,
    {
      date: string;
      income: number;
      expense: number;
      saving: number;
      investment: number;
      debtRepayment: number;
    }
  >();

  const dayBucket = (dateKey: string) => {
    if (!dailyMap.has(dateKey)) {
      dailyMap.set(dateKey, {
        date: dateKey,
        income: 0,
        expense: 0,
        saving: 0,
        investment: 0,
        debtRepayment: 0,
      });
    }
    return dailyMap.get(dateKey)!;
  };

  for (const payment of debtRepayments) {
    totalDebtRepayment += payment.amount;
    dayBucket(payment.date.toISOString().slice(0, 10)).debtRepayment += payment.amount;
  }

  for (const tx of transactions) {
    const dateKey = tx.date.toISOString().slice(0, 10);

    const day = dayBucket(dateKey);

    switch (tx.type) {
      case "INCOME":
        totalIncome += tx.amount;
        day.income += tx.amount;
        break;
      case "EXPENSE":
        totalExpense += tx.amount;
        day.expense += tx.amount;
        break;
      case "SAVING":
        totalSaving += tx.amount;
        day.saving += tx.amount;
        break;
      case "INVESTMENT":
        totalInvestment += tx.amount;
        day.investment += tx.amount;
        break;
    }

    const catKey = tx.categoryId;
    if (!categoryMap.has(catKey)) {
      categoryMap.set(catKey, {
        id: tx.category.id,
        name: tx.category.name,
        type: tx.type,
        groupId: tx.category.group?.id ?? null,
        groupName: tx.category.group?.name ?? null,
        total: 0,
      });
    }
    categoryMap.get(catKey)!.total += tx.amount;
  }

  const typeTotals: Record<string, number> = {
    INCOME: totalIncome,
    EXPENSE: totalExpense,
    SAVING: totalSaving,
    INVESTMENT: totalInvestment,
  };

  const categoryBreakdown = Array.from(categoryMap.values()).map((cat) => ({
    ...cat,
    percentage: percentageOf(typeTotals[cat.type] ?? 0, cat.total),
  }));

  categoryBreakdown.sort((a, b) => b.total - a.total);

  const groupBreakdown = buildGroupBreakdown(categoryBreakdown, typeTotals);

  const dailyTotals = Array.from(dailyMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  return {
    month,
    totalIncome: +totalIncome.toFixed(2),
    totalExpense: +totalExpense.toFixed(2),
    totalSaving: +totalSaving.toFixed(2),
    totalInvestment: +totalInvestment.toFixed(2),
    totalDebtRepayment: +totalDebtRepayment.toFixed(2),
    netBalance: +(
      totalIncome -
      totalExpense -
      totalSaving -
      totalInvestment -
      totalDebtRepayment
    ).toFixed(2),
    categoryBreakdown,
    groupBreakdown,
    dailyTotals,
  };
}

export async function getAnnualReport(userId: string, year: number) {
  const { start, end } = parseYear(year);

  const [transactions, debtRepayments] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId, date: { gte: start, lt: end } },
      include: categoryInclude,
      orderBy: { date: "asc" },
    }),
    findDebtRepayments(userId, start, end),
  ]);

  let totalIncome = 0;
  let totalExpense = 0;
  let totalSaving = 0;
  let totalInvestment = 0;
  let totalDebtRepayment = 0;

  const categoryMap = new Map<string, CategoryTotal>();

  const monthlyMap = new Map<
    string,
    {
      month: string;
      income: number;
      expense: number;
      saving: number;
      investment: number;
      debtRepayment: number;
    }
  >();

  for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
    const key = monthKey(year, monthIndex);
    monthlyMap.set(key, {
      month: key,
      income: 0,
      expense: 0,
      saving: 0,
      investment: 0,
      debtRepayment: 0,
    });
  }

  for (const payment of debtRepayments) {
    const monthBucket = monthlyMap.get(monthKey(payment.date.getFullYear(), payment.date.getMonth()));
    if (!monthBucket) continue;
    totalDebtRepayment += payment.amount;
    monthBucket.debtRepayment += payment.amount;
  }

  for (const tx of transactions) {
    const key = monthKey(tx.date.getFullYear(), tx.date.getMonth());
    const monthBucket = monthlyMap.get(key);
    if (!monthBucket) continue;

    switch (tx.type) {
      case "INCOME":
        totalIncome += tx.amount;
        monthBucket.income += tx.amount;
        break;
      case "EXPENSE":
        totalExpense += tx.amount;
        monthBucket.expense += tx.amount;
        break;
      case "SAVING":
        totalSaving += tx.amount;
        monthBucket.saving += tx.amount;
        break;
      case "INVESTMENT":
        totalInvestment += tx.amount;
        monthBucket.investment += tx.amount;
        break;
    }

    const catKey = tx.categoryId;
    if (!categoryMap.has(catKey)) {
      categoryMap.set(catKey, {
        id: tx.category.id,
        name: tx.category.name,
        type: tx.type,
        groupId: tx.category.group?.id ?? null,
        groupName: tx.category.group?.name ?? null,
        total: 0,
      });
    }
    categoryMap.get(catKey)!.total += tx.amount;
  }

  const typeTotals: Record<string, number> = {
    INCOME: totalIncome,
    EXPENSE: totalExpense,
    SAVING: totalSaving,
    INVESTMENT: totalInvestment,
  };

  const categoryBreakdown = Array.from(categoryMap.values()).map((cat) => ({
    ...cat,
    percentage: percentageOf(typeTotals[cat.type] ?? 0, cat.total),
  }));

  categoryBreakdown.sort((a, b) => b.total - a.total);

  const groupBreakdown = buildGroupBreakdown(categoryBreakdown, typeTotals);

  const monthlyTotals = Array.from(monthlyMap.values()).map((bucket) => ({
    month: bucket.month,
    income: +bucket.income.toFixed(2),
    expense: +bucket.expense.toFixed(2),
    saving: +bucket.saving.toFixed(2),
    investment: +bucket.investment.toFixed(2),
    debtRepayment: +bucket.debtRepayment.toFixed(2),
  }));

  return {
    year,
    totalIncome: +totalIncome.toFixed(2),
    totalExpense: +totalExpense.toFixed(2),
    totalSaving: +totalSaving.toFixed(2),
    totalInvestment: +totalInvestment.toFixed(2),
    totalDebtRepayment: +totalDebtRepayment.toFixed(2),
    netBalance: +(
      totalIncome -
      totalExpense -
      totalSaving -
      totalInvestment -
      totalDebtRepayment
    ).toFixed(2),
    categoryBreakdown,
    groupBreakdown,
    monthlyTotals,
  };
}
