import { z } from "zod";

export const createCategorySchema = z.object({
  name: z.string().min(1, "Name is required").max(50, "Name too long").trim(),
  type: z.enum(["INCOME", "EXPENSE", "SAVING", "INVESTMENT"]),
  groupId: z.string().min(1).nullable().optional(),
});

export const updateCategorySchema = z
  .object({
    name: z.string().min(1, "Name is required").max(50, "Name too long").trim().optional(),
    groupId: z.string().min(1).nullable().optional(),
  })
  .refine((data) => data.name !== undefined || data.groupId !== undefined, {
    message: "Nothing to update",
  });

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
