/**
 * Smoke test for the assistant parser with a mocked OpenRouter response.
 * Uses a temporary user in the configured database and removes it afterwards.
 * Run with: npx tsx scripts/assistant-smoke.ts
 */
process.env.OPENROUTER_API_KEY = "smoke-test-key";
process.env.OPENROUTER_MODEL = "mock-model";

const { prisma } = await import("../src/lib/prisma.js");
const { parseMessage } = await import("../src/modules/assistant/assistant.service.js");

const NOW = "2026-11-05T10:30:00+05:30";
const TIMEZONE = "Asia/Kolkata";

let nextModelResponse: unknown = null;
let completionCalls = 0;

globalThis.fetch = (async () => {
  completionCalls += 1;
  return new Response(
    JSON.stringify({
      model: "mock-model",
      choices: [{ message: { content: JSON.stringify(nextModelResponse) } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}) as typeof fetch;

const email = `assistant-smoke-${Date.now()}@example.com`;

const user = await prisma.user.create({
  data: {
    name: "Assistant Smoke",
    email,
    password: "not-a-real-password",
    userType: "CUSTOMER",
  },
});

const checks: Array<[string, boolean]> = [];
function check(label: string, passed: boolean) {
  checks.push([label, passed]);
}

try {
  const [groceries, food, salary, rent] = await Promise.all([
    prisma.category.create({
      data: { name: "Groceries", type: "EXPENSE", userId: user.id },
    }),
    prisma.category.create({ data: { name: "Food", type: "EXPENSE", userId: user.id } }),
    prisma.category.create({ data: { name: "Salary", type: "INCOME", userId: user.id } }),
    prisma.category.create({ data: { name: "Rent", type: "EXPENSE", userId: user.id } }),
  ]);

  const createTransaction = (input: {
    amount: number;
    categoryId: string;
    type: "INCOME" | "EXPENSE";
    date: string;
    note: string;
  }) =>
    prisma.transaction.create({
      data: {
        amount: input.amount,
        categoryId: input.categoryId,
        type: input.type,
        date: new Date(input.date),
        note: input.note,
        userId: user.id,
      },
    });

  const [bigBasket, lunch] = await Promise.all([
    createTransaction({
      amount: 1500,
      categoryId: groceries.id,
      type: "EXPENSE",
      date: "2026-11-04T06:30:00.000Z",
      note: "BigBasket",
    }),
    createTransaction({
      amount: 300,
      categoryId: food.id,
      type: "EXPENSE",
      date: "2026-11-05T07:45:00.000Z",
      note: "Lunch",
    }),
    createTransaction({
      amount: 85000,
      categoryId: salary.id,
      type: "INCOME",
      date: "2026-11-01T06:30:00.000Z",
      note: "November salary",
    }),
    createTransaction({
      amount: 12000,
      categoryId: rent.id,
      type: "EXPENSE",
      date: "2026-10-05T06:30:00.000Z",
      note: "October rent",
    }),
  ]);

  const raviDebt = await prisma.debt.create({
    data: {
      type: "TAKEN",
      partyName: "Ravi",
      amount: 10000,
      description: "Smoke debt",
      date: new Date("2026-10-01T06:30:00.000Z"),
      status: "ACTIVE",
      userId: user.id,
    },
  });

  async function parse(message: string) {
    return parseMessage(user.id, {
      message,
      history: [],
      timezone: TIMEZONE,
      now: NOW,
    });
  }

  // ── Create ────────────────────────────────────────────────────────────────
  nextModelResponse = {
    intent: "ADD_TRANSACTIONS",
    reply: "I found 2 transactions.",
    transactions: [
      {
        amount: 1500,
        type: "expense",
        categoryId: null,
        suggestedCategoryName: "Groceries",
        date: "2026-11-04",
        note: "BigBasket",
        confidence: 94,
      },
      {
        amount: 300,
        type: "EXPENSE",
        categoryId: "category_the_user_does_not_own",
        date: "2026-11-05T13:15:00+05:30",
        note: "Lunch",
        confidence: 0.8,
      },
    ],
    clarifications: [],
  };

  const createResult = await parse(
    "spent 1.5k on groceries yesterday and 300 on lunch today",
  );
  const first = createResult.proposals[0];
  const second = createResult.proposals[1];

  check("create: two proposals", createResult.proposals.length === 2);
  check("create: intent", createResult.intent === "ADD_TRANSACTIONS");
  check("create: amount preserved", first?.amount === 1500);
  check("create: type normalized", first?.type === "EXPENSE");
  check("create: unknown category rejected", second?.categoryId === null);
  check(
    "create: date-only treated as noon IST",
    first?.date === "2026-11-04T06:30:00.000Z",
  );
  check("create: offset date preserved", second?.date === "2026-11-05T07:45:00.000Z");
  check(
    "create: confidence normalized",
    first?.confidence === 0.94 && second?.confidence === 0.8,
  );
  check("create: usage passed through", createResult.usage?.totalTokens === 30);
  check("create: conversation persisted", Boolean(createResult.conversationId));

  // ── Query: total for a category ───────────────────────────────────────────
  nextModelResponse = {
    intent: "QUERY",
    reply: "You spent on groceries.",
    query: {
      metric: "TOTAL",
      types: ["EXPENSE"],
      categoryNames: ["Groceries"],
      from: "2026-11-01",
      to: "2026-12-01",
    },
  };

  const totalResult = await parse("how much did I spend on groceries this month?");
  check("query total: intent", totalResult.intent === "QUERY");
  check("query total: expense total", totalResult.queryResult?.totals.EXPENSE === 1500);
  check("query total: count", totalResult.queryResult?.count === 1);
  check(
    "query total: category breakdown",
    totalResult.queryResult?.byCategory[0]?.name === "Groceries",
  );
  check(
    "query total: answer mentions amount",
    totalResult.queryResult?.answer.includes("1,500") === true,
  );

  // ── Query: count ──────────────────────────────────────────────────────────
  nextModelResponse = {
    intent: "QUERY",
    reply: "Here is the count.",
    query: {
      metric: "COUNT",
      types: ["EXPENSE"],
      from: "2026-11-01",
      to: "2026-12-01",
    },
  };

  const countResult = await parse("how many expenses this month?");
  check("query count: count", countResult.queryResult?.count === 2);
  check(
    "query count: answer",
    countResult.queryResult?.answer.includes("2 matching") === true,
  );

  // ── Query: list ───────────────────────────────────────────────────────────
  nextModelResponse = {
    intent: "QUERY",
    query: { metric: "LIST", types: ["EXPENSE"], from: "2026-11-01", to: "2026-12-01", limit: 2 },
    reply: "Here are your expenses.",
  };

  const listResult = await parse("show my last 2 expenses");
  check("query list: two rows", listResult.queryResult?.transactions.length === 2);
  check(
    "query list: newest first",
    listResult.queryResult?.transactions[0]?.id === lunch.id,
  );

  // ── Edit ──────────────────────────────────────────────────────────────────
  nextModelResponse = {
    intent: "EDIT_TRANSACTIONS",
    reply: "I can update that lunch.",
    operations: [
      { action: "UPDATE", transactionId: lunch.id, amount: 350, confidence: 0.9 },
    ],
  };

  const editResult = await parse("change the lunch amount to 350");
  check("edit: intent", editResult.intent === "EDIT_TRANSACTIONS");
  check("edit: before amount", editResult.operations[0]?.before.amount === 300);
  check("edit: after amount", editResult.operations[0]?.after?.amount === 350);
  check("edit: category kept", editResult.operations[0]?.after?.categoryName === "Food");

  // ── Delete ────────────────────────────────────────────────────────────────
  nextModelResponse = {
    intent: "DELETE_TRANSACTIONS",
    reply: "I can delete that transaction.",
    operations: [{ action: "DELETE", transactionId: bigBasket.id }],
  };

  const deleteResult = await parse("delete the BigBasket transaction");
  check("delete: intent", deleteResult.intent === "DELETE_TRANSACTIONS");
  check("delete: action", deleteResult.operations[0]?.action === "DELETE");
  check("delete: after is null", deleteResult.operations[0]?.after === null);

  // ── Unknown transaction ───────────────────────────────────────────────────
  nextModelResponse = {
    intent: "DELETE_TRANSACTIONS",
    reply: "I can delete that.",
    operations: [{ action: "DELETE", transactionId: "does_not_exist" }],
  };

  const unknownResult = await parse("delete the mystery transaction");
  check("unknown transaction: no operations", unknownResult.operations.length === 0);
  check(
    "unknown transaction: clarification",
    unknownResult.clarifications.some((line) => line.toLowerCase().includes("could not match")),
  );

  // ── Debt payment ──────────────────────────────────────────────────────────
  nextModelResponse = {
    intent: "DEBT_PAYMENT",
    reply: "I found the payment.",
    debtPayment: {
      partyName: "Ravi",
      amount: 4000,
      date: "2026-11-05T12:00:00+05:30",
      note: "November payment",
      confidence: 0.95,
    },
  };

  const paymentResult = await parse("paid Ravi 4000 today");
  const payment = paymentResult.debtPayments[0];
  check("debt: intent", paymentResult.intent === "DEBT_PAYMENT");
  check("debt: matched debt", payment?.debtId === raviDebt.id);
  check("debt: outstanding before", payment?.outstandingBefore === 10000);
  check("debt: outstanding after", payment?.outstandingAfter === 6000);

  // ── Debt overpayment ──────────────────────────────────────────────────────
  nextModelResponse = {
    intent: "DEBT_PAYMENT",
    reply: "I found the payment.",
    debtPayment: { partyName: "Ravi", amount: 50000 },
  };

  const overpayResult = await parse("paid Ravi 50000");
  check("debt overpay: no payment", overpayResult.debtPayments.length === 0);
  check(
    "debt overpay: clarification",
    overpayResult.clarifications.some((line) => line.toLowerCase().includes("more than")),
  );

  // ── Apply edit ────────────────────────────────────────────────────────────
  const { applyActions } = await import("../src/modules/assistant/assistant.service.js");
  const applied = await applyActions(user.id, {
    operations: [{ action: "UPDATE", transactionId: lunch.id, amount: 350 }],
    requestId: "smoke-apply-1",
  });

  check("apply: updated amount", applied.transactions[0]?.amount === 350);

  const replayed = await applyActions(user.id, {
    operations: [{ action: "UPDATE", transactionId: lunch.id, amount: 999 }],
    requestId: "smoke-apply-1",
  });
  check("apply: idempotent replay", replayed.transactions[0]?.amount === 350);

  const storedLunch = await prisma.transaction.findUnique({ where: { id: lunch.id } });
  check("apply: database updated once", storedLunch?.amount === 350);

  // ── Apply debt payment ────────────────────────────────────────────────────
  const debtApplied = await applyActions(user.id, {
    debtPayments: [
      { debtId: raviDebt.id, amount: 4000, date: "2026-11-05T12:00:00+05:30" },
    ],
    requestId: "smoke-apply-debt-1",
  });
  check("apply debt: payment created", debtApplied.debts.length === 1);

  const storedDebt = await prisma.debt.findUnique({
    where: { id: raviDebt.id },
    include: { payments: true },
  });
  check("apply debt: payment stored", storedDebt?.payments.length === 1);
  check("apply debt: status still active", storedDebt?.status === "ACTIVE");

  // ── Undo ──────────────────────────────────────────────────────────────────
  const { undoTransactions } = await import("../src/modules/assistant/assistant.service.js");
  const undone = await undoTransactions(user.id, {
    transactionIds: [lunch.id],
    requestId: "smoke-undo-1",
  });
  check("undo: deleted", undone.deleted === 1);

  const undoneAgain = await undoTransactions(user.id, {
    transactionIds: [lunch.id],
    requestId: "smoke-undo-1",
  });
  check("undo: idempotent replay", undoneAgain.deleted === 1);

  check("model called once per parse", completionCalls === 9);
} finally {
  await prisma.assistantRequest.deleteMany({ where: { userId: user.id } });
  await prisma.assistantUsageLog.deleteMany({ where: { userId: user.id } });
  await prisma.assistantMessage.deleteMany({ where: { userId: user.id } });
  await prisma.assistantConversation.deleteMany({ where: { userId: user.id } });
  await prisma.assistantPreference.deleteMany({ where: { userId: user.id } });
  await prisma.debtPayment.deleteMany({ where: { userId: user.id } });
  await prisma.debt.deleteMany({ where: { userId: user.id } });
  await prisma.transaction.deleteMany({ where: { userId: user.id } });
  await prisma.category.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.$disconnect();
}

let failed = false;
for (const [label, passed] of checks) {
  console.log(`${passed ? "PASS" : "FAIL"} ${label}`);
  if (!passed) failed = true;
}

console.log(`\n${checks.length - checks.filter(([, passed]) => !passed).length}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
