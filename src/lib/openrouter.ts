import { env } from "../config/env.js";
import { AppError } from "../utils/errors.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatCompletionUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type ChatCompletionResult = {
  content: string;
  model: string;
  usage?: ChatCompletionUsage;
};

type OpenRouterResponse = {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: number | string;
  };
};

export function isAiConfigured(): boolean {
  return Boolean(env.OPENROUTER_API_KEY);
}

/** Primary model first, then the configured fallbacks, without duplicates. */
export function getModelChain(): string[] {
  return [...new Set([env.OPENROUTER_MODEL, ...env.OPENROUTER_FALLBACK_MODELS].filter(Boolean))];
}

// Free models are often rate-limited upstream, so try the next one in the chain.
const FALLBACK_STATUS_CODES = new Set([404, 408, 429, 500, 502, 503, 504]);

/**
 * Calls OpenRouter's chat completions endpoint in JSON mode, falling back to
 * other configured models when a free model is unavailable or rate-limited.
 * Throws AppError with a user-facing message when every model fails.
 */
export async function createChatCompletion(
  messages: ChatMessage[],
  options: { maxTokens?: number; temperature?: number } = {},
): Promise<ChatCompletionResult> {
  if (!env.OPENROUTER_API_KEY) {
    throw new AppError(
      503,
      "The AI assistant is not configured yet. Add OPENROUTER_API_KEY to the API environment.",
    );
  }

  const models = getModelChain();
  let lastError: AppError | null = null;

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]!;
    const isLast = index === models.length - 1;

    try {
      return await requestCompletion(model, messages, options);
    } catch (error) {
      lastError = error instanceof AppError ? error : null;

      if (!isLast && lastError && FALLBACK_STATUS_CODES.has(lastError.statusCode)) {
        console.warn(`Assistant model ${model} unavailable (${lastError.statusCode}); trying next model.`);
        continue;
      }

      throw error;
    }
  }

  throw lastError ?? new AppError(502, "The AI assistant could not process that request. Please try again.");
}

async function requestCompletion(
  model: string,
  messages: ChatMessage[],
  options: { maxTokens?: number; temperature?: number },
): Promise<ChatCompletionResult> {
  let response: Response;

  try {
    response = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.FRONTEND_URL,
        "X-Title": "Money Tracker 365",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? 0.1,
        max_tokens: options.maxTokens ?? 900,
        response_format: { type: "json_object" },
        // Reasoning models can spend the whole token budget on reasoning and
        // return null content. Disable it for this extraction task.
        reasoning: { enabled: false },
      }),
      signal: AbortSignal.timeout(env.ASSISTANT_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new AppError(504, "The AI assistant took too long to respond. Please try again.");
    }
    throw new AppError(502, "Could not reach the AI assistant. Please try again.");
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");

    if (response.status === 429) {
      throw new AppError(
        429,
        "The AI assistant is receiving too many requests right now. Please wait a minute and try again.",
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new AppError(503, "The AI assistant credentials are invalid. Check the API configuration.");
    }

    console.error("OpenRouter request failed", model, response.status, body.slice(0, 500));
    throw new AppError(502, "The AI assistant could not process that request. Please try again.");
  }

  const data = (await response.json().catch(() => null)) as OpenRouterResponse | null;
  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    console.error("OpenRouter returned an empty response", model, data?.error ?? null);
    throw new AppError(502, "The AI assistant returned an empty response. Please try again.");
  }

  return {
    content,
    model: data?.model ?? model,
    ...(data?.usage
      ? {
          usage: {
            ...(data.usage.prompt_tokens !== undefined
              ? { promptTokens: data.usage.prompt_tokens }
              : {}),
            ...(data.usage.completion_tokens !== undefined
              ? { completionTokens: data.usage.completion_tokens }
              : {}),
            ...(data.usage.total_tokens !== undefined
              ? { totalTokens: data.usage.total_tokens }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Extracts a JSON object from a model response, tolerating code fences and
 * leading/trailing commentary.
 */
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

  const candidate = trimmed.slice(start, end + 1);

  try {
    return JSON.parse(candidate);
  } catch {
    throw new AppError(502, "The AI assistant returned invalid data. Please try again.");
  }
}
