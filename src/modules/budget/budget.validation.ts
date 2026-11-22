import { z } from "zod";

export const budgetMonthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, "month must be in YYYY-MM format");

export const listBudgetsSchema = z.object({
  month: budgetMonthSchema.optional(),
});

export const upsertBudgetSchema = z.object({
  month: budgetMonthSchema,
  scope: z.string().min(1, "Budget scope is required"),
  amount: z.number().positive("Budget must be greater than zero"),
});

export type ListBudgetsInput = z.infer<typeof listBudgetsSchema>;
export type UpsertBudgetInput = z.infer<typeof upsertBudgetSchema>;
