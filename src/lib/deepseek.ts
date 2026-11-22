import { env } from "../config/env.js";
import { AppError } from "../utils/errors.js";

export type TextContentPart = { type: "text"; text: string };
export type ImageContentPart = {
  type: "image_url";
  image_url: { url: string; detail?: "low" | "high" | "original" | "auto" };
};
export type ContentPart = TextContentPart | ImageContentPart;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
};

export type ChatCompletionUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type ChatCompletionResult = {
  content: string;
  model: string;
  usage: ChatCompletionUsage;
  reasoning: string | null;
};

type DeepSeekResponse = {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; code?: number | string };
};

export const NOT_CONFIGURED_MESSAGE =
  "The AI assistant is not configured yet. Add DEEPSEEK_API_KEY to the API environment.";

export function isAiConfigured(): boolean {
  return Boolean(env.DEEPSEEK_API_KEY);
}

export function isAssistantEnabled(): boolean {
  return env.ASSISTANT_ENABLED && isAiConfigured();
}

export type ReasoningEffort = "low" | "high" | "max";

export type CompletionOptions = {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** DeepSeek thinking mode. Defaults to off for extraction tasks. */
  thinking?: boolean;
  reasoningEffort?: ReasoningEffort;
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRetryAfter(value: string | null): number {
  if (!value) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 15_000);
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) return Math.min(Math.max(timestamp - Date.now(), 500), 15_000);
  return 1_000;
}

function mapStatusError(status: number, body: string): AppError {
  if (status === 401 || status === 403) {
    return new AppError(503, "The AI assistant credentials are invalid. Check the API configuration.");
  }
  if (status === 402) {
    return new AppError(503, "The AI assistant account has no remaining credit. Please top up DeepSeek.");
  }
  if (status === 413) {
    return new AppError(413, "That file is too large for the AI assistant.");
  }
  if (status === 429) {
    return new AppError(
      429,
      "The AI assistant is receiving too many requests right now. Please wait a minute and try again.",
    );
  }
  console.error("DeepSeek request failed", status, body.slice(0, 400));
  return new AppError(502, "The AI assistant could not process that request. Please try again.");
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new AppError(504, timeoutMessage);
    }
    throw new AppError(502, "Could not reach the AI assistant. Please try again.");
  }
}

/**
 * Calls DeepSeek's OpenAI-compatible chat completions endpoint in JSON mode.
 * Thinking is disabled because this is structured extraction, not reasoning.
 */
