import { prisma } from "../../lib/prisma.js";
import { currentMonthKey, getMonthRange, roundMoney } from "../../utils/date.js";
import { BadRequestError, NotFoundError } from "../../utils/errors.js";
import type { UpsertBudgetInput } from "./budget.validation.js";

const TOTAL_SCOPE = "TOTAL";

type MonthSpend = {
  monthExpense: number;
  byCategory: Map<string, number>;
};

async function getMonthSpend(userId: string, month: string): Promise<MonthSpend> {
  const { start, end } = getMonthRange(month);
  const expenses = await prisma.transaction.findMany({
    where: { userId, type: "EXPENSE", date: { gte: start, lt: end } },
    select: { amount: true, categoryId: true },
  });

  let monthExpense = 0;
  const byCategory = new Map<string, number>();

  for (const expense of expenses) {
    monthExpense += expense.amount;
    byCategory.set(expense.categoryId, (byCategory.get(expense.categoryId) ?? 0) + expense.amount);
  }

  return { monthExpense: roundMoney(monthExpense), byCategory };
}

async function assertScope(userId: string, scope: string) {
  if (scope === TOTAL_SCOPE) return;

  const category = await prisma.category.findUnique({ where: { id: scope } });
  if (!category || category.userId !== userId) {
    throw new NotFoundError("Category not found");
  }
  if (category.type !== "EXPENSE") {
    throw new BadRequestError("Budgets can only be set for expense categories");
  }
}

export async function listBudgets(userId: string, monthInput?: string) {
  const month = monthInput ?? currentMonthKey();

  const [budgets, categories, spend] = await Promise.all([
    prisma.budget.findMany({ where: { userId, month }, orderBy: { amount: "desc" } }),
    prisma.category.findMany({ where: { userId, type: "EXPENSE" } }),
    getMonthSpend(userId, month),
  ]);

  const categoryById = new Map(categories.map((category) => [category.id, category]));

  const items = budgets.map((budget) => {
    const isTotal = budget.scope === TOTAL_SCOPE;
    const spent = isTotal ? spend.monthExpense : (spend.byCategory.get(budget.scope) ?? 0);
    const remaining = roundMoney(budget.amount - spent);
    const percentage = budget.amount > 0 ? Math.round((spent / budget.amount) * 100) : 0;

    return {
      id: budget.id,
      month: budget.month,
      scope: budget.scope,
      amount: budget.amount,
      spent: roundMoney(spent),
      remaining,
      percentage,
      overBudget: remaining < 0,
      categoryId: isTotal ? null : budget.scope,
      categoryName: isTotal ? "All expenses" : (categoryById.get(budget.scope)?.name ?? "Deleted category"),
    };
  });

  const totalBudget = items.find((item) => item.scope === TOTAL_SCOPE) ?? null;

  return {
    month,
    budgets: items.filter((item) => item.scope !== TOTAL_SCOPE),
    summary: {
      totalBudget: totalBudget?.amount ?? null,
      totalSpent: spend.monthExpense,
      remaining: totalBudget ? totalBudget.remaining : null,
      percentage: totalBudget?.percentage ?? null,
      overBudget: totalBudget?.overBudget ?? false,
    },
  };
}

export async function upsertBudget(userId: string, input: UpsertBudgetInput) {
  await assertScope(userId, input.scope);

  const amount = roundMoney(input.amount);
  const budget = await prisma.budget.upsert({
    where: {
      userId_month_scope: {
        userId,
        month: input.month,
        scope: input.scope,
      },
    },
    create: {
      userId,
      month: input.month,
      scope: input.scope,
      amount,
    },
    update: { amount },
  });

  return budget;
}

export async function deleteBudget(userId: string, budgetId: string) {
  const budget = await prisma.budget.findUnique({ where: { id: budgetId } });
  if (!budget || budget.userId !== userId) {
    throw new NotFoundError("Budget not found");
  }
  await prisma.budget.delete({ where: { id: budgetId } });
}


