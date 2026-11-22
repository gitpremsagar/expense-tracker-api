import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { roundMoney } from "../../utils/date.js";
import { AppError, BadRequestError, ForbiddenError, NotFoundError } from "../../utils/errors.js";
import type { z } from "zod";
import type { importCommitSchema, importListQuerySchema } from "./assistant.schema.js";
import { loadCategories } from "./assistant.context.js";
import { todayInTimezone } from "./assistant.time.js";
import { normalizeDateValue } from "./assistant.time.js";
import { extractStatement } from "./media/statement.extract.js";
import {
  assertImportDate,
  extractRowsFromText,
  normalizeTableRows,
} from "./media/statement.normalize.js";
import { markDuplicates } from "./media/statement.dedupe.js";
import { createImportBatch, type UndoOperation } from "./assistant.actions.js";
import type { TransactionSnapshot } from "./assistant.actions.js";
import { sanitizeFilename } from "./media/image.js";
import { recordUsage, assertImportPageBudget } from "./assistant.usage.js";

export type PreparedImport = {
  id: string;
  status: string;
  filename: string;
  source: string;
  rowCount: number;
  duplicateCount: number;
  createdAt: Date;
};

export async function startImport(input: {
  userId: string;
  threadId?: string;
  buffer: Buffer;
  filename: string;
  mimeType: string;
  timeZone: string;
}): Promise<PreparedImport> {
  const lower = input.filename.toLowerCase();
  const source = lower.endsWith(".csv")
    ? "CSV"
    : lower.endsWith(".xlsx") || lower.endsWith(".xls")
      ? "XLSX"
      : lower.endsWith(".pdf")
        ? "PDF"
        : null;

  if (!source) {
    throw new AppError(415, "Upload a PDF, CSV or XLSX bank statement.");
  }

  if (input.threadId) {
    const thread = await prisma.assistantThread.findUnique({ where: { id: input.threadId } });
    if (!thread) throw new NotFoundError("Conversation not found");
    if (thread.userId !== input.userId) throw new ForbiddenError("You do not own this conversation");
  }

  const record = await prisma.assistantImport.create({
    data: {
      userId: input.userId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      source,
      filename: sanitizeFilename(input.filename, `statement.${source.toLowerCase()}`),
      status: "PROCESSING",
    },
  });

  // Process after responding so the client can poll. The buffer stays in memory
  // only for the life of this job.
  void processImport(record.id, input).catch(async (error) => {
    console.error("Statement import failed", record.id, error instanceof Error ? error.message : error);
    await prisma.assistantImportRow.deleteMany({ where: { importId: record.id } }).catch(() => {});
    await prisma.assistantImport
      .update({
        where: { id: record.id },
        data: {
          status: "FAILED",
          error:
            error instanceof AppError
              ? error.message
              : "That statement could not be processed. Please try again.",
        },
      })
      .catch(() => {});
  });

  return {
    id: record.id,
    status: record.status,
    filename: record.filename,
    source: record.source,
    rowCount: 0,
    duplicateCount: 0,
    createdAt: record.createdAt,
  };
}

