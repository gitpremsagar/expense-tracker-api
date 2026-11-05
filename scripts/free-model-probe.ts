/**
 * Probes free OpenRouter models against the real assistant prompt + schema.
 * Run with: npx tsx scripts/free-model-probe.ts
 * Optional: PROBE_MODELS="a,b" and PROBE_CASES="0,1" to narrow the run.
 */
import "dotenv/config";
import { buildMessages } from "../src/modules/assistant/assistant.prompt.js";
import { modelResponseSchema } from "../src/modules/assistant/assistant.validation.js";
import { extractJsonObject } from "../src/lib/openrouter.js";

const DEFAULT_MODELS = [
  "nvidia/nemotron-3.5-super-vl:free",
  "dots-studio/dots-3-note-preview:free",
];

const MODELS = process.env.PROBE_MODELS
  ? process.env.PROBE_MODELS.split(",").map((m) => m.trim())
  : DEFAULT_MODELS;

const NOW = new Date("2026-11-05T10:30:00+05:30");
const TIMEZONE = "Asia/Kolkata";

type Case = {
  name: string;
  prompt: string;
  check: (data: ReturnType<typeof modelResponseSchema.parse>) => Record<string, boolean>;
};

const CASES: Case[] = [
  {
    name: "multi + shorthand",
    prompt: "spent 450 on groceries at BigBasket yesterday and got salary 85k today",
    check: (m) => {
      const tx = m.transactions ?? [];
      return {
        twoTransactions: tx.length === 2,
        amounts: tx.some((t) => t.amount === 450) && tx.some((t) => t.amount === 85000),
        types:
          tx.some((t) => (t.type ?? "").toUpperCase() === "INCOME") &&
          tx.some((t) => (t.type ?? "").toUpperCase() === "EXPENSE"),
        yesterday: tx.some((t) => (t.date ?? "").startsWith("2026-11-04")),
        suggestions: tx.every((t) => t.categoryId || t.suggestedCategoryName),
      };
    },
  },
  {
    name: "single + category",
    prompt: "spent 1200 on cab today",
    check: (m) => {
      const tx = m.transactions ?? [];
      return {
        oneTransaction: tx.length === 1,
        amount: tx[0]?.amount === 1200,
        suggestion: Boolean(tx[0]?.categoryId || tx[0]?.suggestedCategoryName),
      };
    },
  },
  {
    name: "missing amount",
    prompt: "paid for groceries",
    check: (m) => {
      const tx = m.transactions ?? [];
      return {
        noTransactions: tx.length === 0,
        intentClarify: (m.intent ?? "").toUpperCase() === "CLARIFY",
        asksSomething: Boolean(m.reply?.trim()) || (m.clarifications ?? []).length > 0,
      };
    },
  },
  {
    name: "explicit past date",
    prompt: "bought a laptop for 75000 on 2 Nov",
    check: (m) => {
      const tx = m.transactions ?? [];
      return {
        oneTransaction: tx.length === 1,
        amount: tx[0]?.amount === 75000,
        date: (tx[0]?.date ?? "").startsWith("2026-11-02"),
        suggestion: Boolean(tx[0]?.categoryId || tx[0]?.suggestedCategoryName),
      };
    },
  },
  {
    name: "not a transaction",
    prompt: "what is my balance this month?",
    check: (m) => {
      const tx = m.transactions ?? [];
      return {
        noTransactions: tx.length === 0,
        unsupported: (m.intent ?? "").toUpperCase() === "UNSUPPORTED",
      };
    },
  },
];

const SELECTED_CASES = process.env.PROBE_CASES
  ? process.env.PROBE_CASES.split(",").map((i) => CASES[Number(i)].name)
  : CASES.map((c) => c.name);

const API_KEY = process.env.OPENROUTER_API_KEY;

if (!API_KEY) {
  console.error("OPENROUTER_API_KEY is not set");
  process.exit(1);
}

async function probe(model: string, testCase: Case) {
  const messages = buildMessages(
    { message: testCase.prompt, history: [], timezone: TIMEZONE },
    [],
    NOW,
  );

  const started = Date.now();

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Money Tracker 365",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1,
        max_tokens: 900,
        response_format: { type: "json_object" },
        reasoning: { enabled: false },
      }),
      signal: AbortSignal.timeout(40_000),
    });

    const elapsed = Date.now() - started;
    const raw = await response.text();

    if (!response.ok) {
      return { model, case: testCase.name, ok: false, elapsed, failure: `HTTP ${response.status}: ${raw.slice(0, 160)}` };
    }

    const data = JSON.parse(raw);
    const content = data?.choices?.[0]?.message?.content;

    if (!content) {
      return { model, case: testCase.name, ok: false, elapsed, failure: `null content (finish=${data?.choices?.[0]?.finish_reason})` };
    }

    let json: unknown;
    try {
      json = extractJsonObject(content);
    } catch {
      return { model, case: testCase.name, ok: false, elapsed, failure: `not JSON: ${content.slice(0, 140)}` };
    }

    const parsed = modelResponseSchema.safeParse(json);
    if (!parsed.success) {
      return {
        model,
        case: testCase.name,
        ok: false,
        elapsed,
        failure: `schema: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ").slice(0, 160)}`,
      };
    }

    const checks = testCase.check(parsed.data);
    return {
      model,
      case: testCase.name,
      ok: Object.values(checks).every(Boolean),
      elapsed,
      checks,
      reply: parsed.data.reply,
      transactions: (parsed.data.transactions ?? []).map((t) => ({
        amount: t.amount,
        type: t.type,
        category: t.categoryId ?? t.suggestedCategoryName ?? null,
        date: t.date ?? null,
        note: t.note ?? null,
      })),
    };
  } catch (error) {
    return {
      model,
      case: testCase.name,
      ok: false,
      elapsed: Date.now() - started,
      failure: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

for (const model of MODELS) {
  for (const testCase of CASES.filter((c) => SELECTED_CASES.includes(c.name))) {
    const result = await probe(model, testCase);
    console.log(JSON.stringify(result));
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
}
