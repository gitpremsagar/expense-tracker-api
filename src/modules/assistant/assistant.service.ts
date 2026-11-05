import type { CategoryType, DebtType, Transaction } from "@prisma/client";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { createChatCompletion, extractJsonObject, isAiConfigured } from "../../lib/openrouter.js";
import { AppError, BadRequestError, ForbiddenError, NotFoundError } from "../../utils/errors.js";
import { buildMessages, type DebtContext, type TransactionContext } from "./assistant.prompt.js";
import { buildQuerySpec, executeQuery, type AssistantQueryResult } from "./assistant.query.js";
import { isSaneTransactionDate, parseModelDate } from "./assistant.time.js";
import {
  applyActionsSchema,
  assistantPreferencesSchema,
  confirmProposalsSchema,
  listConversationsSchema,
  modelResponseSchema,
  parseMessageSchema,
  undoActionsSchema,
  type AssistantIntent,
  type ModelDebtPayment,
  type ModelOperation,
  type ModelQuery,
  type ModelResponse,
  type ModelTransaction,
  type ParseMessageInput,
} from "./assistant.validation.js";
import {
  appendMessage,
  deleteConversation,
  getConversation,
  getConversationHistory,
  getOrCreateConversation,
  getPreferences,
  getUsageStats,
  listConversations,
  logUsage,
  readIdempotentResult,
  storeIdempotentResult,
  updatePreferences,
} from "./assistant.store.js";

export type { AssistantIntent };

export type AssistantProposal = {
  amount: number;
  type: CategoryType;
  categoryId: string | null;
  categoryName: string | null;
  suggestedCategoryName: string | null;
  date: string;
  note: string | null;
  confidence: number;
};

export type AssistantTransactionSnapshot = {
  id: string;
  amount: number;
  type: CategoryType;
  categoryId: string;
  categoryName: string;
  date: string;
  note: string | null;
};

export type AssistantOperation = {
  action: "UPDATE" | "DELETE";
  transactionId: string;
  before: AssistantTransactionSnapshot;
  after: AssistantTransactionSnapshot | null;
  confidence: number;
};

export type AssistantDebtPayment = {
  debtId: string;
  partyName: string;
  debtType: DebtType;
  amount: number;
  date: string;
  note: string | null;
  outstandingBefore: number;
  outstandingAfter: number;
  confidence: number;
};

export type AssistantParseResult = {
  conversationId: string | null;
  messageId: string | null;
  intent: AssistantIntent;
  reply: string;
  proposals: AssistantProposal[];
  operations: AssistantOperation[];
  debtPayments: AssistantDebtPayment[];
  queryResult: AssistantQueryResult | null;
  clarifications: string[];
  categoriesEmpty: boolean;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    model?: string;
  };
};

type ConfirmResult = { transactions: Transaction[] };

const VALID_TYPES = new Set<CategoryType>(["INCOME", "EXPENSE", "SAVING", "INVESTMENT"]);
const MAX_TRANSACTIONS = 10;
const MAX_OPERATIONS = 10;
const EPSILON = 0.005;

// ─── Per-user rate limiting ───────────────────────────────────────────────────

const requestWindows = new Map<string, number[]>();

function checkRateLimit(userId: string): void {
  const now = Date.now();
  const windowStart = now - 60_000;
  const recent = (requestWindows.get(userId) ?? []).filter((timestamp) => timestamp > windowStart);

  if (recent.length >= env.ASSISTANT_RATE_LIMIT_PER_MIN) {
    throw new AppError(429, "You are sending messages too quickly. Please wait a moment and try again.");
  }

  recent.push(now);
  requestWindows.set(userId, recent);

  if (requestWindows.size > 1000) {
    for (const [key, timestamps] of requestWindows) {
      if (timestamps.every((timestamp) => timestamp <= windowStart)) {
        requestWindows.delete(key);
      }
    }
  }
}

// ─── Context loading ──────────────────────────────────────────────────────────

type CategoryRow = { id: string; name: string; type: CategoryType };

async function loadCategories(userId: string): Promise<CategoryRow[]> {
  return prisma.category.findMany({
    where: { userId },
    select: { id: true, name: true, type: true },
    orderBy: [{ type: "asc" }, { name: "asc" }],
    take: 300,
  });
}

