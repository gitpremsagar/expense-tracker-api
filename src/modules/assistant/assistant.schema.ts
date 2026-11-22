import { z } from "zod";

export const categoryTypeSchema = z.enum(["INCOME", "EXPENSE", "SAVING", "INVESTMENT"]);
export type CategoryTypeValue = z.infer<typeof categoryTypeSchema>;

const numberish = z.preprocess((value) => {
  if (typeof value === "string") {
    let text = value.trim().toLowerCase().replace(/[₹,\s]/g, "");
    let multiplier = 1;

    if (text.endsWith("lakh") || text.endsWith("lac")) {
      multiplier = 100_000;
      text = text.replace(/(lakh|lac)$/, "");
    } else if (text.endsWith("crore") || text.endsWith("cr")) {
      multiplier = 10_000_000;
      text = text.replace(/(crore|cr)$/, "");
    } else if (text.endsWith("k")) {
      multiplier = 1_000;
      text = text.replace(/k$/, "");
    }

    text = text.replace(/[a-z]/g, "");
    if (text.length === 0) return value;

    const parsed = Number(text) * multiplier;
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}, z.number().finite());

const dateish = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.string().min(4),
);

export const proposalSchema = z.object({
  proposalId: z.string().optional(),
  amount: numberish,
  type: categoryTypeSchema.optional(),
  categoryId: z.string().nullable().optional(),
  suggestedCategoryName: z.string().max(80).nullable().optional(),
  date: dateish,
  note: z.string().max(500).optional().default(""),
  confidence: z.number().min(0).max(1).optional().default(0.5),
  source: z.enum(["TEXT", "IMAGE", "AUDIO"]).optional().default("TEXT"),
});

export const operationChangesSchema = z.object({
  amount: numberish.optional(),
  categoryId: z.string().optional(),
  date: dateish.optional(),
  note: z.string().max(500).nullable().optional(),
});

export const operationSchema = z.object({
  operationId: z.string().optional(),
  kind: z.enum(["UPDATE", "DELETE"]),
  targetId: z.string().min(1),
  changes: operationChangesSchema.optional().default({}),
  confidence: z.number().min(0).max(1).optional().default(0.5),
});

export const queryFiltersSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  types: z.array(categoryTypeSchema).optional(),
  categoryIds: z.array(z.string()).optional(),
  text: z.string().max(100).optional(),
  minAmount: z.number().nonnegative().optional(),
  maxAmount: z.number().nonnegative().optional(),
});

export const querySpecSchema = z.object({
  filters: queryFiltersSchema.default({}),
  groupBy: z.enum(["day", "week", "month", "category"]).optional(),
  aggregate: z.enum(["SUM", "COUNT", "AVG", "LIST"]).optional().default("SUM"),
});

export const modelTurnSchema = z.object({
  intent: z.enum(["CREATE", "UPDATE", "DELETE", "QUERY", "IMPORT", "CLARIFY", "UNSUPPORTED"]),
  reply: z.string().max(1_500).optional().default(""),
  proposals: z.array(proposalSchema).max(20).optional().default([]),
  operations: z.array(operationSchema).max(20).optional().default([]),
  query: querySpecSchema.nullable().optional().default(null),
  clarifications: z.array(z.string().max(300)).max(5).optional().default([]),
});

export type ModelTurn = z.infer<typeof modelTurnSchema>;
export type ModelProposal = z.infer<typeof proposalSchema>;
export type ModelOperation = z.infer<typeof operationSchema>;
export type QuerySpec = z.infer<typeof querySpecSchema>;

export const parseMessageSchema = z.object({
  text: z.string().trim().min(1, "Type a message first").max(5_000),
  timezone: z.string().optional(),
});

export const createThreadSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
});

export const preferencesSchema = z.object({
  autoSaveCreates: z.boolean().optional(),
  thinkingMode: z.boolean().optional(),
  reasoningEffort: z.enum(["low", "high", "max"]).optional(),
  timezone: z.string().optional(),
});

export const confirmCreateItemSchema = z.object({
  kind: z.literal("CREATE"),
  amount: z.number().positive(),
  categoryId: z.string().optional().nullable(),
  newCategoryName: z.string().trim().min(1).max(60).optional().nullable(),
  newCategoryType: categoryTypeSchema.optional(),
  date: z.string().min(4),
  note: z.string().max(500).optional(),
  source: z.enum(["TEXT", "IMAGE", "AUDIO", "IMPORT"]).optional(),
  proposalId: z.string().optional(),
});

export const confirmUpdateItemSchema = z.object({
  kind: z.literal("UPDATE"),
  targetId: z.string().min(1),
  changes: operationChangesSchema,
  operationId: z.string().optional(),
});

export const confirmDeleteItemSchema = z.object({
  kind: z.literal("DELETE"),
  targetId: z.string().min(1),
  operationId: z.string().optional(),
});

export const confirmItemSchema = z.discriminatedUnion("kind", [
  confirmCreateItemSchema,
  confirmUpdateItemSchema,
  confirmDeleteItemSchema,
]);

export const confirmSchema = z.object({
  clientRequestId: z.string().trim().min(1).max(100),
  threadId: z.string().optional(),
  messageId: z.string().optional(),
  timezone: z.string().optional(),
  items: z.array(confirmItemSchema).min(1).max(50),
});

export type ConfirmItem = z.infer<typeof confirmItemSchema>;

export const statementRowSchema = z.object({
  date: z.string().min(4),
  amount: numberish,
  type: categoryTypeSchema.optional(),
  description: z.string().max(300).optional().default(""),
  categoryId: z.string().nullable().optional(),
  suggestedCategoryName: z.string().max(80).nullable().optional(),
  confidence: z.number().min(0).max(1).optional().default(0.5),
});

export const statementRowsSchema = z.object({
  rows: z.array(statementRowSchema).max(80),
});

export type StatementRow = z.infer<typeof statementRowSchema>;

export const importCommitSchema = z.object({
  clientRequestId: z.string().trim().min(1).max(100),
  timezone: z.string().optional(),
  rows: z
    .array(
      z.object({
        rowId: z.string().min(1),
        include: z.boolean().default(true),
        amount: z.number().positive().optional(),
        categoryId: z.string().optional().nullable(),
        newCategoryName: z.string().trim().min(1).max(60).optional().nullable(),
        newCategoryType: categoryTypeSchema.optional(),
        date: z.string().optional(),
        note: z.string().max(500).optional(),
      }),
    )
    .max(500),
});

export type ImportCommitRow = z.infer<typeof importCommitSchema>["rows"][number];

export const importListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  status: z.enum(["all", "PENDING", "DUPLICATE", "IMPORTED", "SKIPPED"]).default("all"),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export const threadListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(50).default(20),
});
