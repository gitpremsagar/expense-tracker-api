import { prisma } from "../../lib/prisma.js";
import { dateKey } from "../../utils/date.js";
import type {
  AssistantCategory,
  AssistantDebt,
  AssistantGroup,
  CandidateTransaction,
} from "./assistant.prompt.js";

export async function loadCategories(userId: string): Promise<AssistantCategory[]> {
  const categories = await prisma.category.findMany({
    where: { userId },
    orderBy: [{ type: "asc" }, { name: "asc" }],
    include: { group: { select: { name: true } } },
  });

  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    type: category.type,
    groupName: category.group?.name ?? null,
  }));
}

export async function loadGroups(userId: string): Promise<AssistantGroup[]> {
  const groups = await prisma.categoryGroup.findMany({
    where: { userId },
    orderBy: [{ type: "asc" }, { name: "asc" }],
    select: { id: true, name: true, type: true },
  });

  return groups.map((group) => ({ id: group.id, name: group.name, type: group.type }));
}

export async function loadDebts(
  userId: string,
  timeZone: string,
  limit = 25,
): Promise<AssistantDebt[]> {
  const debts = await prisma.debt.findMany({
    where: { userId },
    orderBy: { date: "desc" },
    take: limit,
    include: { payments: { select: { amount: true } } },
  });

  return debts.map((debt) => {
    const paidAmount = debt.payments.reduce((sum, payment) => sum + payment.amount, 0);
    return {
      id: debt.id,
      type: debt.type,
      partyName: debt.partyName,
      amount: debt.amount,
      paidAmount,
      outstanding: Math.max(0, debt.amount - paidAmount),
      status: debt.status,
      date: dateKey(debt.date, timeZone),
    };
  });
}

export async function loadCandidates(
  userId: string,
  timeZone: string,
  limit = 50,
): Promise<CandidateTransaction[]> {
  const since = new Date();
  since.setDate(since.getDate() - 90);

  const transactions = await prisma.transaction.findMany({
    where: { userId, date: { gte: since } },
    orderBy: { date: "desc" },
    take: limit,
    include: { category: { select: { name: true } } },
  });

  return transactions.map((transaction) => ({
    id: transaction.id,
    date: dateKey(transaction.date, timeZone),
    amount: transaction.amount,
    type: transaction.type,
    categoryName: transaction.category.name,
    note: transaction.note,
  }));
}

export async function loadAssistantContext(userId: string, timeZone: string) {
  const [categories, groups, debts, candidates] = await Promise.all([
    loadCategories(userId),
    loadGroups(userId),
    loadDebts(userId, timeZone),
    loadCandidates(userId, timeZone),
  ]);

  return { categories, groups, debts, candidates };
}
