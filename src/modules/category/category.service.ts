import type { CategoryType } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../utils/errors.js";
import type { CreateCategoryInput, UpdateCategoryInput } from "./category.validation.js";

async function assertGroupAssignable(userId: string, groupId: string, type: CategoryType) {
  const group = await prisma.categoryGroup.findUnique({ where: { id: groupId } });

  if (!group) {
    throw new NotFoundError("Category group not found");
  }

  if (group.userId !== userId) {
    throw new ForbiddenError("You do not own this category group");
  }

  if (group.type !== type) {
    throw new BadRequestError(
      `Cannot add a ${type.toLowerCase()} category to a ${group.type.toLowerCase()} group`,
    );
  }
}

export async function createCategory(userId: string, input: CreateCategoryInput) {
  const existing = await prisma.category.findUnique({
    where: { userId_name_type: { userId, name: input.name, type: input.type } },
  });

  if (existing) {
    throw new ConflictError(`A ${input.type.toLowerCase()} category named "${input.name}" already exists`);
  }

  if (input.groupId) {
    await assertGroupAssignable(userId, input.groupId, input.type);
  }

  return prisma.category.create({
    data: {
      name: input.name,
      type: input.type,
      userId,
      groupId: input.groupId ?? null,
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

  if (input.name !== undefined) {
    const existing = await prisma.category.findUnique({
      where: { userId_name_type: { userId, name: input.name, type: category.type } },
    });

    if (existing && existing.id !== categoryId) {
      throw new ConflictError(`A ${category.type.toLowerCase()} category named "${input.name}" already exists`);
    }
  }

  if (input.groupId) {
    await assertGroupAssignable(userId, input.groupId, category.type);
  }

  return prisma.category.update({
    where: { id: categoryId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
    },
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
