import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { APP_TIMEZONE } from "../../utils/date.js";
import { ForbiddenError } from "../../utils/errors.js";
import type { preferencesSchema } from "./assistant.schema.js";
import type { z } from "zod";
import type { ReasoningEffort } from "../../lib/deepseek.js";
import { resolveTimezone } from "./assistant.time.js";

export type PreferenceRecord = {
  autoSaveCreates: boolean;
  thinkingMode: boolean;
  reasoningEffort: ReasoningEffort;
  timezone: string;
  consentAt: Date | null;
};

function normalizePreference(preference: {
  autoSaveCreates: boolean;
  thinkingMode?: boolean | null;
  reasoningEffort?: string | null;
  timezone: string;
  consentAt: Date | null;
}): PreferenceRecord {
  return {
    autoSaveCreates: preference.autoSaveCreates,
    thinkingMode: preference.thinkingMode ?? env.ASSISTANT_THINKING_DEFAULT,
    reasoningEffort:
      preference.reasoningEffort === "low" ||
      preference.reasoningEffort === "high" ||
      preference.reasoningEffort === "max"
        ? preference.reasoningEffort
        : env.ASSISTANT_REASONING_EFFORT_DEFAULT,
    timezone: preference.timezone,
    consentAt: preference.consentAt,
  };
}

/** Read (or lazily create) a user's assistant preferences. */
export async function getPreference(userId: string): Promise<PreferenceRecord> {
  const existing = await prisma.assistantPreference.findUnique({ where: { userId } });
  if (existing) return normalizePreference(existing);

  try {
    const created = await prisma.assistantPreference.create({
      data: {
        userId,
        timezone: APP_TIMEZONE,
        thinkingMode: env.ASSISTANT_THINKING_DEFAULT,
        reasoningEffort: env.ASSISTANT_REASONING_EFFORT_DEFAULT,
      },
    });
    return normalizePreference(created);
  } catch {
    // A concurrent request created it first.
    const created = await prisma.assistantPreference.findUnique({ where: { userId } });
    if (created) return normalizePreference(created);
    throw new Error("Could not load assistant preferences");
  }
}

export async function updatePreference(
  userId: string,
  input: z.infer<typeof preferencesSchema>,
): Promise<PreferenceRecord> {
  await getPreference(userId);

  const updated = await prisma.assistantPreference.update({
    where: { userId },
    data: {
      ...(input.autoSaveCreates !== undefined ? { autoSaveCreates: input.autoSaveCreates } : {}),
      ...(input.thinkingMode !== undefined ? { thinkingMode: input.thinkingMode } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.timezone !== undefined ? { timezone: resolveTimezone(input.timezone) } : {}),
    },
  });

  return normalizePreference(updated);
}

export async function recordConsent(userId: string): Promise<PreferenceRecord> {
  await getPreference(userId);
  const updated = await prisma.assistantPreference.update({
    where: { userId },
    data: { consentAt: new Date() },
  });
  return normalizePreference(updated);
}

export async function assertConsent(userId: string): Promise<PreferenceRecord> {
  const preference = await getPreference(userId);
  if (!preference.consentAt) {
    throw new ForbiddenError(
      "Before using the AI assistant, please accept the privacy notice about sending data to DeepSeek.",
    );
  }
  return preference;
}
