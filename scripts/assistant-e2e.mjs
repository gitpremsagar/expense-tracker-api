import assert from "node:assert/strict";

const BASE = process.env.API_URL ?? "http://localhost:3711";
const PASSWORD = "TestPass123!";
const EMAIL = `assistant-e2e-${Date.now()}@example.com`;

let token = null;

async function request(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
    ...(options.body && !(options.body instanceof FormData)
      ? { body: JSON.stringify(options.body) }
      : {}),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function makeWav(seconds = 1, sampleRate = 16000) {
  const samples = sampleRate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);

  for (let index = 0; index < samples; index += 1) {
    const value = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.2;
    buffer.writeInt16LE(Math.round(value * 0x7fff), 44 + index * 2);
  }
  return buffer;
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

async function main() {
  console.log("1. signup");
  const signup = await request("/auth/signup", {
    method: "POST",
    body: { name: "Assistant E2E", email: EMAIL, password: PASSWORD },
  });
  token = signup.accessToken;
  assert.ok(token);

  console.log("2. status + consent");
  const status = await request("/assistant/status");
  assert.equal(status.enabled, true);
  assert.equal(status.consentRequired, true);
  await request("/assistant/consent", { method: "POST" });

  console.log("3. categories");
  const categories = await request("/categories");
  assert.ok(categories.categories.length > 0);

  console.log("4. text create proposal");
  const thread = await request("/assistant/threads", { method: "POST", body: {} });
  const threadId = thread.thread.id;
  const created = await request(`/assistant/threads/${threadId}/messages`, {
    method: "POST",
    body: { text: "spent 450 on groceries at BigBasket today" },
  });
  assert.equal(created.turn.proposals.length, 1);
  assert.equal(created.turn.proposals[0].amount, 450);
  assert.ok(created.turn.proposals[0].categoryId);

  console.log("5. confirm + undo");
  const confirm = await request("/assistant/actions/confirm", {
    method: "POST",
    body: {
      clientRequestId: crypto.randomUUID(),
      threadId,
      messageId: created.messageId,
      items: [
        {
          kind: "CREATE",
          amount: 450,
          categoryId: created.turn.proposals[0].categoryId,
          date: created.turn.proposals[0].date,
          note: "BigBasket groceries",
          proposalId: created.turn.proposals[0].proposalId,
        },
      ],
    },
  });
  assert.equal(confirm.created, 1);

  const afterConfirm = await request(`/assistant/threads/${threadId}`);
  const savedMessage = afterConfirm.messages.find((message) => message.id === created.messageId);
  assert.ok(savedMessage.turn.savedProposalIds.includes(created.turn.proposals[0].proposalId));

  const transactions = await request("/transactions?limit=100");
  const createdTransaction = transactions.transactions.find(
    (transaction) => transaction.amount === 450 && transaction.note === "BigBasket groceries",
  );
  assert.ok(createdTransaction);

  const undo = await request(`/assistant/actions/${confirm.batchId}/undo`, { method: "POST" });
  assert.equal(undo.undone, true);
  const afterUndo = await request("/transactions?limit=100");
  assert.equal(
    afterUndo.transactions.some((transaction) => transaction.id === createdTransaction.id),
    false,
  );

  console.log("6. edit and delete");
  const lunchMessage = await request(`/assistant/threads/${threadId}/messages`, {
    method: "POST",
    body: { text: "spent 300 on lunch today" },
  });
  const lunchProposal = lunchMessage.turn.proposals[0];
  const lunchConfirm = await request("/assistant/actions/confirm", {
    method: "POST",
    body: {
      clientRequestId: crypto.randomUUID(),
      threadId,
      messageId: lunchMessage.messageId,
      items: [
        {
          kind: "CREATE",
          amount: 300,
          categoryId: lunchProposal.categoryId,
          date: lunchProposal.date,
          note: "Lunch",
          proposalId: lunchProposal.proposalId,
        },
      ],
    },
  });
  assert.equal(lunchConfirm.created, 1);

  const editMessage = await request(`/assistant/threads/${threadId}/messages`, {
    method: "POST",
    body: { text: "change the lunch to 500" },
  });
  assert.equal(editMessage.turn.operations.length, 1);
  assert.equal(editMessage.turn.operations[0].kind, "UPDATE");
  await request("/assistant/actions/confirm", {
    method: "POST",
    body: {
      clientRequestId: crypto.randomUUID(),
      threadId,
      messageId: editMessage.messageId,
      items: [
        {
          kind: "UPDATE",
          targetId: editMessage.turn.operations[0].targetId,
          changes: editMessage.turn.operations[0].changes,
          operationId: editMessage.turn.operations[0].operationId,
        },
      ],
    },
  });

  const edited = await request("/transactions?limit=100");
  assert.equal(
    edited.transactions.some((transaction) => transaction.amount === 500 && transaction.note === "Lunch"),
    true,
  );

  const deleteMessage = await request(`/assistant/threads/${threadId}/messages`, {
    method: "POST",
    body: { text: "delete the lunch entry" },
  });
  assert.equal(deleteMessage.turn.operations[0].kind, "DELETE");
  const deleteConfirm = await request("/assistant/actions/confirm", {
    method: "POST",
    body: {
      clientRequestId: crypto.randomUUID(),
      threadId,
      messageId: deleteMessage.messageId,
      items: [
        {
          kind: "DELETE",
          targetId: deleteMessage.turn.operations[0].targetId,
          operationId: deleteMessage.turn.operations[0].operationId,
        },
      ],
    },
  });
  assert.equal(deleteConfirm.deleted, 1);
  await request(`/assistant/actions/${deleteConfirm.batchId}/undo`, { method: "POST" });

  console.log("7. bill photo");
  const imageForm = new FormData();
  imageForm.append("kind", "IMAGE");
  imageForm.append("file", new Blob([PNG_1X1], { type: "image/png" }), "bill.png");
  const bill = await request(`/assistant/threads/${threadId}/attachments`, {
    method: "POST",
    body: imageForm,
  });
  assert.equal(bill.turn.proposals[0].amount, 1250);

  console.log("8. voice note");
  const audioForm = new FormData();
  audioForm.append("kind", "AUDIO");
  audioForm.append("file", new Blob([makeWav()], { type: "audio/wav" }), "note.wav");
  const voice = await request(`/assistant/threads/${threadId}/attachments`, {
    method: "POST",
    body: audioForm,
  });
  assert.match(voice.transcript, /lunch/i);

  console.log("9. CSV statement import");
  const csv = Buffer.from(
    [
      "Date,Narration,Debit,Credit,Balance",
      "01/11/2026,UPI/SWIGGY,450.00,,12450.00",
      "02/11/2026,SALARY CREDIT,,85000.00,97450.00",
      "01/11/2026,UPI/SWIGGY,450.00,,12450.00",
      "03/11/2026,Salary Credit,,85000.00,182450.00",
    ].join("\n"),
    "utf8",
  );
  const statementForm = new FormData();
  statementForm.append("threadId", threadId);
  statementForm.append("file", new Blob([csv], { type: "text/csv" }), "statement.csv");
  const started = await request("/assistant/imports", { method: "POST", body: statementForm });
  const importId = started.import.id;

  let detail = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    detail = await request(`/assistant/imports/${importId}?limit=100`);
    if (detail.import.status !== "PROCESSING") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(detail.import.status, "READY", JSON.stringify(detail.import));
  assert.ok(detail.rows.length >= 3);
  assert.ok(detail.rows.some((row) => row.status === "DUPLICATE"));

  const categoryId =
    categories.categories.find((category) => category.type === "EXPENSE")?.id ?? categories.categories[0].id;
  const commit = await request(`/assistant/imports/${importId}/commit`, {
    method: "POST",
    body: {
      clientRequestId: crypto.randomUUID(),
      rows: detail.rows.map((row) => ({
        rowId: row.id,
        include: row.status !== "DUPLICATE",
        categoryId,
        amount: row.amount,
        date: row.date.slice(0, 10),
        note: row.description,
      })),
    },
  });
  assert.ok(commit.imported >= 2, JSON.stringify(commit));

  console.log("10. query");
  const query = await request(`/assistant/threads/${threadId}/messages`, {
    method: "POST",
    body: { text: "how much did I spend on food this month?" },
  });
  assert.equal(query.turn.intent, "QUERY");
  assert.ok(query.turn.queryResult);
  assert.ok(query.turn.queryResult.count >= 1);

  console.log("11. thinking mode + reasoning");
  const preferences = await request("/assistant/preferences", {
    method: "PUT",
    body: { autoSaveCreates: true, thinkingMode: true, reasoningEffort: "low" },
  });
  assert.equal(preferences.autoSaveCreates, true);
  assert.equal(preferences.thinkingMode, true);
  assert.equal(preferences.reasoningEffort, "low");

  const thinkingTurn = await request(`/assistant/threads/${threadId}/messages`, {
    method: "POST",
    body: { text: "spent 600 on dinner today" },
  });
  assert.ok(thinkingTurn.reasoning, "expected reasoning_content from the mock");
  assert.match(thinkingTurn.reasoning, /Mock reasoning/);

  const thinkingThread = await request(`/assistant/threads/${threadId}`);
  const reasoningMessage = thinkingThread.messages.find(
    (message) => message.id === thinkingTurn.messageId,
  );
  assert.ok(reasoningMessage?.reasoning, "expected reasoning to be stored on the message");

  console.log("12. usage");
  const usage = await request("/assistant/usage");
  assert.ok(usage.today.messages >= 5);

  console.log("13. delete account");
  await request("/auth/me", {
    method: "DELETE",
    body: { password: PASSWORD },
  });

  console.log("\nAll assistant E2E checks passed.");
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  if (token) {
    await fetch(`${BASE}/auth/me`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    }).catch(() => {});
  }
});
