import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 4999);

function categoryFor(system, type) {
  const lines = system.split("\n");
  let currentType = null;
  for (const line of lines) {
    const heading = line.match(/^(EXPENSE|INCOME|SAVING|INVESTMENT):\s*$/);
    if (heading) {
      currentType = heading[1];
      continue;
    }
    if (currentType === type) {
      const match = line.match(/^\s*-\s+(c[a-z0-9]+)\s+\|\s+(.+?)(?:\s+\|\s+group:.*)?$/i);
      if (match) return { id: match[1], name: match[2] };
    }
  }
  return { id: null, name: null };
}

function today(system) {
  return system.match(/Today is (\d{4}-\d{2}-\d{2})/)?.[1] ?? new Date().toISOString().slice(0, 10);
}

function candidateId(system) {
  const section = system.split("RECENT TRANSACTIONS THAT MAY BE EDITED OR DELETED")[1] ?? "";
  return section.match(/-\s+(c[a-z0-9]+)\s+\|/i)?.[1] ?? null;
}

function sectionOf(system, heading) {
  const parts = system.split(heading);
  return (parts[1] ?? "").split("\n\n")[0] ?? "";
}

function categoryByName(system, name) {
  for (const line of system.split("\n")) {
    const match = line.match(/^\s*-\s+(c[a-z0-9]+)\s+\|\s+(.+?)(?:\s+\|\s+group:.*)?$/i);
    if (match && match[2].trim().toLowerCase() === name.toLowerCase()) return match[1];
  }
  return null;
}

function groupByName(system, name) {
  for (const line of sectionOf(system, "USER CATEGORY GROUPS").split("\n")) {
    const match = line.match(/^-\s+(c[a-z0-9]+)\s+\|\s+(.+?)\s+\|\s+(\w+)/i);
    if (match && match[2].trim().toLowerCase() === name.toLowerCase()) return match[1];
  }
  return null;
}

function debtByParty(system, party) {
  for (const line of sectionOf(system, "DEBTS").split("\n")) {
    const match = line.match(/^-\s+(c[a-z0-9]+)\s+\|\s+(\w+)\s+\|\s+(.+?)\s+\|/i);
    if (match && match[3].trim().toLowerCase() === party.toLowerCase()) return match[1];
  }
  return null;
}

function reply(payload) {
  return JSON.stringify(payload);
}

