import { z } from "zod";

export const categoryTypeSchema = z.enum(["INCOME", "EXPENSE", "SAVING", "INVESTMENT"]);
export type AssistantCategoryType = z.infer<typeof categoryTypeSchema>;

export const ASSISTANT_INTENTS = [
  "ADD_TRANSACTIONS",
  "CLARIFY",
  "UNSUPPORTED",
  "QUERY",
  "EDIT_TRANSACTIONS",
  "DELETE_TRANSACTIONS",
  "DEBT_PAYMENT",
] as const;

export type AssistantIntent = (typeof ASSISTANT_INTENTS)[number];

const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (timeZone) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone }).format();
        return true;
      } catch {
        return false;
      }
    },
    { message: "timezone must be a valid IANA timezone" },
  );

const historyMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(2000),
});

export const parseMessageSchema = z.object({
  message: z.string().trim().min(1, "Message is required").max(1000, "Message is too long"),
  history: z.array(historyMessageSchema).max(8).optional().default([]),
  timezone: timezoneSchema.optional().default("Asia/Kolkata"),
  now: z.string().datetime({ offset: true }).optional(),
  conversationId: z.string().min(1).max(100).optional(),
});

export type ParseMessageInput = z.infer<typeof parseMessageSchema>;

const newCategorySchema = z.object({
  name: z.string().trim().min(1, "Category name is required").max(60, "Category name is too long"),
  type: categoryTypeSchema,
});

const confirmProposalSchema = z
  .object({
    amount: z.coerce.number().finite().positive("Amount must be positive").max(1_000_000_000),
    categoryId: z.string().min(1).nullable().optional(),
    newCategory: newCategorySchema.nullable().optional(),
    note: z.string().trim().max(500, "Note is too long").nullable().optional(),
    date: z.string().datetime({ offset: true }).optional(),
  })
  .refine((proposal) => Boolean(proposal.categoryId || proposal.newCategory), {
    message: "Each transaction needs a categoryId or a newCategory",
    path: ["categoryId"],
  });

export const confirmProposalsSchema = z.object({
  proposals: z
    .array(confirmProposalSchema)
    .min(1, "At least one transaction is required")
    .max(10, "You can save up to 10 transactions at once"),
  requestId: z.string().min(1).max(100).optional(),
  conversationId: z.string().min(1).max(100).optional(),
});

export type ConfirmProposalsInput = z.infer<typeof confirmProposalsSchema>;
export type ConfirmProposalInput = z.infer<typeof confirmProposalSchema>;

export const operationActionSchema = z.enum(["UPDATE", "DELETE"]);

const applyOperationSchema = z
  .object({
    action: operationActionSchema,
    transactionId: z.string().min(1),
    amount: z.coerce.number().finite().positive().max(1_000_000_000).optional(),
    categoryId: z.string().min(1).nullable().optional(),
    newCategory: newCategorySchema.nullable().optional(),
    date: z.string().datetime({ offset: true }).optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .refine(
    (operation) =>
      operation.action === "DELETE" ||
      operation.amount !== undefined ||
      operation.categoryId !== undefined ||
      operation.newCategory !== undefined ||
      operation.date !== undefined ||
      operation.note !== undefined,
    { message: "An update operation needs at least one field to change" },
  );

const applyDebtPaymentSchema = z.object({
  debtId: z.string().min(1),
  amount: z.coerce.number().finite().positive().max(1_000_000_000),
  date: z.string().datetime({ offset: true }).optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

export const applyActionsSchema = z
  .object({
    operations: z.array(applyOperationSchema).max(10).optional().default([]),
    debtPayments: z.array(applyDebtPaymentSchema).max(5).optional().default([]),
    requestId: z.string().min(1).max(100).optional(),
    conversationId: z.string().min(1).max(100).optional(),
  })
  .refine(
    (input) => input.operations.length + input.debtPayments.length > 0,
    { message: "There is nothing to apply" },
  );

export type ApplyActionsInput = z.infer<typeof applyActionsSchema>;
export type ApplyOperationInput = z.infer<typeof applyOperationSchema>;
export type ApplyDebtPaymentInput = z.infer<typeof applyDebtPaymentSchema>;

export const undoActionsSchema = z.object({
  transactionIds: z
    .array(z.string().min(1))
    .min(1, "There is nothing to undo")
    .max(10, "You can undo up to 10 transactions at once"),
  requestId: z.string().min(1).max(100).optional(),
});

export type UndoActionsInput = z.infer<typeof undoActionsSchema>;

export const assistantPreferencesSchema = z.object({
  autoSave: z.boolean(),
});

export type AssistantPreferencesInput = z.infer<typeof assistantPreferencesSchema>;

export const listConversationsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

// ─── Model output ──────────────────────────────────────────────────────────────

const modelTransactionSchema = z.object({
  amount: z.coerce.number().finite().positive().max(1_000_000_000),
  type: z.string().optional(),
  categoryId: z.string().nullable().optional(),
  suggestedCategoryName: z.string().trim().max(80).nullable().optional(),
  date: z.string().nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  confidence: z.coerce.number().nullable().optional(),
});

export const modelOperationSchema = z.object({
  action: z.string().optional(),
  transactionId: z.string().trim().min(1).max(100),
  amount: z.coerce.number().finite().positive().max(1_000_000_000).nullable().optional(),
  categoryId: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  confidence: z.coerce.number().nullable().optional(),
});

export const modelDebtPaymentSchema = z.object({
  debtId: z.string().nullable().optional(),
  partyName: z.string().trim().max(120).nullable().optional(),
  amount: z.coerce.number().finite().positive().max(1_000_000_000),
  date: z.string().nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  confidence: z.coerce.number().nullable().optional(),
});

export const modelQuerySchema = z.object({
  metric: z.string().optional(),
  types: z.array(z.string()).max(4).optional(),
  categoryIds: z.array(z.string()).max(20).optional(),
  categoryNames: z.array(z.string().trim().max(80)).max(20).optional(),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const modelResponseSchema = z.object({
  intent: z.string().optional(),
  reply: z.string().max(1000).optional(),
  transactions: z.array(modelTransactionSchema).max(20).optional().default([]),
  operations: z.array(modelOperationSchema).max(20).optional().default([]),
  debtPayment: modelDebtPaymentSchema.nullable().optional(),
  query: modelQuerySchema.nullable().optional(),
  clarifications: z.array(z.string().max(300)).max(6).optional().default([]),
});

export type ModelResponse = z.infer<typeof modelResponseSchema>;
export type ModelTransaction = z.infer<typeof modelTransactionSchema>;
export type ModelOperation = z.infer<typeof modelOperationSchema>;
export type ModelDebtPayment = z.infer<typeof modelDebtPaymentSchema>;
export type ModelQuery = z.infer<typeof modelQuerySchema>;
