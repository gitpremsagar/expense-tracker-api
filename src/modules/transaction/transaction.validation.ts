import { z } from "zod";

export const createTransactionSchema = z.object({
  amount: z.number().positive("Amount must be positive"),
  note: z.string().max(500, "Note too long").trim().optional(),
  categoryId: z.string().min(1, "Category is required"),
  date: z.string().datetime({ offset: true }).optional(),
});

export const updateTransactionSchema = z.object({
  amount: z.number().positive("Amount must be positive").optional(),
  note: z.string().max(500, "Note too long").trim().optional().nullable(),
  categoryId: z.string().min(1, "Category is required").optional(),
  date: z.string().datetime({ offset: true }).optional(),
});

export const listTransactionsSchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "month must be in YYYY-MM format")
    .optional(),
  type: z.enum(["INCOME", "EXPENSE", "SAVING", "INVESTMENT"]).optional(),
  categoryId: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;
export type ListTransactionsInput = z.infer<typeof listTransactionsSchema>;
