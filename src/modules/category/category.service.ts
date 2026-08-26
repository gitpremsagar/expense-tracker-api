import type { CategoryType } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../utils/errors.js";
import type { CreateCategoryInput, UpdateCategoryInput } from "./category.validation.js";

export async function createCategory(userId: string, input: CreateCategoryInput) {
  const existing = await prisma.category.findUnique({
    where: { userId_name_type: { userId, name: input.name, type: input.type } },
  });

  if (existing) {
    throw new ConflictError(`A ${input.type.toLowerCase()} category named "${input.name}" already exists`);
  }

  return prisma.category.create({
    data: {
      name: input.name,
      type: input.type,
      userId,
    },
  });
}

export async function listCategories(userId: string, type?: CategoryType) {
  return prisma.category.findMany({
    where: { userId, ...(type ? { type } : {}) },
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });
}

export async function updateCategory(userId: string, categoryId: string, input: UpdateCategoryInput) {
  const category = await prisma.category.findUnique({ where: { id: categoryId } });

  if (!category) {
    throw new NotFoundError("Category not found");
  }

  if (category.userId !== userId) {
    throw new ForbiddenError("You do not own this category");
  }

  const existing = await prisma.category.findUnique({
    where: { userId_name_type: { userId, name: input.name, type: category.type } },
  });

  if (existing && existing.id !== categoryId) {
    throw new ConflictError(`A ${category.type.toLowerCase()} category named "${input.name}" already exists`);
  }

  return prisma.category.update({
    where: { id: categoryId },
    data: { name: input.name },
  });
}

export async function deleteCategory(userId: string, categoryId: string) {
  const category = await prisma.category.findUnique({
    where: { id: categoryId },
    include: { _count: { select: { transactions: true } } },
  });

  if (!category) {
    throw new NotFoundError("Category not found");
  }

  if (category.userId !== userId) {
    throw new ForbiddenError("You do not own this category");
  }

  if (category._count.transactions > 0) {
    throw new ConflictError(
      "Cannot delete category with existing transactions. Reassign or delete the transactions first.",
    );
  }

  await prisma.category.delete({ where: { id: categoryId } });
}
