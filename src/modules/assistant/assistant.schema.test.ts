import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmSchema, modelTurnSchema, preferencesSchema, statementRowsSchema } from "./assistant.schema.js";

test("preferencesSchema validates thinking controls", () => {
  const parsed = preferencesSchema.parse({
    thinkingMode: true,
    reasoningEffort: "max",
    autoSaveCreates: false,
  });
  assert.equal(parsed.thinkingMode, true);
  assert.equal(parsed.reasoningEffort, "max");
  assert.throws(() => preferencesSchema.parse({ reasoningEffort: "ultra" }));
});

test("modelTurnSchema parses a create turn and coerces numeric strings", () => {
  const turn = modelTurnSchema.parse({
    intent: "CREATE",
    reply: "Looks good",
    proposals: [
      {
        amount: "1,200",
        categoryId: "cat_1",
        date: "2026-11-21",
        note: "Groceries",
        confidence: 0.9,
      },
    ],
  });

  assert.equal(turn.proposals[0]?.amount, 1200);
  assert.equal(turn.proposals[0]?.source, "TEXT");
});

test("modelTurnSchema rejects unknown intents", () => {
  assert.throws(() => modelTurnSchema.parse({ intent: "DESTROY_EVERYTHING" }));
});

test("modelTurnSchema understands Indian amount shorthand", () => {
  const turn = modelTurnSchema.parse({
    intent: "CREATE",
    proposals: [
      { amount: "1.5 lakh", date: "2026-11-21" },
      { amount: "2k", date: "2026-11-21" },
      { amount: "1.2 cr", date: "2026-11-21" },
    ],
  });
  assert.equal(turn.proposals[0]?.amount, 150000);
  assert.equal(turn.proposals[1]?.amount, 2000);
  assert.equal(turn.proposals[2]?.amount, 12000000);
});

test("confirmSchema accepts create, update and delete in one batch", () => {
  const parsed = confirmSchema.parse({
    clientRequestId: "req-1",
    items: [
      { kind: "CREATE", amount: 450, categoryId: "cat_1", date: "2026-11-21" },
      { kind: "UPDATE", targetId: "tx_1", changes: { amount: 500 } },
      { kind: "DELETE", targetId: "tx_2" },
    ],
  });

  assert.equal(parsed.items.length, 3);
});

test("modelTurnSchema parses MANAGE entity actions for debts, categories and groups", () => {
  const turn = modelTurnSchema.parse({
    intent: "MANAGE",
    entityActions: [
      { entity: "DEBT", kind: "CREATE", partyName: "Ramesh", type: "TAKEN", amount: "25k" },
      { entity: "CATEGORY", kind: "UPDATE", targetId: "cat_1", name: "Dining" },
      { entity: "GROUP", kind: "DELETE", targetId: "grp_1" },
    ],
  });

  assert.equal(turn.entityActions[0]?.amount, 25000);
  assert.equal(turn.entityActions[0]?.confidence, 0.5);
  assert.equal(turn.entityActions.length, 3);
  assert.equal(turn.entityQuery, null);
});

test("modelTurnSchema parses entity queries", () => {
  const turn = modelTurnSchema.parse({
    intent: "QUERY",
    entityQuery: { entity: "DEBT", status: "ACTIVE", text: "Ramesh" },
  });

  assert.equal(turn.entityQuery?.entity, "DEBT");
  assert.equal(turn.entityQuery?.limit, 10);
});

test("modelTurnSchema rejects unknown entities", () => {
  assert.throws(() =>
    modelTurnSchema.parse({
      intent: "MANAGE",
      entityActions: [{ entity: "BUDGET", kind: "CREATE", name: "Food" }],
    }),
  );
});

test("confirmSchema accepts entity items next to transactions", () => {
  const parsed = confirmSchema.parse({
    clientRequestId: "req-2",
    items: [
      { kind: "CREATE", amount: 450, categoryId: "cat_1", date: "2026-11-21" },
      {
        kind: "ENTITY",
        entity: "DEBT",
        action: "CREATE",
        partyName: "Ramesh",
        type: "TAKEN",
        amount: 25000,
        date: "2026-11-21",
      },
      { kind: "ENTITY", entity: "CATEGORY", action: "DELETE", targetId: "cat_2" },
    ],
  });

  assert.equal(parsed.items.length, 3);
});

test("statementRowsSchema validates rows and defaults confidence", () => {
  const parsed = statementRowsSchema.parse({
    rows: [{ date: "2026-11-01", amount: 450, description: "UPI/SWIGGY" }],
  });
  assert.equal(parsed.rows[0]?.confidence, 0.5);
});