function chatResponse(res, payload, reasoning = null) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      model: "deepseek-flash-mock",
      choices: [
        {
          message: {
            content: reply(payload),
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
    }),
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "POST" && url.pathname === "/chat/completions") {
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const reasoning =
      body.thinking?.type === "enabled"
        ? "Mock reasoning: the user wants a transaction and the app will ask for confirmation before saving."
        : null;
    const respond = (payload) => chatResponse(res, payload, reasoning);
    const messages = body.messages ?? [];
    const system =
      typeof messages.find((message) => message.role === "system")?.content === "string"
        ? messages.find((message) => message.role === "system").content
        : "";
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const text = typeof lastUser?.content === "string" ? lastUser.content.toLowerCase() : "";
    const isImage = Array.isArray(lastUser?.content) && lastUser.content.some((part) => part.type === "image_url");
    const date = today(system);
    const expense = categoryFor(system, "EXPENSE");
    const income = categoryFor(system, "INCOME");

    if (system.includes("extract transactions from bank statement")) {
      respond({
        rows: [
          {
            date,
            amount: 450,
            type: "EXPENSE",
            description: "Mock statement coffee",
            categoryId: expense.id,
            confidence: 0.92,
          },
          {
            date,
            amount: 85000,
            type: "INCOME",
            description: "Mock statement salary",
            categoryId: income.id,
            confidence: 0.95,
          },
        ],
      });
      return;
    }

    if (isImage) {
      respond({
        intent: "CREATE",
        reply: "I read this bill. Please check the total and date.",
        proposals: [
          {
            amount: 1250,
            type: "EXPENSE",
            categoryId: expense.id,
            suggestedCategoryName: null,
            date,
            note: "Cafe Coffee Day",
            confidence: 0.9,
          },
        ],
        operations: [],
        query: null,
        clarifications: [],
      });
      return;
    }

    if (text.includes("do i owe") || text.includes("owe me") || text.includes("debts")) {
      respond({
        intent: "QUERY",
        reply: "Here is what I found.",
        proposals: [],
        operations: [],
        entityActions: [],
        entityQuery: {
          entity: "DEBT",
          status: "ACTIVE",
          ...(text.includes("ramesh") ? { text: "Ramesh" } : {}),
        },
        query: null,
        clarifications: [],
      });
      return;
    }

    if (text.includes("borrowed") || text.includes("lent")) {
      const given = text.includes("lent");
      respond({
        intent: "MANAGE",
        reply: "Please confirm this debt.",
        proposals: [],
        operations: [],
        entityActions: [
          {
            entity: "DEBT",
            kind: "CREATE",
            partyName: given ? "Priya" : "Ramesh",
            type: given ? "GIVEN" : "TAKEN",
            amount: 25000,
            date,
            confidence: 0.95,
          },
        ],
        query: null,
        clarifications: [],
      });
      return;
    }

    if (text.includes("rename") && text.includes("categor")) {
      const targetId = categoryByName(system, "Groceries");
      respond({
        intent: targetId ? "MANAGE" : "CLARIFY",
        reply: targetId ? "Please confirm this rename." : "Which category should I rename?",
        proposals: [],
        operations: [],
        entityActions: targetId
          ? [{ entity: "CATEGORY", kind: "UPDATE", targetId, name: "Provisions", confidence: 0.9 }]
          : [],
        query: null,
        clarifications: targetId ? [] : ["Which category should I rename?"],
      });
      return;
    }

    if (text.includes("pets categor")) {
      const targetId = categoryByName(system, "Pets");

      if (text.includes("delete")) {
        respond({
          intent: targetId ? "MANAGE" : "CLARIFY",
          reply: targetId ? "Please confirm this deletion." : "Which category should I delete?",
          proposals: [],
          operations: [],
          entityActions: targetId
            ? [{ entity: "CATEGORY", kind: "DELETE", targetId, confidence: 0.9 }]
            : [],
          query: null,
          clarifications: targetId ? [] : ["Which category should I delete?"],
        });
        return;
      }

      respond({
        intent: "MANAGE",
        reply: "Please confirm this category.",
        proposals: [],
        operations: [],
        entityActions: [
          { entity: "CATEGORY", kind: "CREATE", name: "Pets", type: "EXPENSE", confidence: 0.9 },
        ],
        query: null,
        clarifications: [],
      });
      return;
    }

    if (text.includes("increase") && text.includes("ramesh")) {
      const targetId = debtByParty(system, "Ramesh");
      respond({
        intent: targetId ? "MANAGE" : "CLARIFY",
        reply: targetId ? "Please confirm this change." : "Which debt should I change?",
        proposals: [],
        operations: [],
        entityActions: targetId
          ? [{ entity: "DEBT", kind: "UPDATE", targetId, amount: 30000, confidence: 0.9 }]
          : [],
        query: null,
        clarifications: targetId ? [] : ["Which debt should I change?"],
      });
      return;
    }

    if (text.includes("household group") || text.includes("home group")) {
      const targetId = groupByName(system, "Household") ?? groupByName(system, "Home");

      if (text.includes("rename")) {
        respond({
          intent: targetId ? "MANAGE" : "CLARIFY",
          reply: targetId ? "Please confirm this rename." : "Which group should I rename?",
          proposals: [],
          operations: [],
          entityActions: targetId
            ? [{ entity: "GROUP", kind: "UPDATE", targetId, name: "Home", confidence: 0.9 }]
            : [],
          query: null,
          clarifications: targetId ? [] : ["Which group should I rename?"],
        });
        return;
      }

      if (text.includes("delete")) {
        respond({
          intent: targetId ? "MANAGE" : "CLARIFY",
          reply: targetId ? "Please confirm this deletion." : "Which group should I delete?",
          proposals: [],
          operations: [],
          entityActions: targetId
            ? [{ entity: "GROUP", kind: "DELETE", targetId, confidence: 0.9 }]
            : [],
          query: null,
          clarifications: targetId ? [] : ["Which group should I delete?"],
        });
        return;
      }

      respond({
        intent: "MANAGE",
        reply: "Please confirm this group.",
        proposals: [],
        operations: [],
        entityActions: [
          { entity: "GROUP", kind: "CREATE", name: "Household", type: "EXPENSE", confidence: 0.9 },
        ],
        query: null,
        clarifications: [],
      });
      return;
    }

    if (text.includes("how much") || text.includes("spent on food")) {
      respond({
        intent: "QUERY",
        reply: "Here is what I found.",
        proposals: [],
        operations: [],
        query: {
          filters: { from: `${date.slice(0, 7)}-01`, to: date, types: ["EXPENSE"] },
          groupBy: "category",
          aggregate: "SUM",
        },
        clarifications: [],
      });
      return;
    }

    if (text.includes("delete")) {
      const targetId = candidateId(system);
      respond({
        intent: targetId ? "DELETE" : "CLARIFY",
        reply: targetId ? "Please confirm this deletion." : "Which transaction should I delete?",
        proposals: [],
        operations: targetId
          ? [{ kind: "DELETE", targetId, changes: {}, confidence: 0.95 }]
          : [],
        query: null,
        clarifications: targetId ? [] : ["Which transaction should I delete?"],
      });
      return;
    }

    if (text.includes("change") || text.includes("edit")) {
      const targetId = candidateId(system);
      respond({
        intent: targetId ? "UPDATE" : "CLARIFY",
        reply: targetId ? "Please confirm this change." : "Which transaction should I change?",
        proposals: [],
        operations: targetId
          ? [{ kind: "UPDATE", targetId, changes: { amount: 500 }, confidence: 0.9 }]
          : [],
        query: null,
        clarifications: targetId ? [] : ["Which transaction should I change?"],
      });
      return;
    }

    const isSalary = text.includes("salary");
    const isLunch = text.includes("lunch");
    const amount = isSalary ? 85000 : isLunch ? 300 : 450;
    const category = isSalary ? income : expense;

    respond({
      intent: "CREATE",
      reply: "Here is what I understood. Please check and save.",
      proposals: [
        {
          amount,
          type: isSalary ? "INCOME" : "EXPENSE",
          categoryId: category.id,
          suggestedCategoryName: category.id ? null : "Mock category",
          date,
          note: isSalary ? "Salary" : isLunch ? "Lunch" : "BigBasket groceries",
          confidence: 0.93,
        },
      ],
      operations: [],
      query: null,
      clarifications: [],
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/tools/asr") {
    await readBody(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "Spent 300 on lunch today", duration_ms: 3200 }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/tools/ocr") {
    await readBody(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "ocr-mock",
        object: "ocr.result",
        page_count: 1,
        pages: [
          {
            index: 0,
            text: "01/11/2026 UPI/SWIGGY 450.00 12,450.00\n02/11/2026 SALARY CREDIT 85,000.00 97,450.00",
            finish_reason: "stop",
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      }),
    );
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found" } }));
});

server.listen(PORT, () => {
  console.log(`Mock DeepSeek listening on http://localhost:${PORT}`);
});

