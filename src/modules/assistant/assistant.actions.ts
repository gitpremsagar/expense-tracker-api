import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { roundMoney } from "../../utils/date.js";
import { AppError, BadRequestError, ForbiddenError, NotFoundError } from "../../utils/errors.js";
import type { ConfirmItem } from "./assistant.schema.js";
import { isDateInRange, normalizeDateValue } from "./assistant.time.js";

export type TransactionSnapshot = {
  id: string;
  amount: number;
  note: string | null;
  type: string;
  date: string;
  categoryId: string;
  categoryName: string;
};

type UndoOperation =
  | { kind: "CREATE"; transactionId: string; after: TransactionSnapshot }
  | { kind: "UPDATE"; transactionId: string; before: TransactionSnapshot; after: TransactionSnapshot }
  | { kind: "DELETE"; transactionId: string; before: TransactionSnapshot };

const MAX_UNDO_AGE_MS = 10 * 60_000;

function snapshot(transaction: {
  id: string;
  amount: number;
  note: string | null;
  type: string;
  date: Date;
  categoryId: string;
  category: { name: string };
}): TransactionSnapshot {
  return {
    id: transaction.id,
    amount: transaction.amount,
    note: transaction.note,
    type: transaction.type,
    date: transaction.date.toISOString(),
    categoryId: transaction.categoryId,
    categoryName: transaction.category.name,
  };
}

async function ownedCategory(
  tx: Prisma.TransactionClient,
  userId: string,
  categoryId: string,
) {
  const category = await tx.category.findFirst({ where: { id: categoryId, userId } });
  if (!category) throw new ForbiddenError("That category does not belong to you");
  return category;
}

async function categoryForCreate(
  tx: Prisma.TransactionClient,
  userId: string,
  item: {
    categoryId?: string | null | undefined;
    newCategoryName?: string | null | undefined;
    newCategoryType?: string | undefined;
  },
) {
  if (item.categoryId) {
    return ownedCategory(tx, userId, item.categoryId);
  }

  const name = item.newCategoryName?.trim();
  if (!name) {
    throw new BadRequestError("Choose a category before saving this transaction");
  }

  const type = (item.newCategoryType ?? "EXPENSE") as "INCOME" | "EXPENSE" | "SAVING" | "INVESTMENT";
  const existing = await tx.category.findUnique({
    where: { userId_name_type: { userId, name, type } },
  });
  if (existing) return existing;

  return tx.category.create({ data: { name, type, userId } });
}

export type ConfirmResult = {
  batchId: string;
  created: number;
  updated: number;
  deleted: number;
  transactions: TransactionSnapshot[];
  undoUntil: string;
};

export async function confirmActions(
  userId: string,
  input: { clientRequestId: string; threadId?: string; items: ConfirmItem[] },
  timeZone: string,
): Promise<ConfirmResult> {
  const existing = await prisma.assistantActionBatch.findUnique({
    where: { userId_requestId: { userId, requestId: input.clientRequestId } },
  });

  if (existing) {
    const previous = (existing.operations ?? []) as unknown as UndoOperation[];
    return {
      batchId: existing.id,
      created: previous.filter((operation) => operation.kind === "CREATE").length,
      updated: previous.filter((operation) => operation.kind === "UPDATE").length,
      deleted: previous.filter((operation) => operation.kind === "DELETE").length,
      transactions: previous.flatMap((operation) =>
        operation.kind === "DELETE" ? [] : [operation.after],
      ),
      undoUntil: new Date(existing.createdAt.getTime() + MAX_UNDO_AGE_MS).toISOString(),
    };
  }

  const operations: UndoOperation[] = [];
  const createdIds: string[] = [];
  let updated = 0;
  let deleted = 0;

  try {
    await prisma.$transaction(async (tx) => {
      for (const item of input.items) {
        if (item.kind === "CREATE") {
          const category = await categoryForCreate(tx, userId, item);
          const date = normalizeDateValue(item.date, timeZone);
          if (!date || !isDateInRange(date)) {
            throw new BadRequestError("That transaction date is not valid");
          }
          if (!Number.isFinite(item.amount) || item.amount <= 0 || item.amount > 10_00_00_000) {
            throw new BadRequestError("That transaction amount is not valid");
          }

          const transaction = await tx.transaction.create({
            data: {
              amount: roundMoney(item.amount),
              note: item.note?.trim() || null,
              type: category.type,
              date,
              categoryId: category.id,
              userId,
              source: item.source ?? "ASSISTANT",
            },
            include: { category: { select: { name: true } } },
          });

          createdIds.push(transaction.id);
          operations.push({
            kind: "CREATE",
            transactionId: transaction.id,
            after: snapshot(transaction),
          });
          continue;
        }

        const target = await tx.transaction.findUnique({
          where: { id: item.targetId },
          include: { category: { select: { name: true } } },
        });

        if (!target) throw new NotFoundError("That transaction no longer exists");
        if (target.userId !== userId) throw new ForbiddenError("You do not own that transaction");

        const before = snapshot(target);

        if (item.kind === "DELETE") {
          await tx.transaction.delete({ where: { id: target.id } });
          deleted += 1;
          operations.push({ kind: "DELETE", transactionId: target.id, before });
          continue;
        }

        const changes = item.changes;
        let categoryId = target.categoryId;
        let type = target.type;

        if (changes.categoryId) {
          const category = await ownedCategory(tx, userId, changes.categoryId);
          categoryId = category.id;
          type = category.type;
        }

        let date = target.date;
        if (changes.date) {
          const next = normalizeDateValue(changes.date, timeZone);
          if (!next || !isDateInRange(next)) {
            throw new BadRequestError("That transaction date is not valid");
          }
          date = next;
        }

        const amount =
          changes.amount !== undefined ? roundMoney(changes.amount) : target.amount;
        if (!Number.isFinite(amount) || amount <= 0 || amount > 10_00_00_000) {
          throw new BadRequestError("That transaction amount is not valid");
        }

        const transaction = await tx.transaction.update({
          where: { id: target.id },
          data: {
            amount,
            date,
            categoryId,
            type,
            ...(changes.note !== undefined ? { note: changes.note?.trim() || null } : {}),
          },
          include: { category: { select: { name: true } } },
        });

        updated += 1;
        operations.push({
          kind: "UPDATE",
          transactionId: target.id,
          before,
          after: snapshot(transaction),
        });
      }

      await tx.assistantActionBatch.create({
        data: {
          userId,
          threadId: input.threadId ?? null,
          requestId: input.clientRequestId,
          status: "CONFIRMED",
          operations: operations as unknown as Prisma.InputJsonValue,
          createdIds,
        },
      });
    });

    const batch = await prisma.assistantActionBatch.findUnique({
      where: { userId_requestId: { userId, requestId: input.clientRequestId } },
    });

    if (!batch) throw new Error("Could not record the assistant action");

    return {
      batchId: batch.id,
      created: createdIds.length,
      updated,
      deleted,
      transactions: operations.flatMap((operation) =>
        operation.kind === "DELETE" ? [] : [operation.after],
      ),
      undoUntil: new Date(batch.createdAt.getTime() + MAX_UNDO_AGE_MS).toISOString(),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2028" || /transaction/i.test(error.message))
    ) {
      throw new AppError(
        503,
        "The database does not support atomic assistant writes. Use a MongoDB replica set and try again.",
      );
    }

    throw error;
  }
}