async function loadRecentTransactions(userId: string): Promise<TransactionContext[]> {
  const rows = await prisma.transaction.findMany({
    where: { userId },
    orderBy: { date: "desc" },
    take: 20,
    include: { category: { select: { name: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    amount: row.amount,
    type: row.type,
    date: row.date,
    note: row.note,
    categoryName: row.category.name,
  }));
}

type DebtRow = DebtContext & { paidAmount: number };

async function loadActiveDebts(userId: string): Promise<DebtRow[]> {
  const debts = await prisma.debt.findMany({
    where: { userId, status: "ACTIVE" },
    orderBy: { date: "desc" },
    take: 50,
    include: { payments: { select: { amount: true } } },
  });

  return debts.map((debt) => {
    const paidAmount = debt.payments.reduce((sum, payment) => sum + payment.amount, 0);
    return {
      id: debt.id,
      type: debt.type,
      partyName: debt.partyName,
      amount: debt.amount,
      outstanding: Math.max(0, Math.round((debt.amount - paidAmount) * 100) / 100),
      status: debt.status,
      paidAmount,
    };
  });
}

// ─── Model output normalization ────────────────────────────────────────────────

function normalizeType(raw: string | undefined, categoryType: CategoryType | undefined): CategoryType {
  if (categoryType) return categoryType;
  const upper = raw?.trim().toUpperCase();
  if (upper && VALID_TYPES.has(upper as CategoryType)) return upper as CategoryType;
  return "EXPENSE";
}

function normalizeConfidence(raw: number | null | undefined): number {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return 0.7;
  const value = raw > 1 && raw <= 100 ? raw / 100 : raw;
  return Math.min(1, Math.max(0, value));
}

function parseModelContent(content: string): ModelResponse | null {
  let json: unknown;

  try {
    json = extractJsonObject(content);
  } catch {
    return null;
  }

  const parsed = modelResponseSchema.safeParse(json);
  if (!parsed.success) {
    console.warn("Assistant model output failed validation", parsed.error.issues);
    return null;
  }
  return parsed.data;
}

function toProposals(
  modelTransactions: ModelTransaction[],
  timezone: string,
  now: Date,
  categoriesById: Map<string, CategoryRow>,
): { proposals: AssistantProposal[]; notes: string[] } {
  const proposals: AssistantProposal[] = [];
  const notes: string[] = [];

  for (const item of modelTransactions.slice(0, MAX_TRANSACTIONS)) {
    const category = item.categoryId ? categoriesById.get(item.categoryId) : undefined;
    const suggested = item.suggestedCategoryName?.trim() || null;

    if (item.categoryId && !category) {
      notes.push("I could not match one of the categories, so please pick one before saving.");
    }

    const parsedDate = parseModelDate(item.date ?? undefined, timezone);
    const date = parsedDate && isSaneTransactionDate(parsedDate, now) ? parsedDate : now;

    proposals.push({
      amount: Math.round(item.amount * 100) / 100,
      type: normalizeType(item.type, category?.type),
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? null,
      suggestedCategoryName: category ? null : suggested,
      date: date.toISOString(),
      note: item.note?.trim() || null,
      confidence: normalizeConfidence(item.confidence),
    });
  }

  return { proposals, notes };
}

function snapshot(transaction: TransactionContext): AssistantTransactionSnapshot {
  return {
    id: transaction.id,
    amount: transaction.amount,
    type: transaction.type,
    categoryId: "",
    categoryName: transaction.categoryName,
    date: transaction.date.toISOString(),
    note: transaction.note,
  };
}

function toOperations(
  modelOperations: ModelOperation[],
  recentTransactions: TransactionContext[],
  categoriesById: Map<string, CategoryRow>,
  timezone: string,
  now: Date,
): { operations: AssistantOperation[]; notes: string[] } {
  const byId = new Map(recentTransactions.map((transaction) => [transaction.id, transaction]));
  const operations: AssistantOperation[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const item of modelOperations.slice(0, MAX_OPERATIONS)) {
    const target = byId.get(item.transactionId);

    if (!target) {
      notes.push("I could not match one of the transactions to change, so please pick it from the list.");
      continue;
    }

    if (seen.has(target.id)) continue;
    seen.add(target.id);

    const action = item.action?.trim().toUpperCase() === "DELETE" ? "DELETE" : "UPDATE";
    const before = snapshot(target);

    if (action === "DELETE") {
      operations.push({
        action: "DELETE",
        transactionId: target.id,
        before,
        after: null,
        confidence: normalizeConfidence(item.confidence),
      });
      continue;
    }

    let category: CategoryRow | undefined;
    if (item.categoryId) {
      category = categoriesById.get(item.categoryId);
      if (!category) {
        notes.push("I could not match the new category, so please pick one before applying the change.");
      }
    }

    const parsedDate = parseModelDate(item.date ?? undefined, timezone);
    const date =
      parsedDate && isSaneTransactionDate(parsedDate, now) ? parsedDate : target.date;

    const after: AssistantTransactionSnapshot = {
      ...before,
      amount:
        item.amount !== null && item.amount !== undefined
          ? Math.round(item.amount * 100) / 100
          : before.amount,
      type: category?.type ?? before.type,
      categoryId: category?.id ?? before.categoryId,
      categoryName: category?.name ?? before.categoryName,
      date: date.toISOString(),
      note: item.note !== null && item.note !== undefined ? item.note.trim() || null : before.note,
    };

    const changed =
      after.amount !== before.amount ||
      after.type !== before.type ||
      after.categoryId !== before.categoryId ||
      after.date !== before.date ||
      after.note !== before.note;

    if (!changed) {
      notes.push("I could not tell what to change on one of the transactions.");
      continue;
    }

    operations.push({
      action: "UPDATE",
      transactionId: target.id,
      before,
      after,
      confidence: normalizeConfidence(item.confidence),
    });
  }

  return { operations, notes };
}

function matchDebt(
  payment: ModelDebtPayment,
  debts: DebtRow[],
): { debt?: DebtRow | undefined; clarification?: string } {
  if (payment.debtId) {
    const byId = debts.find((debt) => debt.id === payment.debtId);
    if (byId) return { debt: byId };
  }

  const party = payment.partyName?.trim().toLowerCase();
  if (!party) {
    return { clarification: "Which debt is this payment for? Tell me the person's name." };
  }

  const exact = debts.filter((debt) => debt.partyName.trim().toLowerCase() === party);
  if (exact.length === 1) return { debt: exact[0] };

  const partial = debts.filter((debt) => {
    const name = debt.partyName.trim().toLowerCase();
    return name.includes(party) || party.includes(name);
  });

  if (partial.length === 1) return { debt: partial[0] };

  if (partial.length > 1 || exact.length > 1) {
    const names = [...new Set((exact.length > 1 ? exact : partial).map((debt) => debt.partyName))];
    return { clarification: `Which debt do you mean: ${names.join(", ")}?` };
  }

  return {
    clarification:
      debts.length > 0
        ? `I could not find an active debt for ${payment.partyName}. Your active debts are with ${debts
            .map((debt) => debt.partyName)
            .slice(0, 6)
            .join(", ")}.`
        : "You have no active debts to pay off.",
  };
}

function toDebtPayment(
  payment: ModelDebtPayment | null | undefined,
  debts: DebtRow[],
  timezone: string,
  now: Date,
): { debtPayment?: AssistantDebtPayment; clarifications: string[] } {
  if (!payment) return { clarifications: [] };

  const match = matchDebt(payment, debts);
  if (!match.debt) {
    return { clarifications: [match.clarification ?? "I could not match that debt payment."] };
  }

  const amount = Math.round(payment.amount * 100) / 100;

  if (amount > match.debt.outstanding + EPSILON) {
    return {
      clarifications: [
        `That payment is more than the ${match.debt.partyName} outstanding of ₹${match.debt.outstanding.toLocaleString("en-IN")}.`,
      ],
    };
  }

  const parsedDate = parseModelDate(payment.date ?? undefined, timezone);
  const date = parsedDate && isSaneTransactionDate(parsedDate, now) ? parsedDate : now;

  return {
    debtPayment: {
      debtId: match.debt.id,
      partyName: match.debt.partyName,
      debtType: match.debt.type,
      amount,
      date: date.toISOString(),
      note: payment.note?.trim() || null,
      outstandingBefore: match.debt.outstanding,
      outstandingAfter: Math.round((match.debt.outstanding - amount) * 100) / 100,
      confidence: normalizeConfidence(payment.confidence),
    },
    clarifications: [],
  };
}

function resolveIntent(input: {
  rawIntent: string | undefined;
  hasProposals: boolean;
  operations: AssistantOperation[];
  hasDebtPayment: boolean;
  hasQuery: boolean;
}): AssistantIntent {
  if (input.hasProposals) return "ADD_TRANSACTIONS";
  if (input.operations.length > 0) {
    return input.operations.every((operation) => operation.action === "DELETE")
      ? "DELETE_TRANSACTIONS"
      : "EDIT_TRANSACTIONS";
  }
  if (input.hasDebtPayment) return "DEBT_PAYMENT";
  if (input.hasQuery) return "QUERY";

  const upper = input.rawIntent?.trim().toUpperCase();
  if (upper === "UNSUPPORTED") return "UNSUPPORTED";
  return "CLARIFY";
}

function fallbackReply(intent: AssistantIntent, result: { proposals: number; operations: number }): string {
  if (intent === "ADD_TRANSACTIONS" && result.proposals > 0) {
    return result.proposals === 1
      ? "I found 1 transaction. Please review it before saving."
      : `I found ${result.proposals} transactions. Please review them before saving.`;
  }
  if (intent === "EDIT_TRANSACTIONS") {
    return `I prepared ${result.operations} change${result.operations === 1 ? "" : "s"}. Please review before applying.`;
  }
  if (intent === "DELETE_TRANSACTIONS") {
    return `I prepared ${result.operations} deletion${result.operations === 1 ? "" : "s"}. Please review before applying.`;
  }
  if (intent === "DEBT_PAYMENT") {
    return "I found the debt payment. Please review it before recording.";
  }
  if (intent === "UNSUPPORTED") {
    return "I can help record money movements, answer questions about your money, edit recent transactions, and record debt payments.";
  }
  return "I could not find a transaction to add. Tell me the amount and what it was for.";
}

// ─── Parse ────────────────────────────────────────────────────────────────────

export async function parseMessage(
  userId: string,
  input: ParseMessageInput,
): Promise<AssistantParseResult> {
  if (!isAiConfigured()) {
    throw new AppError(
      503,
      "The AI assistant is not configured yet. Add OPENROUTER_API_KEY to the API environment.",
    );
  }

  checkRateLimit(userId);

  const [categories, recentTransactions, debts] = await Promise.all([
    loadCategories(userId),
    loadRecentTransactions(userId),
    loadActiveDebts(userId),
  ]);

  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const now = input.now ? new Date(input.now) : new Date();
  const safeNow = Number.isNaN(now.getTime()) ? new Date() : now;

  // When continuing a stored conversation, prefer the server-side history so the
  // client cannot lose or duplicate context.
  let history = input.history;
  if (input.conversationId) {
    const conversation = await getOrCreateConversation(userId, input.conversationId, input.message);
    void conversation;
    history = await getConversationHistory(userId, input.conversationId);
  }

  const messages = buildMessages(
    { ...input, history },
    categories,
    recentTransactions,
    debts,
    safeNow,
  );

  const started = Date.now();
  let completion = await createChatCompletion(messages);
  let model = parseModelContent(completion.content);

  if (!model) {
    const repairMessages = [
      ...messages,
      { role: "assistant" as const, content: completion.content.slice(0, 4000) },
      {
        role: "user" as const,
        content:
          "Your previous response was not valid JSON matching the required shape. Reply again with ONLY the JSON object. Do not add markdown or commentary.",
      },
    ];

    completion = await createChatCompletion(repairMessages);
    model = parseModelContent(completion.content);
  }

  if (!model) {
    throw new AppError(502, "The AI assistant could not understand that response. Please rephrase and try again.");
  }

  const latencyMs = Date.now() - started;

  const { proposals, notes: proposalNotes } = toProposals(
    model.transactions ?? [],
    input.timezone,
    safeNow,
    categoriesById,
  );

  const { operations, notes: operationNotes } = toOperations(
    model.operations ?? [],
    recentTransactions,
    categoriesById,
    input.timezone,
    safeNow,
  );

  const { debtPayment, clarifications: debtNotes } = toDebtPayment(
    model.debtPayment,
    debts,
    input.timezone,
    safeNow,
  );

  // Queries only run when the model did not propose any writes.
  let queryResult: AssistantQueryResult | null = null;
  const wantsQuery =
    Boolean(model.query) &&
    proposals.length === 0 &&
    operations.length === 0 &&
    !debtPayment;

  if (wantsQuery) {
    const spec = buildQuerySpec(model.query, categories, input.timezone, safeNow);
    queryResult = await executeQuery(userId, spec, input.timezone);
  }

  const intent = resolveIntent({
    rawIntent: model.intent,
    hasProposals: proposals.length > 0,
    operations,
    hasDebtPayment: Boolean(debtPayment),
    hasQuery: Boolean(queryResult),
  });

  const clarifications = [
    ...(model.clarifications ?? []),
    ...proposalNotes,
    ...operationNotes,
    ...debtNotes,
  ].slice(0, 6);

  const reply =
    queryResult?.answer ??
    model.reply?.trim() ??
    fallbackReply(intent, { proposals: proposals.length, operations: operations.length });

  const payload = {
    intent,
    proposals,
    operations,
    debtPayments: debtPayment ? [debtPayment] : [],
    queryResult,
    clarifications,
    categoriesEmpty: categories.length === 0,
  };

  let conversationId = input.conversationId ?? null;
  let messageId: string | null = null;

  try {
    if (!conversationId) {
      const conversation = await getOrCreateConversation(userId, undefined, input.message);
      conversationId = conversation.id;
    }

    await appendMessage({
      conversationId,
      userId,
      role: "USER",
      content: input.message,
    });

    const assistantMessage = await appendMessage({
      conversationId,
      userId,
      role: "ASSISTANT",
      content: reply,
      payload,
    });
    messageId = assistantMessage.id;
  } catch (error) {
    // Persistence is best-effort; the assistant still works without it.
    console.warn("Could not persist assistant conversation", error);
    conversationId = input.conversationId ?? null;
  }

  void logUsage({
    userId,
    conversationId,
    model: completion.model,
    intent,
    proposalCount: proposals.length + operations.length + (debtPayment ? 1 : 0),
    latencyMs,
    ...(completion.usage?.promptTokens !== undefined
      ? { promptTokens: completion.usage.promptTokens }
      : {}),
    ...(completion.usage?.completionTokens !== undefined
      ? { completionTokens: completion.usage.completionTokens }
      : {}),
    ...(completion.usage?.totalTokens !== undefined
      ? { totalTokens: completion.usage.totalTokens }
      : {}),
  }).catch(() => undefined);

  return {
    conversationId,
    messageId,
    intent,
    reply,
    proposals,
    operations,
    debtPayments: debtPayment ? [debtPayment] : [],
    queryResult,
    clarifications,
    categoriesEmpty: categories.length === 0,
    usage: {
      ...(completion.usage?.promptTokens !== undefined
        ? { promptTokens: completion.usage.promptTokens }
        : {}),
      ...(completion.usage?.completionTokens !== undefined
        ? { completionTokens: completion.usage.completionTokens }
        : {}),
      ...(completion.usage?.totalTokens !== undefined
        ? { totalTokens: completion.usage.totalTokens }
        : {}),
      model: completion.model,
    },
  };
}

// ─── Category helpers (shared by confirm/apply) ───────────────────────────────

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function resolveCategory(
  tx: TxClient,
  userId: string,
  input: {
    categoryId?: string | null | undefined;
    newCategory?: { name: string; type: CategoryType } | null | undefined;
  },
): Promise<CategoryRow> {
  if (input.categoryId) {
    const existing = await tx.category.findUnique({ where: { id: input.categoryId } });

    if (!existing) throw new NotFoundError("One of the selected categories no longer exists.");
    if (existing.userId !== userId) throw new ForbiddenError("You do not own one of the selected categories.");

    return { id: existing.id, name: existing.name, type: existing.type };
  }

  if (input.newCategory) {
    const { name, type } = input.newCategory;
    const existing = await tx.category.findUnique({
      where: { userId_name_type: { userId, name, type } },
    });

    if (existing) return { id: existing.id, name: existing.name, type: existing.type };

    return tx.category.create({
      data: { name, type, userId },
      select: { id: true, name: true, type: true },
    });
  }

  throw new BadRequestError("Each transaction needs a category.");
}

// ─── Confirm (creates) ───────────────────────────────────────────────────────

export async function confirmProposals(
  userId: string,
  rawInput: unknown,
): Promise<ConfirmResult> {
  const input = confirmProposalsSchema.parse(rawInput);

  const cached = await readIdempotentResult(userId, input.requestId, "CONFIRM");
  if (cached) return cached as ConfirmResult;

  const now = new Date();

  const transactions = await prisma.$transaction(async (tx) => {
    const created: Transaction[] = [];

    for (const proposal of input.proposals) {
      const category = await resolveCategory(tx, userId, {
        categoryId: proposal.categoryId,
        newCategory: proposal.newCategory,
      });

      const date = proposal.date ? new Date(proposal.date) : now;
      if (Number.isNaN(date.getTime())) {
        throw new BadRequestError("One of the transaction dates is invalid.");
      }

      const transaction = await tx.transaction.create({
        data: {
          amount: proposal.amount,
          note: proposal.note ?? null,
          type: category.type,
          date,
          categoryId: category.id,
          userId,
        },
        include: { category: { select: { id: true, name: true, type: true } } },
      });

      created.push(transaction);
    }

    return created;
  });

  const result = JSON.parse(JSON.stringify({ transactions })) as ConfirmResult;
  await storeIdempotentResult(userId, input.requestId, "CONFIRM", result);

  if (input.conversationId) {
    await appendMessage({
      conversationId: input.conversationId,
      userId,
      role: "ASSISTANT",
      content: `Saved ${transactions.length} transaction${transactions.length === 1 ? "" : "s"}.`,
      payload: {
        saved: true,
        transactionIds: transactions.map((transaction) => transaction.id),
      },
    }).catch(() => undefined);
  }

  return result;
}

// ─── Apply (edits, deletes, debt payments) ───────────────────────────────────

export type ApplyResult = {
  transactions: Transaction[];
  deletedTransactionIds: string[];
  debts: unknown[];
};

export async function applyActions(userId: string, rawInput: unknown): Promise<ApplyResult> {
  const input = applyActionsSchema.parse(rawInput);

  const cached = await readIdempotentResult(userId, input.requestId, "APPLY");
  if (cached) return cached as ApplyResult;

  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const updated: Transaction[] = [];
    const deletedTransactionIds: string[] = [];

    for (const operation of input.operations) {
      const transaction = await tx.transaction.findUnique({
        where: { id: operation.transactionId },
      });

      if (!transaction) {
        throw new NotFoundError("One of the transactions no longer exists.");
      }
      if (transaction.userId !== userId) {
        throw new ForbiddenError("You do not own one of the transactions.");
      }

      if (operation.action === "DELETE") {
        await tx.transaction.delete({ where: { id: transaction.id } });
        deletedTransactionIds.push(transaction.id);
        continue;
      }

      const category =
        operation.categoryId !== undefined || operation.newCategory
          ? await resolveCategory(tx, userId, {
              categoryId: operation.categoryId,
              newCategory: operation.newCategory,
            })
          : null;

      const date = operation.date ? new Date(operation.date) : undefined;
      if (date && Number.isNaN(date.getTime())) {
        throw new BadRequestError("One of the transaction dates is invalid.");
      }

      const updatedTransaction = await tx.transaction.update({
        where: { id: transaction.id },
        data: {
          ...(operation.amount !== undefined ? { amount: operation.amount } : {}),
          ...(operation.note !== undefined ? { note: operation.note || null } : {}),
          ...(date ? { date } : {}),
          ...(category ? { categoryId: category.id, type: category.type } : {}),
        },
        include: { category: { select: { id: true, name: true, type: true } } },
      });

      updated.push(updatedTransaction);
    }

    for (const payment of input.debtPayments) {
      const debt = await tx.debt.findUnique({ where: { id: payment.debtId } });

      if (!debt) throw new NotFoundError("One of the debts no longer exists.");
      if (debt.userId !== userId) throw new ForbiddenError("You do not own one of the debts.");
      if (debt.status !== "ACTIVE") throw new BadRequestError("That debt is already settled.");

      const paid = await tx.debtPayment.aggregate({
        where: { debtId: debt.id },
        _sum: { amount: true },
      });
      const outstanding = Math.max(0, debt.amount - (paid._sum.amount ?? 0));

      if (payment.amount > outstanding + EPSILON) {
        throw new BadRequestError("Payment exceeds the outstanding amount.");
      }

      const date = payment.date ? new Date(payment.date) : now;
      if (Number.isNaN(date.getTime())) {
        throw new BadRequestError("One of the payment dates is invalid.");
      }

      await tx.debtPayment.create({
        data: {
          amount: payment.amount,
          date,
          note: payment.note || null,
          debtId: debt.id,
          userId,
        },
      });

      const newPaid = (paid._sum.amount ?? 0) + payment.amount;
      await tx.debt.update({
        where: { id: debt.id },
        data: { status: newPaid + EPSILON >= debt.amount ? "SETTLED" : "ACTIVE" },
      });
    }

    return { updated, deletedTransactionIds };
  });

  const debts =
    input.debtPayments.length > 0
      ? await prisma.debt.findMany({
          where: {
            id: { in: input.debtPayments.map((payment) => payment.debtId) },
            userId,
          },
          include: { payments: { orderBy: { date: "desc" } } },
        })
      : [];

  const serializable = JSON.parse(
    JSON.stringify({
      transactions: result.updated,
      deletedTransactionIds: result.deletedTransactionIds,
      debts,
    }),
  ) as ApplyResult;

  await storeIdempotentResult(userId, input.requestId, "APPLY", serializable);

  if (input.conversationId) {
    const changed = result.updated.length + result.deletedTransactionIds.length + input.debtPayments.length;
    await appendMessage({
      conversationId: input.conversationId,
      userId,
      role: "ASSISTANT",
      content: `Applied ${changed} change${changed === 1 ? "" : "s"}.`,
      payload: {
        applied: true,
        updatedTransactionIds: result.updated.map((transaction) => transaction.id),
        deletedTransactionIds: result.deletedTransactionIds,
        debtIds: input.debtPayments.map((payment) => payment.debtId),
      },
    }).catch(() => undefined);
  }

  return serializable;
}