async function processImport(importId: string, input: {
  userId: string;
  buffer: Buffer;
  filename: string;
  timeZone: string;
}): Promise<void> {
  const categories = await loadCategories(input.userId);
  const extraction = await extractStatement(input.buffer, input.filename);

  if (extraction.pages !== null && extraction.pages > env.ASSISTANT_DAILY_IMPORT_PAGES) {
    throw new AppError(422, `That statement has more than ${env.ASSISTANT_DAILY_IMPORT_PAGES} pages. Please split it.`);
  }

  await assertImportPageBudget(input.userId, extraction.pages ?? 1);

  let rows =
    extraction.rows.length > 0
      ? normalizeTableRows(extraction.rows, categories)
      : [];
  let promptTokens = 0;
  let completionTokens = 0;

  if (extraction.rows.length === 0) {
    const extracted = await extractRowsFromText({
      chunks: extraction.textChunks,
      categories,
      today: todayInTimezone(input.timeZone),
    });
    rows = extracted.rows;
    promptTokens = extracted.promptTokens;
    completionTokens = extracted.completionTokens;
  }

  rows = rows.filter((row) => assertImportDate(row.date));

  if (rows.length === 0) {
    throw new AppError(422, "No transactions were found in that statement.");
  }

  if (rows.length > env.ASSISTANT_MAX_IMPORT_ROWS) {
    throw new AppError(
      422,
      `That statement has ${rows.length} transactions. The limit is ${env.ASSISTANT_MAX_IMPORT_ROWS}; please split it.`,
    );
  }

  const deduped = await markDuplicates(input.userId, rows);
  const duplicateCount = deduped.filter((row) => row.status === "DUPLICATE").length;

  for (let index = 0; index < deduped.length; index += 1) {
    const row = deduped[index]!;
    await prisma.assistantImportRow.create({
      data: {
        importId,
        userId: input.userId,
        rowIndex: index,
        date: new Date(`${row.date}T12:00:00.000Z`),
        amount: roundMoney(row.amount),
        type: row.type,
        description: row.description,
        categoryId: row.categoryId,
        suggestedCategoryName: row.suggestedCategoryName,
        confidence: row.confidence,
        dedupeKey: row.dedupeKey,
        status: row.status,
      },
    });
  }

  await prisma.assistantImport.update({
    where: { id: importId },
    data: {
      status: "READY",
      pages: extraction.pages,
      rowCount: deduped.length,
      duplicateCount,
      error: null,
    },
  });

  await recordUsage(input.userId, {
    importPages: extraction.pages ?? 1,
    promptTokens,
    completionTokens,
    extraCostUsd: ((extraction.pages ?? 1) / 1_000) * 0.225,
  });
}

export async function getImport(
  userId: string,
  importId: string,
  query: z.infer<typeof importListQuerySchema>,
) {
  const record = await prisma.assistantImport.findUnique({
    where: { id: importId },
    include: {
      _count: { select: { rows: true } },
    },
  });

  if (!record) throw new NotFoundError("Import not found");
  if (record.userId !== userId) throw new ForbiddenError("You do not own this import");

  const where = {
    importId,
    ...(query.status === "all" ? {} : { status: query.status }),
  };

  const [rows, total, counts] = await Promise.all([
    prisma.assistantImportRow.findMany({
      where,
      orderBy: { rowIndex: "asc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.assistantImportRow.count({ where }),
    prisma.assistantImportRow.groupBy({
      by: ["status"],
      where: { importId },
      _count: { _all: true },
    }),
  ]);

  return {
    import: {
      id: record.id,
      filename: record.filename,
      source: record.source,
      status: record.status,
      pages: record.pages,
      rowCount: record._count.rows,
      duplicateCount: record.duplicateCount,
      error: record.error,
      createdAt: record.createdAt,
      committedAt: record.committedAt,
    },
    rows,
    counts: Object.fromEntries(counts.map((entry) => [entry.status, entry._count._all])),
    pagination: {
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    },
  };
}

export async function listImports(userId: string, limit = 20) {
  return prisma.assistantImport.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      filename: true,
      source: true,
      status: true,
      rowCount: true,
      duplicateCount: true,
      error: true,
      createdAt: true,
      committedAt: true,
    },
  });
}

export async function discardImport(userId: string, importId: string) {
  const record = await prisma.assistantImport.findUnique({ where: { id: importId } });
  if (!record) throw new NotFoundError("Import not found");
  if (record.userId !== userId) throw new ForbiddenError("You do not own this import");

  await prisma.assistantImportRow.deleteMany({ where: { importId } });
  await prisma.assistantImport.delete({ where: { id: importId } });
}

export type CommitResult = {
  batchId: string;
  imported: number;
  skipped: number;
  undoUntil: string;
};

