import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/errors.js";
import {
  createChatCompletion,
  extractJsonObject,
  isAiConfigured,
  type ChatMessage,
  type ReasoningEffort,
} from "../../lib/deepseek.js";
import { loadAssistantContext, loadCategories } from "./assistant.context.js";
import { buildTurnSystemPrompt, BILL_INSTRUCTION } from "./assistant.prompt.js";
import { modelTurnSchema, type ConfirmItem } from "./assistant.schema.js";
import { todayInTimezone, resolveTimezone } from "./assistant.time.js";
import { normalizeTurn, type AssistantTurn } from "./assistant.normalize.js";
import { composeQueryReply, runQuery } from "./assistant.query.js";
import { confirmActions, type ConfirmResult } from "./assistant.actions.js";
import { assertConsent, getPreference } from "./assistant.preferences.js";
import { appendMessage, ensureThread, getThread } from "./assistant.threads.js";
import { assertQuota, recordUsage } from "./assistant.usage.js";
import { validateImage } from "./media/image.js";
import { transcribeVoiceNote } from "./media/audio.js";

export type TurnResponse = {
  threadId: string;
  messageId: string;
  turn: AssistantTurn;
  reasoning: string | null;
  autoSaved: ConfirmResult | null;
  autoSaveError: string | null;
};

const MAX_REASONING_CHARS = 12_000;

export async function getAssistantStatus(userId: string) {
  const preference = await prisma.assistantPreference.findUnique({ where: { userId } });

  return {
    enabled: env.ASSISTANT_ENABLED && isAiConfigured(),
    configured: isAiConfigured(),
    consentRequired: !preference?.consentAt,
    model: env.DEEPSEEK_MODEL,
    limits: {
      maxTextChars: env.ASSISTANT_MAX_TEXT_CHARS,
      maxCreatesPerTurn: env.ASSISTANT_MAX_CREATES_PER_TURN,
      dailyMessages: env.ASSISTANT_DAILY_MESSAGES,
      dailyImportPages: env.ASSISTANT_DAILY_IMPORT_PAGES,
      maxImportRows: env.ASSISTANT_MAX_IMPORT_ROWS,
      maxImageMb: env.ASSISTANT_MAX_IMAGE_MB,
      maxAudioMb: env.ASSISTANT_MAX_AUDIO_MB,
      maxStatementMb: env.ASSISTANT_MAX_STATEMENT_MB,
    },
  };
}

export function assertAssistantReady(): void {
  if (!env.ASSISTANT_ENABLED) {
    throw new AppError(503, "The AI assistant is currently turned off.");
  }
  if (!isAiConfigured()) {
    throw new AppError(
      503,
      "The AI assistant is not configured yet. Add DEEPSEEK_API_KEY to the API environment.",
    );
  }
}

function parseModelTurn(content: string) {
  return modelTurnSchema.parse(extractJsonObject(content));
}

async function callModel(
  messages: ChatMessage[],
  options: {
    maxTokens?: number;
    timeoutMs?: number;
    thinking?: boolean;
    reasoningEffort?: ReasoningEffort;
  } = {},
) {
  const callOptions = {
    ...options,
    ...(options.thinking ? { maxTokens: Math.max(options.maxTokens ?? 0, 4_000) } : {}),
  };

  const first = await createChatCompletion(messages, callOptions);
  let promptTokens = first.usage.promptTokens;
  let completionTokens = first.usage.completionTokens;
  let model = first.model;
  let reasoning = first.reasoning;

  try {
    return {
      turn: parseModelTurn(first.content),
      promptTokens,
      completionTokens,
      model,
      reasoning,
    };
  } catch (error) {
    const repair = await createChatCompletion(
      [
        ...messages,
        { role: "assistant", content: first.content },
        {
          role: "user",
          content: `That response did not match the required JSON schema. Return corrected JSON only. ${
            error instanceof Error ? error.message.slice(0, 300) : ""
          }`,
        },
      ],
      callOptions,
    );

    promptTokens += repair.usage.promptTokens;
    completionTokens += repair.usage.completionTokens;
    model = repair.model;
    reasoning = [first.reasoning, repair.reasoning].filter(Boolean).join("\n\n") || null;

    return {
      turn: parseModelTurn(repair.content),
      promptTokens,
      completionTokens,
      model,
      reasoning,
    };
  }
}

