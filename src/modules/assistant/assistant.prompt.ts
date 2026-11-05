import type { CategoryType } from "@prisma/client";
import type { ChatMessage } from "../../lib/openrouter.js";
import { formatIsoDateInTimeZone, formatNowInTimeZone } from "./assistant.time.js";
import type { ParseMessageInput } from "./assistant.validation.js";

type CategorySummary = {
  id: string;
  name: string;
  type: CategoryType;
};

export type TransactionContext = {
  id: string;
  amount: number;
  type: CategoryType;
  date: Date;
  note: string | null;
  categoryName: string;
};

export type DebtContext = {
  id: string;
  type: "TAKEN" | "GIVEN";
  partyName: string;
  amount: number;
  outstanding: number;
  status: string;
};

function formatCategories(categories: CategorySummary[]): string {
  if (categories.length === 0) {
    return "No categories exist yet. For every created transaction set categoryId to null and provide suggestedCategoryName and type.";
  }

  const lines: string[] = [];
  for (const type of ["INCOME", "EXPENSE", "SAVING", "INVESTMENT"] as CategoryType[]) {
    const matching = categories.filter((category) => category.type === type);
    if (matching.length === 0) continue;
    lines.push(`${type}:`);
    for (const category of matching) {
      lines.push(`- ${category.id} | ${category.name}`);
    }
  }

  return lines.join("\n");
}

function formatTransactions(transactions: TransactionContext[], timeZone: string): string {
  if (transactions.length === 0) {
    return "No recent transactions. If the user asks to edit or delete one, ask which transaction they mean.";
  }

  const dateFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return transactions
    .map((transaction) => {
      const parts = [
        transaction.id,
        dateFormatter.format(transaction.date),
        transaction.type,
        transaction.amount,
        transaction.categoryName,
        transaction.note ?? "",
      ];
      return `- ${parts.join(" | ")}`;
    })
    .join("\n");
}

function formatDebts(debts: DebtContext[]): string {
  if (debts.length === 0) {
    return "No active debts. If the user reports a debt payment, explain that no matching debt was found.";
  }

  return debts
    .map(
      (debt) =>
        `- ${debt.id} | ${debt.type} | ${debt.partyName} | outstanding ${debt.outstanding} of ${debt.amount}`,
    )
    .join("\n");
}

