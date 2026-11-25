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

  console.log("6b. debts, categories and groups");
  const debtTurn = await request(`/assistant/threads/${threadId}/messages`, {
    method: "POST",
    body: { text: "I borrowed 25,000 from Ramesh today" },
  });
  assert.equal(debtTurn.turn.intent, "MANAGE");
  assert.equal(debtTurn.turn.entityActions.length, 1);
  const debtAction = debtTurn.turn.entityActions[0];
  assert.equal(debtAction.entity, "DEBT");
  assert.equal(debtAction.kind, "CREATE");

  const debtConfirm = await request("/assistant/actions/confirm", {
    method: "POST",
    body: {
      clientRequestId: crypto.randomUUID(),
      threadId,
      messageId: debtTurn.messageId,
      items: [
        {
          kind: "ENTITY",
          entity: "DEBT",
          action: "CREATE",
          partyName: debtAction.after.partyName,
          amount: debtAction.after.amount,
          type: debtAction.after.type,
          date: debtAction.after.date,
          actionId: debtAction.actionId,
        },
      ],
    },
  });
  assert.equal(debtConfirm.entityCreated, 1);
  assert.equal(debtConfirm.entities[0].entity, "DEBT");

  const debts = await request("/debts");
  const ramesh = debts.debts.find((debt) => debt.partyName === "Ramesh");
  assert.ok(ramesh, "expected the debt to be saved");
  assert.equal(ramesh.outstanding, 25000);

  const savedDebtMessage = await request(`/assistant/threads/${threadId}`);
  assert.ok(
    savedDebtMessage.messages
      .find((message) => message.id === debtTurn.messageId)
      ?.turn?.savedActionIds?.includes(debtAction.actionId),
    "expected the entity action to be marked as saved",
  );

  const renameTurn = await request(`/assistant/threads/${threadId}/messages`, {
    method: "POST",
    body: { text: "rename the groceries category to Provisions" },
  });
  assert.equal(renameTurn.turn.entityActions.length, 1);
  const renameAction = renameTurn.turn.entityActions[0];
  assert.equal(renameAction.entity, "CATEGORY");
  assert.equal(renameAction.kind, "UPDATE");

  const renameConfirm = await request("/assistant/actions/confirm", {
    method: "POST",
    body: {
      clientRequestId: crypto.randomUUID(),
      threadId,
      messageId: renameTurn.messageId,
      items: [
        {
          kind: "ENTITY",
          entity: "CATEGORY",
          action: "UPDATE",
          targetId: renameAction.targetId,
          name: renameAction.changes.name,
          actionId: renameAction.actionId,
        },
      ],
    },
  });
  assert.equal(renameConfirm.entityUpdated, 1);

  const renamedCategories = await request("/categories");
  assert.ok(renamedCategories.categories.some((category) => category.name === "Provisions"));

  const categoryCreateTurn = await request(`/assistant/threads/${threadId}/messages`, {
    method: "POST",
    body: { text: "add a Pets category for expenses" },
  });
  const categoryCreateAction = categoryCreateTurn.turn.entityActions[0];
  const categoryCreateConfirm = await request("/assistant/actions/confirm", {
    method: "POST",
    body: {
      clientRequestId: crypto.randomUUID(),
      threadId,
      messageId: categoryCreateTurn.messageId,
      items: [
        {
          kind: "ENTITY",
          entity: "CATEGORY",
          action: "CREATE",
          name: categoryCreateAction.after.name,
          type: categoryCreateAction.after.type,
          actionId: categoryCreateAction.actionId,
        },
      ],
    },
  });
  assert.equal(categoryCreateConfirm.entityCreated, 1);

  const categoryDeleteTurn = await request(`/assistant/threads/${threadId}/messages`, {
    method: "POST",
    body: { text: "delete the Pets category" },
  });
  const categoryDeleteAction = categoryDeleteTurn.turn.entityActions[0];
  assert.equal(categoryDeleteAction.kind, "DELETE");
  const categoryDeleteConfirm = await request("/assistant/actions/confirm", {
    method: "POST",
    body: {
      clientRequestId: crypto.randomUUID(),
      threadId,
      messageId: categoryDeleteTurn.messageId,
      items: [
        {
          kind: "ENTITY",
          entity: "CATEGORY",
          action: "DELETE",
          targetId: categoryDeleteAction.targetId,
          actionId: categoryDeleteAction.actionId,
        },
      ],
    },
  });
  assert.equal(categoryDeleteConfirm.entityDeleted, 1);

  const afterCategoryDelete = await request("/categories");
  assert.equal(afterCategoryDelete.categories.some((category) => category.name === "Pets"), false);

  const categoryUndo = await request(`/assistant/actions/${categoryDeleteConfirm.batchId}/undo`, {
    method: "POST",
  });
  assert.equal(categoryUndo.restored, 1);
  const afterCategoryUndo = await request("/categories");
  assert.ok(afterCategoryUndo.categories.some((category) => category.name === "Pets"));

  const debtUpdateTurn = await request(`/assistant/threads/${threadId}/messages`, {
    method: "POST",
    body: { text: "increase the Ramesh loan to 30,000" },
  });
  const debtUpdateAction = debtUpdateTurn.turn.entityActions[0];
  assert.equal(debtUpdateAction.kind, "UPDATE");
  assert.equal(debtUpdateAction.changes.amount, 30000);

  const debtUpdateConfirm = await request("/assistant/actions/confirm", {
    method: "POST",
    body: {
      clientRequestId: crypto.randomUUID(),
      threadId,
      messageId: debtUpdateTurn.messageId,
      items: [
        {
          kind: "ENTITY",
          entity: "DEBT",
          action: "UPDATE",
          targetId: debtUpdateAction.targetId,
          amount: 30000,
          actionId: debtUpdateAction.actionId,
        },
      ],
    },
  });
  assert.equal(debtUpdateConfirm.entityUpdated, 1);

  const updatedDebts = await request("/debts");
  assert.equal(
    updatedDebts.debts.find((debt) => debt.id === ramesh.id)?.outstanding,
    30000,
  );

  await request(`/assistant/actions/${debtUpdateConfirm.batchId}/undo`, { method: "POST" });
  const revertedDebts = await request("/debts");
  assert.equal(
    revertedDebts.debts.find((debt) => debt.id === ramesh.id)?.outstanding,
    25000,
  );

  const groupTurn = await request(`/assistant/threads/${threadId}/messages`, {
    method: "POST",
    body: { text: "create a Household group for expenses" },
  });
  assert.equal(groupTurn.turn.entityActions[0].entity, "GROUP");
  const groupAction = groupTurn.turn.entityActions[0];
  const groupConfirm = await request("/assistant/actions/confirm", {
    method: "POST",
    body: {
      clientRequestId: crypto.randomUUID(),
      threadId,
      messageId: groupTurn.messageId,
      items: [
        {
          kind: "ENTITY",
          entity: "GROUP",
          action: "CREATE",
          name: groupAction.after.name,
          type: groupAction.after.type,
          actionId: groupAction.actionId,
        },
      ],
    },
  });
  assert.equal(groupConfirm.entityCreated, 1);

  const groups = await request("/category-groups");
  const household = groups.groups.find((group) => group.name === "Household");
  assert.ok(household, "expected the group to be saved");

  const groupRenameTurn = await request(`/assistant/threads/${threadId}/messages`, {
    method: "POST",
    body: { text: "rename the Household group" },
  });
  const groupRenameAction = groupRenameTurn.turn.entityActions[0];
  assert.equal(groupRenameAction.kind, "UPDATE");
  const groupRenameConfirm = await request("/assistant/actions/confirm", {
    method: "POST",
    body: {
      clientRequestId: crypto.randomUUID(),
      threadId,
      messageId: groupRenameTurn.messageId,
      items: [
        {
          kind: "ENTITY",
          entity: "GROUP",
          action: "UPDATE",
          targetId: groupRenameAction.targetId,
          name: "Home",
          actionId: groupRenameAction.actionId,
        },
      ],
    },
  });
  assert.equal(groupRenameConfirm.entityUpdated, 1);

  const renamedGroups = await request("/category-groups");
  assert.ok(renamedGroups.groups.some((group) => group.id === household.id && group.name === "Home"));

  const owedTurn = await request(`/assistant/threads/${threadId}/messages`, {
    method: "POST",
    body: { text: "how much do I owe Ramesh?" },
  });
  assert.equal(owedTurn.turn.intent, "QUERY");
  assert.ok(owedTurn.turn.entityQueryResult);
  assert.equal(owedTurn.turn.entityQueryResult.entity, "DEBT");
  assert.ok(owedTurn.turn.entityQueryResult.takenOutstanding >= 25000);

  const groupDeleteTurn = await request(`/assistant/threads/${threadId}/messages`, {
    method: "POST",
    body: { text: "delete the Home group" },
  });
  const groupDeleteAction = groupDeleteTurn.turn.entityActions[0];
  assert.equal(groupDeleteAction.kind, "DELETE");
  const groupDeleteConfirm = await request("/assistant/actions/confirm", {
    method: "POST",
    body: {
      clientRequestId: crypto.randomUUID(),
      threadId,
      messageId: groupDeleteTurn.messageId,
      items: [
        {
          kind: "ENTITY",
          entity: "GROUP",
          action: "DELETE",
          targetId: groupDeleteAction.targetId,
          actionId: groupDeleteAction.actionId,
        },
      ],
    },
  });
  assert.equal(groupDeleteConfirm.entityDeleted, 1);

  const afterGroupDelete = await request("/category-groups");
  assert.equal(afterGroupDelete.groups.some((group) => group.id === household.id), false);

  await request(`/assistant/actions/${groupDeleteConfirm.batchId}/undo`, { method: "POST" });
  const afterGroupUndo = await request("/category-groups");
  assert.ok(afterGroupUndo.groups.some((group) => group.id === household.id));

  await request(`/assistant/actions/${debtConfirm.batchId}/undo`, { method: "POST" });
  const afterDebtUndo = await request("/debts");
  assert.equal(afterDebtUndo.debts.some((debt) => debt.id === ramesh.id), false);

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
