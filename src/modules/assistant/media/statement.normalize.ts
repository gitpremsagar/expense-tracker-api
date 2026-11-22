import type { CategoryType } from "@prisma/client";
import { createChatCompletion, extractJsonObject } from "../../../lib/deepseek.js";
import { roundMoney } from "../../../utils/date.js";
import { AppError } from "../../../utils/errors.js";
import type { AssistantCategory } from "../assistant.prompt.js";
import {
  buildStatementSystemPrompt,
  STATEMENT_USER_PREFIX,
} from "../assistant.prompt.js";
import { statementRowsSchema, type StatementRow } from "../assistant.schema.js";
import { normalizeDateValue } from "../assistant.time.js";
import type { ExtractedRow } from "./statement.extract.js";
import { parseStatementAmount, parseStatementDate } from "./statement.extract.js";

export type NormalizedStatementRow = ExtractedRow & {
  categoryId: string | null;
  suggestedCategoryName: string | null;
};

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  Groceries: ["bigbasket", "grofers", "dmart", "zepto", "blinkit", "instamart", "grocery", "supermarket"],
  "Food & Dining": ["swiggy", "zomato", "restaurant", "cafe", "coffee", "dominos", "pizza", "burger", "hotel", "bakery", "eat"],
  Transport: ["uber", "ola", "rapido", "petrol", "fuel", "diesel", "metro", "irctc", "railway", "fastag", "parking"],
  Shopping: ["amazon", "flipkart", "myntra", "ajio", "meesho", "nykaa", "shopping", "mall", "store"],
  Entertainment: ["netflix", "prime video", "hotstar", "spotify", "bookmyshow", "pvr", "inox", "game"],
  Utilities: ["electricity", "water bill", "gas bill", "broadband", "airtel", "jio", "vodafone", "vi ", "recharge", "dth"],
  Rent: ["rent", "landlord", "housing"],
  Health: ["pharmacy", "medical", "hospital", "clinic", "doctor", "apollo", "medplus", "1mg", "pharmeasy"],
  Education: ["school", "college", "tuition", "course", "udemy", "coursera", "book"],
  Insurance: ["insurance", "policy", "lic "],
  Salary: ["salary", "payroll", "wages"],
  Freelance: ["freelance", "consulting", "client payment"],
  Interest: ["interest credit", "int credit"],
  "Other Income": ["refund", "cashback", "reversal"],
  "Mutual Funds": ["mutual fund", "sip ", "nav "],
  Stocks: ["stock", "broker", "zerodha", "groww", "upstox"],
};

function suggestCategory(
  description: string,
  type: "EXPENSE" | "INCOME",
  categories: AssistantCategory[],
): AssistantCategory | null {
  const text = description.toLowerCase();
  const allowedTypes = type === "INCOME" ? new Set(["INCOME"]) : new Set(["EXPENSE", "SAVING", "INVESTMENT"]);

  for (const category of categories) {
    if (!allowedTypes.has(category.type)) continue;
    const keywords = CATEGORY_KEYWORDS[category.name];
    if (keywords?.some((keyword) => text.includes(keyword))) return category;
  }

  return (
    categories.find(
      (category) => category.type === type && /^other(\s|$)/i.test(category.name),
    ) ?? null
  );
}

export function normalizeTableRows(
  rows: ExtractedRow[],
  categories: AssistantCategory[],
): NormalizedStatementRow[] {
  return rows.flatMap((row) => {
    const date = parseStatementDate(row.date);
    const amount = roundMoney(row.amount);
    if (!date || !Number.isFinite(amount) || amount <= 0 || amount > 10_00_00_000) return [];

    const suggested = suggestCategory(row.description, row.type, categories);

    return [
      {
        ...row,
        date,
        amount,
        description: row.description.slice(0, 300),
        categoryId: suggested?.id ?? null,
        suggestedCategoryName: suggested?.name ?? null,
      },
    ];
  });
}

