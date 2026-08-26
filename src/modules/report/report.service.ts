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

function percentageOf(total: number, part: number): number {
  return total > 0 ? +((part / total) * 100).toFixed(1) : 0;
}

export async function getMonthlyReport(userId: string, month: string) {
  const { start, end } = parseMonth(month);

  const transactions = await prisma.transaction.findMany({
    where: { userId, date: { gte: start, lt: end } },
    include: { category: { select: { id: true, name: true } } },
    orderBy: { date: "asc" },
  });

  let totalIncome = 0;
  let totalExpense = 0;
  let totalSaving = 0;
  let totalInvestment = 0;

  const categoryMap = new Map<
    string,
    { id: string; name: string; type: string; total: number }
  >();

  const dailyMap = new Map<
    string,
    { date: string; income: number; expense: number; saving: number; investment: number }
  >();

  for (const tx of transactions) {
    const dateKey = tx.date.toISOString().slice(0, 10);

    if (!dailyMap.has(dateKey)) {
      dailyMap.set(dateKey, { date: dateKey, income: 0, expense: 0, saving: 0, investment: 0 });
    }

    const day = dailyMap.get(dateKey)!;

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

  const dailyTotals = Array.from(dailyMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  return {
    month,
    totalIncome: +totalIncome.toFixed(2),
    totalExpense: +totalExpense.toFixed(2),
    totalSaving: +totalSaving.toFixed(2),
    totalInvestment: +totalInvestment.toFixed(2),
    netBalance: +(totalIncome - totalExpense - totalSaving - totalInvestment).toFixed(2),
    categoryBreakdown,
    dailyTotals,
  };
}