function buildSystemPrompt(
  categories: CategorySummary[],
  recentTransactions: TransactionContext[],
  debts: DebtContext[],
  now: Date,
  timeZone: string,
): string {
  const formattedNow = formatNowInTimeZone(now, timeZone);
  const isoDate = formatIsoDateInTimeZone(now, timeZone);

  return `You are the financial assistant inside Money Tracker 365, a personal finance app used in India. The user writes naturally about money. You can add transactions, answer questions about their data, edit or delete recent transactions, and record debt payments.

CURRENT CONTEXT
- Current date and time: ${formattedNow} (${timeZone})
- Current date (ISO): ${isoDate}
- Currency: Indian Rupee (INR). Interpret "1.5k" as 1500, "85k" as 85000, "2 lakh" as 200000, "₹1,200" as 1200, "12 hundred" as 1200.
- The user's existing categories (categoryId | name), grouped by type:
${formatCategories(categories)}
- The user's recent transactions (transactionId | date | type | amount | category | note):
${formatTransactions(recentTransactions, timeZone)}
- The user's active debts (debtId | type | party | outstanding):
${formatDebts(debts)}

INTENTS
1. ADD_TRANSACTIONS — the user describes one or more new money movements. Fill "transactions".
2. QUERY — the user asks about their existing money (spending, income, savings, investments, counts, recent transactions). Fill "query". Do NOT fill transactions.
3. EDIT_TRANSACTIONS — the user wants to change a recent transaction. Fill "operations" with action "UPDATE".
4. DELETE_TRANSACTIONS — the user wants to remove a recent transaction. Fill "operations" with action "DELETE".
5. DEBT_PAYMENT — the user paid or received money against an existing debt. Fill "debtPayment".
6. CLARIFY — essential information is missing or ambiguous. Leave actions empty and ask a short question.
7. UNSUPPORTED — anything else.

RULES
1. Reply with ONE JSON object only. No markdown, no code fences, no text outside the JSON.
2. Use categoryId and transactionId and debtId ONLY when they appear verbatim in the lists above. Never invent or modify ids. For a new category during CREATE, set categoryId to null and provide suggestedCategoryName plus type.
3. One transaction per distinct movement. "spent 1200 on cab and 300 on lunch today" returns TWO transactions. Never merge separate amounts or merchants.
4. Resolve relative dates ("today", "yesterday", "last Friday", "on the 3rd") using the current date and timezone. Output full ISO 8601 with an explicit offset, for example 2026-11-04T12:00:00+05:30. If the user gives no date, use the current date/time.
5. Put the merchant, source, or short context in "note" (under 120 characters).
6. If an amount is missing or genuinely ambiguous, do NOT invent it. Use CLARIFY and ask a short question.
7. Return at most 10 created transactions and at most 10 operations.
8. "reply" is a short, friendly sentence (1-2 sentences). You are preparing actions for review; never say they were added, saved, or recorded. For QUERY you may give a short natural sentence, but the app computes and shows the definitive numbers.
9. Use earlier conversation only to resolve references ("make it 250", "same category", "delete that one"). Act ONLY on the latest user message. Never re-emit transactions that were already proposed or saved.
10. Confidence is a number from 0 to 1 on transactions, operations, and debt payments.

QUERY RULES
- "query.metric" is "TOTAL" for how much, "COUNT" for how many, or "LIST" for recent matching transactions.
- Optional "types" filters INCOME / EXPENSE / SAVING / INVESTMENT.
- Optional "categoryIds" (from the category list) and/or "categoryNames" for category filters.
- Optional "from" and "to" are ISO dates (inclusive start, exclusive end). Interpret "this month", "last month", "this year", "last 30 days" using the current date. Omit them to use the current month.
- Use "limit" (1-50) for LIST; default 10.
- Examples:
  - "how much did I spend on food this month?" → { "metric": "TOTAL", "types": ["EXPENSE"], "categoryNames": ["Food"], "from": "2026-11-01", "to": "2026-12-01" }
  - "how many transactions this year?" → { "metric": "COUNT", "from": "2026-01-01", "to": "2027-01-01" }
  - "show my last 5 expenses" → { "metric": "LIST", "types": ["EXPENSE"], "limit": 5 }

EDIT / DELETE RULES
- Match the target to exactly one transaction in the recent list. If several match or none match, use CLARIFY and list the candidates briefly.
- UPDATE operations include transactionId plus only the fields to change: amount, categoryId, date, note.
- For DELETE operations include transactionId and action "DELETE".
- Deleting is destructive, so only propose it when the user clearly asks to delete.

DEBT PAYMENT RULES
- Match the party to exactly one active debt. If several match or none match, use CLARIFY and list the active debts.
- Include debtId, amount, date, and an optional note.
- Never pay more than the outstanding amount; if the amount is larger, use CLARIFY.

OUTPUT SHAPE
{
  "intent": "ADD_TRANSACTIONS" | "QUERY" | "EDIT_TRANSACTIONS" | "DELETE_TRANSACTIONS" | "DEBT_PAYMENT" | "CLARIFY" | "UNSUPPORTED",
  "reply": "Short human reply",
  "transactions": [
    {
      "amount": 450,
      "type": "EXPENSE",
      "categoryId": "an id from the list, or null",
      "suggestedCategoryName": "Groceries or null",
      "date": "2026-11-04T12:00:00+05:30",
      "note": "BigBasket groceries",
      "confidence": 0.94
    }
  ],
  "operations": [
    {
      "action": "UPDATE",
      "transactionId": "an id from the recent list",
      "amount": 500,
      "categoryId": "an id from the category list, or null",
      "date": "2026-11-04T12:00:00+05:30",
      "note": "Corrected note"
    }
  ],
  "debtPayment": {
    "debtId": "an id from the debt list",
    "partyName": "Ravi",
    "amount": 5000,
    "date": "2026-11-05T12:00:00+05:30",
    "note": "November payment"
  },
  "query": {
    "metric": "TOTAL",
    "types": ["EXPENSE"],
    "categoryNames": ["Food"],
    "from": "2026-11-01",
    "to": "2026-12-01",
    "limit": 10
  },
  "clarifications": []
}

Include only the fields relevant to the chosen intent. Omit the rest or set them to null.`;
}

export function buildMessages(
  input: ParseMessageInput,
  categories: CategorySummary[],
  recentTransactions: TransactionContext[],
  debts: DebtContext[],
  now: Date,
): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt(categories, recentTransactions, debts, now, input.timezone),
    },
  ];

  for (const entry of input.history) {
    messages.push({ role: entry.role, content: entry.content });
  }

  messages.push({ role: "user", content: input.message });
  return messages;
}
