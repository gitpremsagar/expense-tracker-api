import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { NotFoundError } from "../../utils/errors.js";

export type StoredMessage = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  payload: unknown;
  createdAt: Date;
};

export type ConversationSummary = {
  id: string;
  title: string;
  lastMessageAt: Date;
  preview: string | null;
};

const HISTORY_LIMIT = 10;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export async function getOrCreateConversation(
  userId: string,
  conversationId: string | undefined,
  firstMessage: string,
) {
  if (conversationId) {
    const conversation = await prisma.assistantConversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation) {
      throw new NotFoundError("Conversation not found");
    }

    if (conversation.userId !== userId) {
      throw new NotFoundError("Conversation not found");
    }

    return conversation;
  }

  const title = firstMessage.trim().slice(0, 60) || "New chat";

  return prisma.assistantConversation.create({
    data: { userId, title },
  });
}

/** Last N messages, oldest first, with a compact action summary for assistant turns. */
export async function getConversationHistory(
  userId: string,
  conversationId: string,
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const messages = await prisma.assistantMessage.findMany({
    where: { conversationId, userId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });

  return messages
    .reverse()
    .map((message) => {
      if (message.role === "USER") {
        return { role: "user" as const, content: message.content };
      }

      const payload = message.payload as Record<string, unknown> | null;
      const context = payload
        ? JSON.stringify({
            proposals: payload.proposals ?? [],
            operations: payload.operations ?? [],
            debtPayments: payload.debtPayments ?? [],
            queryResult: payload.queryResult ?? null,
          })
        : "";

      const content = context
        ? `${message.content}\nContext: ${context}`
        : message.content;

      return {
        role: "assistant" as const,
        content: content.slice(0, 2000),
      };
    });
}

export async function appendMessage(input: {
  conversationId: string;
  userId: string;
  role: "USER" | "ASSISTANT";
  content: string;
  payload?: unknown;
}): Promise<{ id: string }> {
  const message = await prisma.assistantMessage.create({
    data: {
      conversationId: input.conversationId,
      userId: input.userId,
      role: input.role,
      content: input.content,
      ...(input.payload !== undefined
        ? { payload: input.payload as Prisma.InputJsonValue }
        : {}),
    },
    select: { id: true },
  });

  await prisma.assistantConversation.update({
    where: { id: input.conversationId },
    data: { lastMessageAt: new Date() },
  });

  return message;
}

export async function listConversations(
  userId: string,
  limit: number,
): Promise<ConversationSummary[]> {
  const conversations = await prisma.assistantConversation.findMany({
    where: { userId },
    orderBy: { lastMessageAt: "desc" },
    take: limit,
    include: {
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { content: true, role: true },
      },
    },
  });

  return conversations.map(({ messages, ...conversation }) => ({
    id: conversation.id,
    title: conversation.title,
    lastMessageAt: conversation.lastMessageAt,
    preview: messages[0]?.content.slice(0, 120) ?? null,
  }));
}

export async function getConversation(userId: string, conversationId: string) {
  const conversation = await prisma.assistantConversation.findUnique({
    where: { id: conversationId },
  });

  if (!conversation || conversation.userId !== userId) {
    throw new NotFoundError("Conversation not found");
  }

  const messages = await prisma.assistantMessage.findMany({
    where: { conversationId, userId },
    orderBy: { createdAt: "asc" },
    take: 100,
  });

  return {
    conversation: {
      id: conversation.id,
      title: conversation.title,
      lastMessageAt: conversation.lastMessageAt,
    },
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      payload: message.payload,
      createdAt: message.createdAt,
    })),
  };
}

export async function deleteConversation(userId: string, conversationId: string) {
  const conversation = await prisma.assistantConversation.findUnique({
    where: { id: conversationId },
  });

  if (!conversation || conversation.userId !== userId) {
    throw new NotFoundError("Conversation not found");
  }

  await prisma.assistantMessage.deleteMany({ where: { conversationId, userId } });
  await prisma.assistantConversation.delete({ where: { id: conversationId } });
}

export async function getPreferences(userId: string) {
  const existing = await prisma.assistantPreference.findUnique({ where: { userId } });
  if (existing) {
    return { autoSave: existing.autoSave };
  }

  const created = await prisma.assistantPreference.create({
    data: { userId },
    select: { autoSave: true },
  });

  return created;
}

export async function updatePreferences(userId: string, autoSave: boolean) {
  await prisma.assistantPreference.upsert({
    where: { userId },
    create: { userId, autoSave },
    update: { autoSave },
  });

  return { autoSave };
}

export async function logUsage(input: {
  userId: string;
  conversationId?: string | null;
  model: string;
  intent?: string;
  proposalCount: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs: number;
}) {
  await prisma.assistantUsageLog.create({
    data: {
      userId: input.userId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      model: input.model,
      ...(input.intent ? { intent: input.intent } : {}),
      proposalCount: input.proposalCount,
      ...(input.promptTokens !== undefined ? { promptTokens: input.promptTokens } : {}),
      ...(input.completionTokens !== undefined
        ? { completionTokens: input.completionTokens }
        : {}),
      ...(input.totalTokens !== undefined ? { totalTokens: input.totalTokens } : {}),
      latencyMs: input.latencyMs,
    },
  });
}

export async function getUsageStats(userId: string) {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);

  const [recent, monthAggregate] = await Promise.all([
    prisma.assistantUsageLog.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        model: true,
        intent: true,
        proposalCount: true,
        totalTokens: true,
        latencyMs: true,
        createdAt: true,
      },
    }),
    prisma.assistantUsageLog.aggregate({
      where: { userId, createdAt: { gte: start } },
      _count: { _all: true },
      _sum: { totalTokens: true },
      _avg: { latencyMs: true },
    }),
  ]);

  return {
    month: {
      messages: monthAggregate._count._all,
      totalTokens: monthAggregate._sum.totalTokens ?? 0,
      averageLatencyMs: Math.round(monthAggregate._avg.latencyMs ?? 0),
    },
    recent,
  };
}

// ─── Durable idempotency ──────────────────────────────────────────────────────

export async function readIdempotentResult(
  userId: string,
  requestId: string | undefined,
  kind: string,
): Promise<unknown | null> {
  if (!requestId) return null;

  const record = await prisma.assistantRequest.findUnique({
    where: { userId_requestId: { userId, requestId } },
  });

  if (!record || record.kind !== kind || record.expiresAt.getTime() < Date.now()) {
    return null;
  }

  return record.result;
}

export async function storeIdempotentResult(
  userId: string,
  requestId: string | undefined,
  kind: string,
  result: unknown,
): Promise<void> {
  if (!requestId) return;

  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS);

  try {
    await prisma.assistantRequest.create({
      data: {
        userId,
        requestId,
        kind,
        result: result as Prisma.InputJsonValue,
        expiresAt,
      },
    });
  } catch {
    // A concurrent request already stored this id; keep the first result.
  }

  // Opportunistic cleanup of expired records for this user.
  void prisma.assistantRequest
    .deleteMany({ where: { userId, expiresAt: { lt: new Date() } } })
    .catch(() => undefined);
}
