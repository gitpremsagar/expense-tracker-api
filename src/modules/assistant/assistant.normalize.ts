import { randomUUID } from "node:crypto";
import type { CategoryType } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { dateKey, roundMoney } from "../../utils/date.js";
import type { AssistantCategory } from "./assistant.prompt.js";
import type { ModelTurn, QuerySpec } from "./assistant.schema.js";
import { isDateInRange, normalizeDateValue } from "./assistant.time.js";
import type { TransactionSnapshot } from "./assistant.actions.js";

export type AssistantProposal = {
  proposalId: string;
  amount: number;
  type: CategoryType;
  categoryId: string | null;
  categoryName: string | null;
  suggestedCategoryName: string | null;
  date: string;
  note: string;
  confidence: number;
  source: "TEXT" | "IMAGE" | "AUDIO";
};

export type AssistantOperation = {
  operationId: string;
  kind: "UPDATE" | "DELETE";
  targetId: string;
  before: TransactionSnapshot;
  after: TransactionSnapshot | null;
  changes: {
    amount?: number;
    categoryId?: string;
    date?: string;
    note?: string | null;
  };
  confidence: number;
};

export type AssistantTurn = {
  intent: ModelTurn["intent"];
  reply: string;
  proposals: AssistantProposal[];
  operations: AssistantOperation[];
  query: QuerySpec | null;
  queryResult: unknown | null;
  clarifications: string[];
  savedProposalIds?: string[];
  savedOperationIds?: string[];
  savedBatchId?: string;
};

function dateOnly(value: string, timeZone: string): string | null {
  const parsed = normalizeDateValue(value, timeZone);
  if (!parsed || !isDateInRange(parsed)) return null;
  return dateKey(parsed, timeZone);
}

export async function normalizeTurn(input: {
  turn: ModelTurn;
  userId: string;
  categories: AssistantCategory[];
  timeZone: string;
  source: "TEXT" | "IMAGE" | "AUDIO";
}): Promise<AssistantTurn> {
  const categoryMap = new Map(input.categories.map((category) => [category.id, category]));
  const clarifications = [...input.turn.clarifications];
  const proposals: AssistantProposal[] = [];

  for (const proposal of input.turn.proposals) {
    if (proposals.length >= env.ASSISTANT_MAX_CREATES_PER_TURN) break;

    const amount = roundMoney(Number(proposal.amount));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10_00_00_000) {
      clarifications.push("What was the amount?");
      continue;
    }

    const date = dateOnly(proposal.date, input.timeZone);
    if (!date) {
      clarifications.push("What date should I use for that transaction?");
      continue;
    }

    let category = proposal.categoryId ? categoryMap.get(proposal.categoryId) : undefined;
    const suggested = proposal.suggestedCategoryName?.trim() || null;

    if (proposal.categoryId && !category) {
      clarifications.push("Which category should that transaction use?");
    }

    proposals.push({
      proposalId: randomUUID(),
      amount,
      type: category?.type ?? proposal.type ?? "EXPENSE",
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? null,
      suggestedCategoryName: category ? null : suggested,
      date,
      note: (proposal.note ?? "").trim().slice(0, 500),
      confidence: Math.min(1, Math.max(0, proposal.confidence ?? 0.5)),
      source: input.source,
    });
  }

  const operations: AssistantOperation[] = [];

  for (const operation of input.turn.operations.slice(0, 5)) {
    const target = await prisma.transaction.findUnique({
      where: { id: operation.targetId },
      include: { category: { select: { name: true } } },
    });

    if (!target || target.userId !== input.userId) {
      clarifications.push("I could not find that transaction. Which one do you mean?");
      continue;
    }

    const before: TransactionSnapshot = {
      id: target.id,
      amount: target.amount,
      note: target.note,
      type: target.type,
      date: target.date.toISOString(),
      categoryId: target.categoryId,
      categoryName: target.category.name,
    };

    if (operation.kind === "DELETE") {
      operations.push({
        operationId: randomUUID(),
        kind: "DELETE",
        targetId: target.id,
        before,
        after: null,
        changes: {},
        confidence: operation.confidence,
      });
      continue;
    }

    const changes: AssistantOperation["changes"] = {};
    let amount = target.amount;
    let categoryId = target.categoryId;
    let type = target.type;
    let date = target.date;
    let note = target.note;
    let categoryName = target.category.name;

    if (operation.changes.amount !== undefined) {
      const next = roundMoney(Number(operation.changes.amount));
      if (Number.isFinite(next) && next > 0 && next <= 10_00_00_000) {
        amount = next;
        changes.amount = next;
      }
    }

    if (operation.changes.categoryId) {
      const category = categoryMap.get(operation.changes.categoryId);
      if (category) {
        categoryId = category.id;
        type = category.type;
        categoryName = category.name;
        changes.categoryId = category.id;
      }
    }

    if (operation.changes.date) {
      const next = normalizeDateValue(operation.changes.date, input.timeZone);
      if (next && isDateInRange(next)) {
        date = next;
        changes.date = dateKey(next, input.timeZone);
      }
    }

    if (operation.changes.note !== undefined) {
      note = operation.changes.note?.trim().slice(0, 500) || null;
      changes.note = note;
    }

    operations.push({
      operationId: randomUUID(),
      kind: "UPDATE",
      targetId: target.id,
      before,
      after: {
        id: target.id,
        amount,
        note,
        type,
        date: date.toISOString(),
        categoryId,
        categoryName,
      },
      changes,
      confidence: operation.confidence,
    });
  }

  let query = input.turn.query;
  if (query) {
    const categoryIds = (query.filters.categoryIds ?? []).filter((id) => categoryMap.has(id));
    const filters: QuerySpec["filters"] = {};
    const from = query.filters.from ? dateOnly(query.filters.from, input.timeZone) : null;
    const to = query.filters.to ? dateOnly(query.filters.to, input.timeZone) : null;

    if (from) filters.from = from;
    if (to) filters.to = to;
    if (query.filters.types?.length) filters.types = query.filters.types;
    if (categoryIds.length) filters.categoryIds = categoryIds;
    if (query.filters.text) filters.text = query.filters.text.slice(0, 100);
    if (query.filters.minAmount !== undefined) {
      filters.minAmount = Math.max(0, query.filters.minAmount);
    }
    if (query.filters.maxAmount !== undefined) {
      filters.maxAmount = Math.max(0, query.filters.maxAmount);
    }

    query = {
      filters,
      ...(query.groupBy ? { groupBy: query.groupBy } : {}),
      aggregate: query.aggregate ?? "SUM",
    };
  }

  let intent = input.turn.intent;
  if (
    (intent === "CREATE" && proposals.length === 0) ||
    ((intent === "UPDATE" || intent === "DELETE") && operations.length === 0) ||
    (intent === "QUERY" && !query)
  ) {
    intent = "CLARIFY";
  }

  const reply =
    input.turn.reply?.trim() ||
    (intent === "CLARIFY"
      ? clarifications[0] ?? "Could you tell me a little more?"
      : intent === "CREATE"
        ? "Here is what I understood. Please check and save."
        : intent === "UPDATE" || intent === "DELETE"
          ? "Please confirm this change."
          : intent === "QUERY"
            ? "Here is what I found."
            : "I could not help with that.");

  return {
    intent,
    reply,
    proposals,
    operations,
    query,
    queryResult: null,
    clarifications: clarifications.slice(0, 5),
  };
}
