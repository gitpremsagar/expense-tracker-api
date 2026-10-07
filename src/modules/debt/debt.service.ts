import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../utils/errors.js";
import type {
  CreateDebtInput,
  CreateDebtPaymentInput,
  ListDebtsInput,
  UpdateDebtInput,
  UpdateDebtPaymentInput,
} from "./debt.validation.js";

// Tolerates floating-point drift when comparing rupee amounts.
const EPSILON = 0.005;

type TxClient = Prisma.TransactionClient;

function withTotals<T extends { amount: number; payments: { amount: number }[] }>(debt: T) {
  const paidAmount = debt.payments.reduce((sum, p) => sum + p.amount, 0);
  const outstanding = Math.max(0, debt.amount - paidAmount);
  return { ...debt, paidAmount, outstanding };
}

async function sumPayments(tx: TxClient, debtId: string, excludePaymentId?: string) {
  const result = await tx.debtPayment.aggregate({
    where: { debtId, ...(excludePaymentId ? { id: { not: excludePaymentId } } : {}) },
    _sum: { amount: true },
  });
  return result._sum.amount ?? 0;
}

async function recomputeStatus(tx: TxClient, debtId: string, debtAmount: number) {
  const paid = await sumPayments(tx, debtId);
  await tx.debt.update({
    where: { id: debtId },
    data: { status: paid + EPSILON >= debtAmount ? "SETTLED" : "ACTIVE" },
  });
}

async function getOwnedDebt(userId: string, debtId: string) {
  const debt = await prisma.debt.findUnique({ where: { id: debtId } });

  if (!debt) {
    throw new NotFoundError("Debt not found");
  }

  if (debt.userId !== userId) {
    throw new ForbiddenError("You do not own this debt");
  }

  return debt;
}

async function getOwnedPayment(userId: string, debtId: string, paymentId: string) {
  const payment = await prisma.debtPayment.findUnique({ where: { id: paymentId } });

  if (!payment || payment.debtId !== debtId) {
    throw new NotFoundError("Payment not found");
  }

  if (payment.userId !== userId) {
    throw new ForbiddenError("You do not own this payment");
  }

  return payment;
}

export async function createDebt(userId: string, input: CreateDebtInput) {
  const debt = await prisma.debt.create({
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
  return { ...debt, paidAmount: 0, outstanding: debt.amount };
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
      include: { payments: { select: { amount: true } } },
    }),
    prisma.debt.count({ where }),
  ]);

  return {
    debts: debts.map(({ payments, ...debt }) => {
      const { paidAmount, outstanding } = withTotals({ ...debt, payments });
      return { ...debt, paidAmount, outstanding };
    }),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function getDebt(userId: string, debtId: string) {
  await getOwnedDebt(userId, debtId);

  const debt = await prisma.debt.findUniqueOrThrow({
    where: { id: debtId },
    include: { payments: { orderBy: { date: "desc" } } },
  });

  return withTotals(debt);
}

export async function updateDebt(
  userId: string,
  debtId: string,
  input: UpdateDebtInput,
) {
  await getOwnedDebt(userId, debtId);

  await prisma.$transaction(async (tx) => {
    if (input.amount !== undefined) {
      const paid = await sumPayments(tx, debtId);
      if (input.amount + EPSILON < paid) {
        throw new BadRequestError("Amount cannot be less than what has already been paid");
      }
    }

    const updated = await tx.debt.update({
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

    if (input.amount !== undefined && !input.status) {
      await recomputeStatus(tx, debtId, updated.amount);
    }
  });

  return getDebt(userId, debtId);
}

export async function deleteDebt(userId: string, debtId: string) {
  await getOwnedDebt(userId, debtId);

  await prisma.$transaction([
    prisma.debtPayment.deleteMany({ where: { debtId } }),
    prisma.debt.delete({ where: { id: debtId } }),
  ]);
}

export async function addPayment(userId: string, debtId: string, input: CreateDebtPaymentInput) {
  const debt = await getOwnedDebt(userId, debtId);

  await prisma.$transaction(async (tx) => {
    const paid = await sumPayments(tx, debtId);
    if (paid + input.amount > debt.amount + EPSILON) {
      throw new BadRequestError("Payment exceeds outstanding amount");
    }

    await tx.debtPayment.create({
      data: {
        amount: input.amount,
        date: input.date ? new Date(input.date) : new Date(),
        note: input.note || null,
        debtId,
        userId,
      },
    });

    await recomputeStatus(tx, debtId, debt.amount);
  });

  return getDebt(userId, debtId);
}

export async function updatePayment(
  userId: string,
  debtId: string,
  paymentId: string,
  input: UpdateDebtPaymentInput,
) {
  const debt = await getOwnedDebt(userId, debtId);
  await getOwnedPayment(userId, debtId, paymentId);

  await prisma.$transaction(async (tx) => {
    if (input.amount !== undefined) {
      const otherPaid = await sumPayments(tx, debtId, paymentId);
      if (otherPaid + input.amount > debt.amount + EPSILON) {
        throw new BadRequestError("Payment exceeds outstanding amount");
      }
    }

    await tx.debtPayment.update({
      where: { id: paymentId },
      data: {
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.date ? { date: new Date(input.date) } : {}),
        ...(input.note !== undefined ? { note: input.note || null } : {}),
      },
    });

    await recomputeStatus(tx, debtId, debt.amount);
  });

  return getDebt(userId, debtId);
}

export async function deletePayment(userId: string, debtId: string, paymentId: string) {
  const debt = await getOwnedDebt(userId, debtId);
  await getOwnedPayment(userId, debtId, paymentId);

  await prisma.$transaction(async (tx) => {
    await tx.debtPayment.delete({ where: { id: paymentId } });
    await recomputeStatus(tx, debtId, debt.amount);
  });

  return getDebt(userId, debtId);
}