export async function extractRowsFromText(input: {
  chunks: string[];
  categories: AssistantCategory[];
  today: string;
}): Promise<{
  rows: NormalizedStatementRow[];
  promptTokens: number;
  completionTokens: number;
}> {
  if (input.chunks.length === 0) {
    return { rows: [], promptTokens: 0, completionTokens: 0 };
  }

  const system = buildStatementSystemPrompt({
    categories: input.categories,
    today: input.today,
  });

  const categoryMap = new Map(input.categories.map((category) => [category.id, category]));
  const rows: NormalizedStatementRow[] = [];
  const maxChunks = Math.min(input.chunks.length, 12);
  let promptTokens = 0;
  let completionTokens = 0;

  for (let index = 0; index < maxChunks; index += 1) {
    const chunk = input.chunks[index]!;
    const messages = [
      { role: "system" as const, content: system },
      {
        role: "user" as const,
        content: `${STATEMENT_USER_PREFIX}\n\n<<<DOC\n${chunk}\nDOC>>>`,
      },
    ];

    let result = await createChatCompletion(messages, { maxTokens: 4_000, temperature: 0.05 });
    promptTokens += result.usage.promptTokens;
    completionTokens += result.usage.completionTokens;
    let parsed: StatementRow[];

    try {
      parsed = parseStatementRows(result.content);
    } catch (error) {
      const repair = await createChatCompletion(
        [
          ...messages,
          { role: "assistant", content: result.content },
          {
            role: "user",
            content: `That response was not valid JSON for the schema. Return corrected JSON only, with a "rows" array. ${
              error instanceof Error ? error.message.slice(0, 200) : ""
            }`,
          },
        ],
        { maxTokens: 4_000, temperature: 0 },
      );
      promptTokens += repair.usage.promptTokens;
      completionTokens += repair.usage.completionTokens;
      parsed = parseStatementRows(repair.content);
    }

    for (const row of parsed) {
      const normalized = normalizeModelRow(row, categoryMap);
      if (normalized) rows.push(normalized);
      if (rows.length >= 500) break;
    }

    if (rows.length >= 500) break;
  }

  return { rows, promptTokens, completionTokens };
}

function parseStatementRows(content: string): StatementRow[] {
  const raw = extractJsonObject(content);
  return statementRowsSchema.parse(raw).rows;
}

function normalizeModelRow(
  row: StatementRow,
  categoryMap: Map<string, AssistantCategory>,
): NormalizedStatementRow | null {
  const date = parseStatementDate(row.date);
  if (!date) return null;

  const amount = roundMoney(Number(row.amount));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_00_00_000) return null;

  const category = row.categoryId ? categoryMap.get(row.categoryId) : undefined;
  const suggested = row.suggestedCategoryName?.trim().slice(0, 80) || null;

  return {
    date,
    amount,
    type: row.type === "INCOME" ? "INCOME" : "EXPENSE",
    description: (row.description ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    confidence: Math.min(1, Math.max(0, row.confidence ?? 0.5)),
    categoryId: category?.id ?? null,
    suggestedCategoryName: category ? null : suggested,
  };
}

export function rowsToTransactions(
  rows: NormalizedStatementRow[],
  categories: AssistantCategory[],
): Array<NormalizedStatementRow & { categoryType: CategoryType }> {
  const categoryMap = new Map(categories.map((category) => [category.id, category]));

  return rows.map((row) => {
    const category = row.categoryId ? categoryMap.get(row.categoryId) : undefined;
    return {
      ...row,
      categoryType: category?.type ?? (row.type === "INCOME" ? "INCOME" : "EXPENSE"),
    };
  });
}

export function assertImportDate(date: string, now = new Date()): boolean {
  const parsed = normalizeDateValue(date, "UTC");
  if (!parsed) return false;
  const min = new Date(now);
  min.setFullYear(min.getFullYear() - 5);
  const max = new Date(now);
  max.setDate(max.getDate() + 1);
  return parsed >= min && parsed <= max;
}

export function ensureRows(rows: NormalizedStatementRow[]): void {
  if (rows.length === 0) {
    throw new AppError(422, "No transactions were found in that statement.");
  }
}
