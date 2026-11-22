import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { ForbiddenError, NotFoundError } from "../../utils/errors.js";
import type { AssistantTurn } from "./assistant.normalize.js";

export type MessageInput = {
  role: "user" | "assistant";
  kind: "TEXT" | "IMAGE" | "AUDIO" | "STATEMENT" | "SYSTEM";
  text?: string | null;
  transcript?: string | null;
  reasoning?: string | null;
  attachment?: Prisma.InputJsonValue;
  turn?: AssistantTurn | Prisma.InputJsonValue;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
};

function titleFrom(text?: string): string {
  const cleaned = text?.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New conversation";
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
}

export async function createThread(userId: string, title?: string) {
  return prisma.assistantThread.create({
    data: {
      userId,
      title: title ?? "New conversation",
    },
  });
}

export async function ensureThread(userId: string, threadId?: string, firstText?: string) {
  if (!threadId) {
    return createThread(userId, titleFrom(firstText));
  }

  const thread = await prisma.assistantThread.findUnique({ where: { id: threadId } });
  if (!thread) throw new NotFoundError("Conversation not found");
  if (thread.userId !== userId) throw new ForbiddenError("You do not own this conversation");

  return thread;
}

export async function appendMessage(userId: string, threadId: string, input: MessageInput) {
  const last = await prisma.assistantMessage.findFirst({
    where: { threadId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });

  const seq = (last?.seq ?? 0) + 1;

  const message = await prisma.assistantMessage.create({
    data: {
      threadId,
      userId,
      seq,
      role: input.role,
      kind: input.kind,
      text: input.text ?? null,
      transcript: input.transcript ?? null,
      reasoning: input.reasoning ?? null,
      ...(input.attachment !== undefined ? { attachment: input.attachment } : {}),
      ...(input.turn !== undefined ? { turn: input.turn as Prisma.InputJsonValue } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.promptTokens !== undefined ? { promptTokens: input.promptTokens } : {}),
      ...(input.completionTokens !== undefined ? { completionTokens: input.completionTokens } : {}),
    },
  });

  await prisma.assistantThread.update({
    where: { id: threadId },
    data: { updatedAt: new Date() },
  });

  return message;
}

export async function listThreads(userId: string, limit: number) {
  const threads = await prisma.assistantThread.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: limit,
    include: {
      messages: {
        orderBy: { seq: "desc" },
        take: 1,
        select: { text: true, kind: true, createdAt: true },
      },
      _count: { select: { messages: true, imports: true } },
    },
  });

  return threads.map((thread) => ({
    id: thread.id,
    title: thread.title,
    messageCount: thread._count.messages,
    importCount: thread._count.imports,
    preview: thread.messages[0]?.text ?? null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  }));
}

export async function getThread(userId: string, threadId: string) {
  const thread = await prisma.assistantThread.findUnique({
    where: { id: threadId },
    include: {
      messages: { orderBy: { seq: "asc" }, take: 200 },
      imports: {
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          filename: true,
          status: true,
          rowCount: true,
          duplicateCount: true,
          createdAt: true,
        },
      },
    },
  });

  if (!thread) throw new NotFoundError("Conversation not found");
  if (thread.userId !== userId) throw new ForbiddenError("You do not own this conversation");

  return thread;
}

export async function deleteThread(userId: string, threadId: string) {
  const thread = await prisma.assistantThread.findUnique({ where: { id: threadId } });
  if (!thread) throw new NotFoundError("Conversation not found");
  if (thread.userId !== userId) throw new ForbiddenError("You do not own this conversation");

  const imports = await prisma.assistantImport.findMany({
    where: { threadId },
    select: { id: true },
  });

  if (imports.length > 0) {
    await prisma.assistantImportRow.deleteMany({
      where: { importId: { in: imports.map((item) => item.id) } },
    });
    await prisma.assistantImport.deleteMany({ where: { id: { in: imports.map((item) => item.id) } } });
  }

  await prisma.assistantMessage.deleteMany({ where: { threadId } });
  await prisma.assistantThread.delete({ where: { id: threadId } });
}

export async function clearAssistantData(userId: string) {
  const imports = await prisma.assistantImport.findMany({ where: { userId }, select: { id: true } });

  if (imports.length > 0) {
    await prisma.assistantImportRow.deleteMany({
      where: { importId: { in: imports.map((item) => item.id) } },
    });
    await prisma.assistantImport.deleteMany({ where: { userId } });
  }

  await prisma.assistantMessage.deleteMany({ where: { userId } });
  await prisma.assistantThread.deleteMany({ where: { userId } });
  await prisma.assistantActionBatch.deleteMany({ where: { userId } });
  await prisma.assistantPreference.deleteMany({ where: { userId } });
  await prisma.assistantUsage.deleteMany({ where: { userId } });
}
