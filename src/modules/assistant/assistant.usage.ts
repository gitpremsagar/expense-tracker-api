import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/errors.js";
import { APP_TIMEZONE, dateKey } from "../../utils/date.js";
import { usageDay } from "./assistant.time.js";

type UsageKind = "text" | "image" | "audio" | "import";

const RATE_LIMITS: Record<UsageKind, { windowMs: number; max: number }> = {
  text: { windowMs: 60_000, max: 20 },
  image: { windowMs: 60_000, max: 5 },
  audio: { windowMs: 60_000, max: 5 },
  import: { windowMs: 60 * 60_000, max: 3 },
};

const buckets = new Map<string, { count: number; resetAt: number }>();

export function consumeRateLimit(userId: string, kind: UsageKind): void {
  const now = Date.now();
  const key = `${kind}:${userId}`;
  const bucket = buckets.get(key);

  if (bucket && bucket.resetAt > now) {
    if (bucket.count >= RATE_LIMITS[kind].max) {
      throw new AppError(429, "You are using the assistant a little too quickly. Please wait a moment.");
    }
    bucket.count += 1;
    return;
  }

  buckets.set(key, { count: 1, resetAt: now + RATE_LIMITS[kind].windowMs });

  // Bound the map in long-running dev processes.
  if (buckets.size > 10_000) {
    for (const [entryKey, entry] of buckets) {
      if (entry.resetAt <= now) buckets.delete(entryKey);
    }
  }
}

function isPeakPricing(now = new Date()): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = now.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function estimateCostUsd(promptTokens: number, completionTokens: number): number {
  const peak = isPeakPricing();
  const inputRate = peak ? 0.3 : 0.15;
  const outputRate = peak ? 1.2 : 0.6;
  return (promptTokens / 1_000_000) * inputRate + (completionTokens / 1_000_000) * outputRate;
}

export async function assertQuota(userId: string, kind: UsageKind, pages = 0): Promise<void> {
  consumeRateLimit(userId, kind);

  const day = usageDay();
  const [usage, global] = await Promise.all([
    prisma.assistantUsage.findUnique({ where: { userId_day: { userId, day } } }),
    prisma.assistantUsage.aggregate({ where: { day }, _sum: { costUsd: true } }),
  ]);

  if (kind !== "import" && (usage?.messages ?? 0) >= env.ASSISTANT_DAILY_MESSAGES) {
    throw new AppError(
      429,
      "You have reached today's assistant message limit. It resets at midnight IST.",
    );
  }

  if (kind === "import" && (usage?.importPages ?? 0) + pages > env.ASSISTANT_DAILY_IMPORT_PAGES) {
    throw new AppError(
      429,
      `You have reached today's statement limit (${env.ASSISTANT_DAILY_IMPORT_PAGES} pages). It resets at midnight IST.`,
    );
  }

  if ((global._sum.costUsd ?? 0) >= env.ASSISTANT_GLOBAL_DAILY_COST_USD) {
    throw new AppError(
      503,
      "The AI assistant is taking a short break because its daily budget is used up. Please try again tomorrow.",
    );
  }
}

/** Re-check the daily page budget once the real page count is known. */
export async function assertImportPageBudget(userId: string, pages: number): Promise<void> {
  const day = usageDay();
  const usage = await prisma.assistantUsage.findUnique({
    where: { userId_day: { userId, day } },
  });

  if ((usage?.importPages ?? 0) + pages > env.ASSISTANT_DAILY_IMPORT_PAGES) {
    throw new AppError(
      429,
      `That statement needs ${pages} pages, which is over today's remaining limit (${env.ASSISTANT_DAILY_IMPORT_PAGES} pages).`,
    );
  }
}

export async function recordUsage(
  userId: string,
  input: {
    messages?: number;
    importPages?: number;
    promptTokens?: number;
    completionTokens?: number;
    extraCostUsd?: number;
  },
): Promise<void> {
  const promptTokens = input.promptTokens ?? 0;
  const completionTokens = input.completionTokens ?? 0;
  const costUsd = estimateCostUsd(promptTokens, completionTokens) + (input.extraCostUsd ?? 0);
  const day = usageDay();

  await prisma.assistantUsage.upsert({
    where: { userId_day: { userId, day } },
    create: {
      userId,
      day,
      messages: input.messages ?? 0,
      importPages: input.importPages ?? 0,
      promptTokens,
      completionTokens,
      costUsd,
    },
    update: {
      ...(input.messages ? { messages: { increment: input.messages } } : {}),
      ...(input.importPages ? { importPages: { increment: input.importPages } } : {}),
      ...(promptTokens ? { promptTokens: { increment: promptTokens } } : {}),
      ...(completionTokens ? { completionTokens: { increment: completionTokens } } : {}),
      ...(costUsd > 0 ? { costUsd: { increment: costUsd } } : {}),
    },
  });
}

export async function getUsageSummary(userId: string) {
  const day = usageDay();
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceDay = usageDayFrom(since);

  const [today, recent] = await Promise.all([
    prisma.assistantUsage.findUnique({ where: { userId_day: { userId, day } } }),
    prisma.assistantUsage.findMany({
      where: { userId, day: { gte: sinceDay } },
      orderBy: { day: "desc" },
    }),
  ]);

  const totals = recent.reduce(
    (acc, entry) => ({
      messages: acc.messages + entry.messages,
      importPages: acc.importPages + entry.importPages,
      promptTokens: acc.promptTokens + entry.promptTokens,
      completionTokens: acc.completionTokens + entry.completionTokens,
      costUsd: acc.costUsd + entry.costUsd,
    }),
    { messages: 0, importPages: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 },
  );

  return {
    today: {
      day,
      messages: today?.messages ?? 0,
      importPages: today?.importPages ?? 0,
      costUsd: Number((today?.costUsd ?? 0).toFixed(4)),
    },
    limits: {
      dailyMessages: env.ASSISTANT_DAILY_MESSAGES,
      dailyImportPages: env.ASSISTANT_DAILY_IMPORT_PAGES,
      maxImportRows: env.ASSISTANT_MAX_IMPORT_ROWS,
      maxCreatesPerTurn: env.ASSISTANT_MAX_CREATES_PER_TURN,
    },
    last30Days: {
      ...totals,
      costUsd: Number(totals.costUsd.toFixed(4)),
    },
  };
}

function usageDayFrom(date: Date): string {
  return dateKey(date, APP_TIMEZONE);
}