export async function commitImport(
  userId: string,
  importId: string,
  input: z.infer<typeof importCommitSchema>,
  timeZone: string,
): Promise<CommitResult> {
  const existing = await prisma.assistantActionBatch.findUnique({
    where: { userId_requestId: { userId, requestId: input.clientRequestId } },
  });

  if (existing) {
    return {
      batchId: existing.id,
      imported: existing.createdIds.length,
      skipped: 0,
      undoUntil: new Date(existing.createdAt.getTime() + 10 * 60_000).toISOString(),
    };
  }

  const record = await prisma.assistantImport.findUnique({
    where: { id: importId },
    include: { rows: true },
  });

  if (!record) throw new NotFoundError("Import not found");
  if (record.userId !== userId) throw new ForbiddenError("You do not own this import");
  if (record.status !== "READY") throw new AppError(409, "That import is not ready to commit yet.");
  if (record.rows.length === 0) throw new AppError(422, "That import has no rows.");

  const selected = input.rows.filter((row) => row.include);
  const rowMap = new Map(record.rows.map((row) => [row.id, row]));

  if (selected.length === 0) {
    throw new BadRequestError("Select at least one transaction to import.");
  }

  const operations: UndoOperation[] = [];
  const createdIds: string[] = [];
  const skippedIds = input.rows.filter((row) => !row.include).map((row) => row.rowId);

  try {
    await prisma.$transaction(async (tx) => {
      for (const override of selected) {
        const row = rowMap.get(override.rowId);
        if (!row) throw new NotFoundError("One of those statement rows no longer exists");
        if (row.status === "IMPORTED") continue;

        const amount = roundMoney(override.amount ?? row.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new BadRequestError("One of the statement rows has an invalid amount");
        }

        const dateValue = (override.date ?? row.date.toISOString().slice(0, 10)).slice(0, 10);
        const date = normalizeDateValue(dateValue, timeZone);
        if (!date || !assertImportDate(dateValue)) {
          throw new BadRequestError("One of the statement rows has an invalid date");
        }

        let categoryId = override.categoryId ?? row.categoryId;
        let category = categoryId
          ? await tx.category.findFirst({ where: { id: categoryId, userId } })
          : null;

        if (!category && override.newCategoryName) {
          const type = (override.newCategoryType ?? (row.type === "INCOME" ? "INCOME" : "EXPENSE")) as
            | "INCOME"
            | "EXPENSE"
            | "SAVING"
            | "INVESTMENT";
          const name = override.newCategoryName.trim();
          category =
            (await tx.category.findUnique({ where: { userId_name_type: { userId, name, type } } })) ??
            (await tx.category.create({ data: { name, type, userId } }));
        }

        if (!category) {
          throw new BadRequestError(
            `Choose a category for "${row.description || row.date.toISOString().slice(0, 10)}" before importing.`,
          );
        }

        const transaction = await tx.transaction.create({
          data: {
            amount,
            note: (override.note ?? row.description)?.trim().slice(0, 500) || null,
            type: category.type,
            date,
            categoryId: category.id,
            userId,
            source: "IMPORT",
            importId,
            dedupeKey: row.dedupeKey,
          },
          include: { category: { select: { name: true } } },
        });

        const snapshot: TransactionSnapshot = {
          id: transaction.id,
          amount: transaction.amount,
          note: transaction.note,
          type: transaction.type,
          date: transaction.date.toISOString(),
          categoryId: transaction.categoryId,
          categoryName: transaction.category.name,
        };

        createdIds.push(transaction.id);
        operations.push({ kind: "CREATE", transactionId: transaction.id, after: snapshot });

        await tx.assistantImportRow.update({
          where: { id: row.id },
          data: { status: "IMPORTED", transactionId: transaction.id, categoryId: category.id },
        });
      }

      if (skippedIds.length > 0) {
        await tx.assistantImportRow.updateMany({
          where: { id: { in: skippedIds }, importId },
          data: { status: "SKIPPED" },
        });
      }

      await tx.assistantImport.update({
        where: { id: importId },
        data: { status: "COMMITTED", committedAt: new Date() },
      });
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2028" || /transaction/i.test(error.message))
    ) {
      throw new AppError(503, "The database does not support atomic imports. Use a MongoDB replica set.");
    }
    throw error;
  }

  const batchId = await createImportBatch({
    userId,
    requestId: input.clientRequestId,
    operations,
    createdIds,
  });

  return {
    batchId,
    imported: createdIds.length,
    skipped: skippedIds.length,
    undoUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

export function newRequestId(): string {
  return randomUUID();
}
