import { prisma } from "../../lib/prisma.js";
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
      amount: input.amount,
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
  const { month, year, type, categoryId, page, limit } = query;

  type DateFilter = { gte: Date; lt: Date } | undefined;
  let dateFilter: DateFilter;

  if (month) {
    const parts = month.split("-");
    const yearNum = parseInt(parts[0] ?? "0", 10);
    const mon = parseInt(parts[1] ?? "1", 10);
    const start = new Date(yearNum, mon - 1, 1);
    const end = new Date(yearNum, mon, 1);
    dateFilter = { gte: start, lt: end };
  } else if (year) {
    const yearNum = parseInt(year, 10);
    dateFilter = { gte: new Date(yearNum, 0, 1), lt: new Date(yearNum + 1, 0, 1) };
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
      skip: (page - 1) * limit,
      take: limit,
      include: { category: { select: { id: true, name: true, type: true } } },
    }),
    prisma.transaction.count({ where }),
  ]);

  return {
    transactions,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
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
      ...(input.amount !== undefined ? { amount: input.amount } : {}),
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