export async function undoBatch(userId: string, batchId: string) {
  const batch = await prisma.assistantActionBatch.findUnique({ where: { id: batchId } });

  if (!batch) throw new NotFoundError("That action was not found");
  if (batch.userId !== userId) throw new ForbiddenError("You do not own that action");
  if (batch.status === "UNDONE") return { undone: true, restored: 0, deleted: 0 };
  if (Date.now() - batch.createdAt.getTime() > MAX_UNDO_AGE_MS) {
    throw new AppError(409, "The undo window for that action has expired");
  }

  const operations = (batch.operations ?? []) as unknown as UndoOperation[];

  let restored = 0;
  let removed = 0;

  await prisma.$transaction(async (tx) => {
    for (const operation of [...operations].reverse()) {
      if (operation.kind === "CREATE") {
        const current = await tx.transaction.findUnique({ where: { id: operation.transactionId } });
        if (current && current.userId === userId) {
          await tx.transaction.delete({ where: { id: operation.transactionId } });
          removed += 1;
        }
        continue;
      }

      if (operation.kind === "UPDATE") {
        const category = await ownedCategory(tx, userId, operation.before.categoryId);
        const current = await tx.transaction.findUnique({ where: { id: operation.transactionId } });
        if (!current) continue;

        await tx.transaction.update({
          where: { id: operation.transactionId },
          data: {
            amount: operation.before.amount,
            note: operation.before.note,
            type: category.type,
            date: new Date(operation.before.date),
            categoryId: category.id,
          },
        });
        restored += 1;
        continue;
      }

      const category = await ownedCategory(tx, userId, operation.before.categoryId);
      const existing = await tx.transaction.findUnique({ where: { id: operation.transactionId } });
      if (existing) continue;

      await tx.transaction.create({
        data: {
          id: operation.transactionId,
          amount: operation.before.amount,
          note: operation.before.note,
          type: category.type,
          date: new Date(operation.before.date),
          categoryId: category.id,
          userId,
          source: "ASSISTANT",
        },
      });
      restored += 1;
    }

    await tx.assistantActionBatch.update({
      where: { id: batchId },
      data: { status: "UNDONE", undoneAt: new Date() },
    });
  });

  return { undone: true, restored, deleted: removed };
}

/** Used by the statement import commit, which creates its own batch record. */
export async function createImportBatch(input: {
  userId: string;
  threadId?: string;
  requestId: string;
  operations: UndoOperation[];
  createdIds: string[];
}): Promise<string> {
  const batch = await prisma.assistantActionBatch.create({
    data: {
      userId: input.userId,
      threadId: input.threadId ?? null,
      requestId: input.requestId,
      status: "CONFIRMED",
      operations: input.operations as unknown as Prisma.InputJsonValue,
      createdIds: input.createdIds,
    },
  });
  return batch.id;
}

export type { UndoOperation };