async function recentHistory(threadId: string, userId: string): Promise<ChatMessage[]> {
  const messages = await prisma.assistantMessage.findMany({
    where: { threadId, userId, role: { in: ["user", "assistant"] } },
    orderBy: { seq: "desc" },
    take: 6,
  });

  return messages
    .reverse()
    .flatMap<ChatMessage>((message) => {
      if (message.role === "user") {
        const text = message.text || message.transcript;
        return text ? [{ role: "user", content: text }] : [];
      }

      const turn = message.turn as AssistantTurn | null;
      return [{ role: "assistant", content: turn?.reply || message.text || "Understood." }];
    });
}

export async function parseTextTurn(input: {
  userId: string;
  threadId?: string;
  text: string;
  timezone?: string;
}): Promise<TurnResponse> {
  assertAssistantReady();
  const preference = await assertConsent(input.userId);
  const text = input.text.trim();

  if (text.length === 0) throw new AppError(400, "Type a message first.");
  if (text.length > env.ASSISTANT_MAX_TEXT_CHARS) {
    throw new AppError(400, `Keep messages under ${env.ASSISTANT_MAX_TEXT_CHARS} characters.`);
  }

  await assertQuota(input.userId, "text");

  const timeZone = resolveTimezone(input.timezone ?? preference.timezone);
  const thread = await ensureThread(input.userId, input.threadId, text);
  const { categories, candidates } = await loadAssistantContext(input.userId, timeZone);
  const history = await recentHistory(thread.id, input.userId);

  await appendMessage(input.userId, thread.id, {
    role: "user",
    kind: "TEXT",
    text,
  });

  const system: ChatMessage = {
    role: "system",
    content: buildTurnSystemPrompt({
      today: todayInTimezone(timeZone),
      timeZone,
      categories,
      candidates,
    }),
  };

  const result = await callModel(
    [system, ...history, { role: "user", content: text }],
    {
      thinking: preference.thinkingMode,
      reasoningEffort: preference.reasoningEffort,
    },
  );

  return finalizeTurn({
    userId: input.userId,
    threadId: thread.id,
    timeZone,
    source: "TEXT",
    modelTurn: result.turn,
    reasoning: result.reasoning,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    model: result.model,
    autoSave: preference.autoSaveCreates,
  });
}

export async function parseImageTurn(input: {
  userId: string;
  threadId?: string;
  buffer: Buffer;
  filename: string;
  timezone?: string;
}): Promise<TurnResponse> {
  assertAssistantReady();
  const preference = await assertConsent(input.userId);
  await assertQuota(input.userId, "image");

  const image = await validateImage(input.buffer);
  const timeZone = resolveTimezone(input.timezone ?? preference.timezone);
  const thread = await ensureThread(input.userId, input.threadId, "Bill photo");
  const { categories, candidates } = await loadAssistantContext(input.userId, timeZone);
  const history = await recentHistory(thread.id, input.userId);

  await appendMessage(input.userId, thread.id, {
    role: "user",
    kind: "IMAGE",
    text: "Bill or invoice photo",
    attachment: {
      kind: "IMAGE",
      mime: image.mimeType,
      bytes: input.buffer.length,
      filename: input.filename,
    },
  });

  const system: ChatMessage = {
    role: "system",
    content: buildTurnSystemPrompt({
      today: todayInTimezone(timeZone),
      timeZone,
      categories,
      candidates,
    }),
  };

  const result = await callModel(
    [
      system,
      ...history,
      {
        role: "user",
        content: [
          { type: "text", text: BILL_INSTRUCTION },
          { type: "image_url", image_url: { url: image.dataUrl, detail: "high" } },
        ],
      },
    ],
    {
      maxTokens: 1_800,
      thinking: preference.thinkingMode,
      reasoningEffort: preference.reasoningEffort,
    },
  );

  return finalizeTurn({
    userId: input.userId,
    threadId: thread.id,
    timeZone,
    source: "IMAGE",
    modelTurn: result.turn,
    reasoning: result.reasoning,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    model: result.model,
    autoSave: preference.autoSaveCreates,
  });
}

