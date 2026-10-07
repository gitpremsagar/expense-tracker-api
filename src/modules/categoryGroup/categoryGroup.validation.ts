import { z } from "zod";

export const createCategoryGroupSchema = z.object({
  name: z.string().min(1, "Name is required").max(50, "Name too long").trim(),
  type: z.enum(["INCOME", "EXPENSE", "SAVING", "INVESTMENT"]),
});

export const updateCategoryGroupSchema = z.object({
  name: z.string().min(1, "Name is required").max(50, "Name too long").trim(),
});

export type CreateCategoryGroupInput = z.infer<typeof createCategoryGroupSchema>;
export type UpdateCategoryGroupInput = z.infer<typeof updateCategoryGroupSchema>;
