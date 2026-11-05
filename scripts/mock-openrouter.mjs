/**
 * Minimal OpenRouter-compatible mock for local UI testing.
 * Run with: node scripts/mock-openrouter.mjs
 * Then point the API at http://localhost:4999/v1.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 4999);

const content = JSON.stringify({
  intent: "ADD_TRANSACTIONS",
  reply: "I found 2 expenses. Review them and save when ready.",
  transactions: [
    {
      amount: 450,
      type: "EXPENSE",
      categoryId: null,
      suggestedCategoryName: "Groceries",
      date: "2026-11-04T12:00:00+05:30",
      note: "BigBasket",
      confidence: 0.94,
    },
    {
      amount: 300,
      type: "EXPENSE",
      categoryId: null,
      suggestedCategoryName: "Dining Out",
      date: "2026-11-05T13:00:00+05:30",
      note: "Lunch",
      confidence: 0.88,
    },
  ],
  clarifications: [],
});

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "mock-model",
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
        }),
      );
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found" } }));
});

server.listen(PORT, () => {
  console.log(`Mock OpenRouter listening on http://localhost:${PORT}`);
});
