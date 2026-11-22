import { prisma } from "../../lib/prisma.js";
import { dateKey } from "../../utils/date.js";
import type { AssistantCategory, CandidateTransaction } from "./assistant.prompt.js";

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
  const [categories, candidates] = await Promise.all([
    loadCategories(userId),
    loadCandidates(userId, timeZone),
  ]);

  return { categories, candidates };
}