// ─── Undo ─────────────────────────────────────────────────────────────────────

export async function undoTransactions(userId: string, rawInput: unknown) {
  const input = undoActionsSchema.parse(rawInput);

  const cached = await readIdempotentResult(userId, input.requestId, "UNDO");
  if (cached) return cached as { deleted: number };

  const result = await prisma.transaction.deleteMany({
    where: { id: { in: input.transactionIds }, userId },
  });

  const response = { deleted: result.count };
  await storeIdempotentResult(userId, input.requestId, "UNDO", response);
  return response;
}

// ─── Preferences, conversations, usage ───────────────────────────────────────

export async function readPreferences(userId: string) {
  return getPreferences(userId);
}

export async function writePreferences(userId: string, rawInput: unknown) {
  const input = assistantPreferencesSchema.parse(rawInput);
  return updatePreferences(userId, input.autoSave);
}

export async function readConversations(userId: string, rawQuery: unknown) {
  const query = listConversationsSchema.parse(rawQuery);
  return listConversations(userId, query.limit);
}

export async function readConversation(userId: string, conversationId: string) {
  return getConversation(userId, conversationId);
}

export async function removeConversation(userId: string, conversationId: string) {
  await deleteConversation(userId, conversationId);
}

export async function readUsage(userId: string) {
  return getUsageStats(userId);
}

export { parseMessageSchema };
