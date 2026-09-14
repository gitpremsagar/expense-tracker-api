import { z } from "zod";

export const createDebtSchema = z.object({
  type: z.enum(["TAKEN", "GIVEN"]),
  partyName: z.string().min(1, "Party name is required").max(200, "Party name too long").trim(),
  amount: z.number().positive("Amount must be positive"),
  description: z.string().max(500, "Description too long").trim().optional(),
  date: z.string().datetime({ offset: true }).optional(),
});

export const updateDebtSchema = z.object({
  type: z.enum(["TAKEN", "GIVEN"]).optional(),
  partyName: z.string().min(1, "Party name is required").max(200, "Party name too long").trim().optional(),
  amount: z.number().positive("Amount must be positive").optional(),
  description: z.string().max(500, "Description too long").trim().optional().nullable(),
  date: z.string().datetime({ offset: true }).optional(),
  status: z.enum(["ACTIVE", "SETTLED"]).optional(),
});

export const listDebtsSchema = z.object({
  type: z.enum(["TAKEN", "GIVEN"]).optional(),
  status: z.enum(["ACTIVE", "SETTLED"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export type CreateDebtInput = z.infer<typeof createDebtSchema>;
export type UpdateDebtInput = z.infer<typeof updateDebtSchema>;
export type ListDebtsInput = z.infer<typeof listDebtsSchema>;