export async function createChatCompletion(
  messages: ChatMessage[],
  options: CompletionOptions = {},
): Promise<ChatCompletionResult> {
  if (!env.DEEPSEEK_API_KEY) {
    throw new AppError(503, NOT_CONFIGURED_MESSAGE);
  }

  let lastError: AppError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        `${env.DEEPSEEK_BASE_URL}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: env.DEEPSEEK_MODEL,
            messages,
            ...(options.thinking ? {} : { temperature: options.temperature ?? 0.1 }),
            max_tokens: options.maxTokens ?? 1_500,
            response_format: { type: "json_object" },
            thinking: { type: options.thinking ? "enabled" : "disabled" },
            ...(options.thinking
              ? { reasoning_effort: options.reasoningEffort ?? "high" }
              : {}),
          }),
        },
        options.timeoutMs ?? env.ASSISTANT_TIMEOUT_MS,
        "The AI assistant took too long to respond. Please try again.",
      );

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const mapped = mapStatusError(response.status, body);
        lastError = mapped;

        if (attempt < MAX_ATTEMPTS && RETRYABLE_STATUS.has(response.status)) {
          await sleep(parseRetryAfter(response.headers.get("retry-after")));
          continue;
        }
        throw mapped;
      }

      const data = (await response.json().catch(() => null)) as DeepSeekResponse | null;
      const choice = data?.choices?.[0];
      const content = choice?.message?.content;
      const reasoning = choice?.message?.reasoning_content?.trim() || null;

      // JSON mode can return blank content when generation is cut off.
      if (!content || content.trim().length === 0) {
        console.error("DeepSeek returned an empty response", choice?.finish_reason ?? null);
        throw new AppError(
          502,
          options.thinking
            ? "The model spent its response budget on reasoning and returned no final answer. Try a lower effort or turn thinking off."
            : "The AI assistant returned an empty response. Please try again.",
        );
      }

      return {
        content,
        model: data?.model ?? env.DEEPSEEK_MODEL,
        reasoning,
        usage: {
          promptTokens: data?.usage?.prompt_tokens ?? 0,
          completionTokens: data?.usage?.completion_tokens ?? 0,
          totalTokens: data?.usage?.total_tokens ?? 0,
        },
      };
    } catch (error) {
      lastError = error instanceof AppError ? error : lastError;

      if (attempt < MAX_ATTEMPTS && lastError && RETRYABLE_STATUS.has(lastError.statusCode)) {
        await sleep(1_000);
        continue;
      }
      throw error;
    }
  }

  throw lastError ?? new AppError(502, "The AI assistant could not process that request.");
}

export type TranscriptionResult = {
  text: string;
  durationMs?: number;
};

/** DeepSeek ASR: 16-bit PCM WAV or Ogg Opus, max 8 MiB / 120 seconds. */
export async function transcribeAudio(
  audio: Buffer,
  filename: string,
  mimeType: string,
): Promise<TranscriptionResult> {
  if (!env.DEEPSEEK_API_KEY) throw new AppError(503, NOT_CONFIGURED_MESSAGE);

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), filename);

  const response = await fetchWithTimeout(
    `${env.DEEPSEEK_BASE_URL}/v1/tools/asr`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: form,
    },
    env.ASSISTANT_TIMEOUT_MS,
    "Transcribing that voice note took too long. Please try a shorter recording.",
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 413) {
      throw new AppError(413, "That recording is too large. Keep it under 2 minutes.");
    }
    throw mapStatusError(response.status, body);
  }

  const data = (await response.json().catch(() => null)) as
    | { text?: string; duration_ms?: number; error?: { message?: string } }
    | null;

  if (data?.error?.message) {
    throw new AppError(502, "The voice note could not be transcribed. Please try again.");
  }

  const text = data?.text?.trim();
  if (!text) {
    throw new AppError(422, "No speech was detected in that recording. Please try again.");
  }

  return { text, ...(data?.duration_ms !== undefined ? { durationMs: data.duration_ms } : {}) };
}

export type OcrResult = {
  pageCount: number;
  pages: string[];
};

/**
 * DeepSeek OCR. Returns page-by-page text; the uploaded file is not stored by
 * the OCR service. OCR output includes layout markers, which are stripped here.
 */
export async function ocrDocument(
  file: Buffer,
  filename: string,
  mimeType: string,
  purpose: "text_recognition" | "rich_layout_recognition" = "text_recognition",
): Promise<OcrResult> {
  if (!env.DEEPSEEK_API_KEY) throw new AppError(503, NOT_CONFIGURED_MESSAGE);

  const form = new FormData();
  // DeepSeek requires `purpose` before `file`.
  form.append("purpose", purpose);
  form.append("file", new Blob([new Uint8Array(file)], { type: mimeType }), filename);

  const response = await fetchWithTimeout(
    `${env.DEEPSEEK_BASE_URL}/v1/tools/ocr`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: form,
    },
    env.ASSISTANT_IMPORT_TIMEOUT_MS,
    "Reading that document took too long. Try a smaller statement.",
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 400 && /password/i.test(body)) {
      throw new AppError(422, "That PDF is password-protected. Remove the password and upload it again.");
    }
    if (response.status === 413) {
      throw new AppError(413, "That statement is too large (maximum 100 MiB).");
    }
    throw mapStatusError(response.status, body);
  }

  const data = (await response.json().catch(() => null)) as
    | {
        page_count?: number;
        pages?: Array<{ index?: number; text?: string; finish_reason?: string }>;
        error?: { message?: string };
      }
    | null;

  if (data?.error?.message) {
    if (/password/i.test(data.error.message)) {
      throw new AppError(422, "That PDF is password-protected. Remove the password and upload it again.");
    }
    throw new AppError(502, "That document could not be read. Try a clearer copy.");
  }

  const pages = (data?.pages ?? []).map((page) => stripOcrMarkers(page.text ?? ""));
  if (pages.length === 0 || pages.every((page) => page.trim().length === 0)) {
    throw new AppError(422, "No readable transactions were found in that document.");
  }

  return { pageCount: data?.page_count ?? pages.length, pages };
}

/** Remove DeepSeek OCR layout tokens such as <｜ref｜>Title<｜/ref｜><｜box｜>[[..]]<｜/box｜>. */
export function stripOcrMarkers(text: string): string {
  return text
    .replace(/<｜[^｜]*｜>/g, " ")
    .replace(/\[\s*\[\s*-?\d+(?:\s*,\s*-?\d+){3}\s*\]\s*\]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Extract a JSON object from a model response, tolerating fences/commentary. */
export function extractJsonObject(content: string): unknown {
  const trimmed = content.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to brace extraction.
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new AppError(502, "The AI assistant returned an unexpected response. Please try again.");
  }

  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new AppError(502, "The AI assistant returned invalid data. Please try again.");
  }
}