async function finalizeTurn(input: {
  userId: string;
  threadId: string;
  timeZone: string;
  source: "TEXT" | "IMAGE" | "AUDIO";
  modelTurn: ReturnType<typeof parseModelTurn>;
  reasoning: string | null;
  promptTokens: number;
  completionTokens: number;
  model: string;
  autoSave: boolean;
}): Promise<TurnResponse> {
  const categories = await loadCategories(input.userId);
  const turn = await normalizeTurn({
    turn: input.modelTurn,
    userId: input.userId,
    categories,
    timeZone: input.timeZone,
    source: input.source,
  });

  if (turn.intent === "QUERY" && turn.query) {
    const result = await runQuery(input.userId, turn.query, input.timeZone);
    turn.queryResult = result;
    turn.reply = composeQueryReply(result, turn.query, input.timeZone);
  }

  let autoSaved: ConfirmResult | null = null;
  let autoSaveError: string | null = null;

  if (
    input.autoSave &&
    turn.intent === "CREATE" &&
    turn.proposals.length > 0 &&
    turn.proposals.every((proposal) => proposal.categoryId)
  ) {
    const items: ConfirmItem[] = turn.proposals.map((proposal) => ({
      kind: "CREATE",
      amount: proposal.amount,
      categoryId: proposal.categoryId,
      date: proposal.date,
      note: proposal.note,
      source: input.source,
      proposalId: proposal.proposalId,
    }));

    try {
      autoSaved = await confirmActions(
        input.userId,
        { clientRequestId: randomUUID(), threadId: input.threadId, items },
        input.timeZone,
      );
      turn.savedProposalIds = turn.proposals.map((proposal) => proposal.proposalId);
      turn.savedBatchId = autoSaved.batchId;
      turn.reply = `${turn.reply} Saved ${autoSaved.created} transaction${
        autoSaved.created === 1 ? "" : "s"
      }.`;
    } catch (error) {
      autoSaveError =
        error instanceof AppError ? error.message : "Could not save those transactions automatically.";
    }
  }

  const reasoning = input.reasoning?.trim().slice(0, MAX_REASONING_CHARS) || null;

  const message = await appendMessage(input.userId, input.threadId, {
    role: "assistant",
    kind: "TEXT",
    text: turn.reply,
    reasoning,
    turn,
    model: input.model,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
  });

  await recordUsage(input.userId, {
    messages: 1,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
  });

  return {
    threadId: input.threadId,
    messageId: message.id,
    turn,
    reasoning,
    autoSaved,
    autoSaveError,
  };
}

export async function transcribeVoice(input: {
  userId: string;
  buffer: Buffer;
  filename: string;
}): Promise<{ transcript: string; durationMs: number | null }> {
  assertAssistantReady();
  await assertConsent(input.userId);
  await assertQuota(input.userId, "audio");

  const result = await transcribeVoiceNote(input.buffer, input.filename);
  const durationMs = result.durationMs ?? 30_000;

  await recordUsage(input.userId, {
    messages: 1,
    extraCostUsd: (durationMs / 3_600_000) * 0.116,
  });

  return { transcript: result.text, durationMs: result.durationMs };
}

export async function getThreadDetail(userId: string, threadId: string) {
  const thread = await getThread(userId, threadId);
  return {
    thread: {
      id: thread.id,
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    },
    messages: thread.messages,
    imports: thread.imports,
  };
}

export async function getPreferencesForClient(userId: string) {
  const preference = await getPreference(userId);
  return {
    autoSaveCreates: preference.autoSaveCreates,
    thinkingMode: preference.thinkingMode,
    reasoningEffort: preference.reasoningEffort,
    timezone: preference.timezone,
    consentAt: preference.consentAt,
  };
}
