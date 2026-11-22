import { prisma } from "../../lib/prisma.js";
import { getMonthRange, getYearRange, roundMoney } from "../../utils/date.js";
import { ForbiddenError, NotFoundError } from "../../utils/errors.js";
import type {
  CreateTransactionInput,
  ListTransactionsInput,
  UpdateTransactionInput,
} from "./transaction.validation.js";

async function getCategoryOrThrow(userId: string, categoryId: string) {
  const category = await prisma.category.findUnique({ where: { id: categoryId } });

  if (!category) {
    throw new NotFoundError("Category not found");
  }

  if (category.userId !== userId) {
    throw new ForbiddenError("You do not own this category");
  }

  return category;
}

export async function createTransaction(userId: string, input: CreateTransactionInput) {
  const category = await getCategoryOrThrow(userId, input.categoryId);

  return prisma.transaction.create({
    data: {
      amount: roundMoney(input.amount),
      note: input.note ?? null,
      type: category.type,
      date: input.date ? new Date(input.date) : new Date(),
      categoryId: input.categoryId,
      userId,
    },
    include: { category: { select: { id: true, name: true, type: true } } },
  });
}

export async function listTransactions(userId: string, query: ListTransactionsInput) {
  const { month, year, from, to, type, categoryId, page, limit } = query;

  type DateFilter = { gte?: Date; lt?: Date } | undefined;
  let dateFilter: DateFilter;

  if (from || to) {
    dateFilter = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lt: new Date(to) } : {}),
    };
  } else if (month) {
    const { start, end } = getMonthRange(month);
    dateFilter = { gte: start, lt: end };
  } else if (year) {
    const { start, end } = getYearRange(parseInt(year, 10));
    dateFilter = { gte: start, lt: end };
  }

  const where = {
    userId,
    ...(type ? { type } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(dateFilter ? { date: dateFilter } : {}),
  };

  const [transactions, total] = await prisma.$transaction([
    prisma.transaction.findMany({
      where,
      orderBy: { date: "desc" },
      ...(limit ? { skip: (page - 1) * limit, take: limit } : {}),
      include: { category: { select: { id: true, name: true, type: true } } },
    }),
    prisma.transaction.count({ where }),
  ]);

  return {
    transactions,
    pagination: {
      total,
      page: limit ? page : 1,
      limit: limit ?? total,
      totalPages: limit ? Math.ceil(total / limit) : 1,
    },
  };
}

export async function getTransaction(userId: string, transactionId: string) {
  const transaction = await prisma.transaction.findUnique({
    where: { id: transactionId },
    include: { category: { select: { id: true, name: true, type: true } } },
  });

  if (!transaction) {
    throw new NotFoundError("Transaction not found");
  }

  if (transaction.userId !== userId) {
    throw new ForbiddenError("You do not own this transaction");
  }

  return transaction;
}

export async function updateTransaction(
  userId: string,
  transactionId: string,
  input: UpdateTransactionInput,
) {
  const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });

  if (!transaction) {
    throw new NotFoundError("Transaction not found");
  }

  if (transaction.userId !== userId) {
    throw new ForbiddenError("You do not own this transaction");
  }

  let newType = transaction.type;
  if (input.categoryId && input.categoryId !== transaction.categoryId) {
    const category = await getCategoryOrThrow(userId, input.categoryId);
    newType = category.type;
  }

  return prisma.transaction.update({
    where: { id: transactionId },
    data: {
      ...(input.amount !== undefined ? { amount: roundMoney(input.amount) } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.categoryId ? { categoryId: input.categoryId, type: newType } : {}),
      ...(input.date ? { date: new Date(input.date) } : {}),
    },
    include: { category: { select: { id: true, name: true, type: true } } },
  });
}

export async function deleteTransaction(userId: string, transactionId: string) {
  const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });

  if (!transaction) {
    throw new NotFoundError("Transaction not found");
  }

  if (transaction.userId !== userId) {
    throw new ForbiddenError("You do not own this transaction");
  }

  await prisma.transaction.delete({ where: { id: transactionId } });
}
