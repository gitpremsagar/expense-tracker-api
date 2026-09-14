import { prisma } from "../../lib/prisma.js";
import { ForbiddenError, NotFoundError } from "../../utils/errors.js";
import type {
  CreateDebtInput,
  ListDebtsInput,
  UpdateDebtInput,
} from "./debt.validation.js";

export async function createDebt(userId: string, input: CreateDebtInput) {
  return prisma.debt.create({
    data: {
      type: input.type,
      partyName: input.partyName,
      amount: input.amount,
      description: input.description ?? null,
      date: input.date ? new Date(input.date) : new Date(),
      status: "ACTIVE",
      userId,
    },
  });
}

export async function listDebts(userId: string, query: ListDebtsInput) {
  const { type, status, page, limit } = query;

  const where = {
    userId,
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
  };

  const [debts, total] = await prisma.$transaction([
    prisma.debt.findMany({
      where,
      orderBy: { date: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.debt.count({ where }),
  ]);

  return {
    debts,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function getDebt(userId: string, debtId: string) {
  const debt = await prisma.debt.findUnique({
    where: { id: debtId },
  });

  if (!debt) {
    throw new NotFoundError("Debt not found");
  }

  if (debt.userId !== userId) {
    throw new ForbiddenError("You do not own this debt");
  }

  return debt;
}

export async function updateDebt(
  userId: string,
  debtId: string,
  input: UpdateDebtInput,
) {
  const debt = await prisma.debt.findUnique({ where: { id: debtId } });

  if (!debt) {
    throw new NotFoundError("Debt not found");
  }

  if (debt.userId !== userId) {
    throw new ForbiddenError("You do not own this debt");
  }

  return prisma.debt.update({
    where: { id: debtId },
    data: {
      ...(input.type ? { type: input.type } : {}),
      ...(input.partyName ? { partyName: input.partyName } : {}),
      ...(input.amount !== undefined ? { amount: input.amount } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.date ? { date: new Date(input.date) } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
  });
}

export async function deleteDebt(userId: string, debtId: string) {
  const debt = await prisma.debt.findUnique({ where: { id: debtId } });

  if (!debt) {
    throw new NotFoundError("Debt not found");
  }

  if (debt.userId !== userId) {
    throw new ForbiddenError("You do not own this debt");
  }

  await prisma.debt.delete({ where: { id: debtId } });
}
