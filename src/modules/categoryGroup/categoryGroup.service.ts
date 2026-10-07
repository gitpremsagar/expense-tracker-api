import type { CategoryType } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../utils/errors.js";
import type {
  CreateCategoryGroupInput,
  UpdateCategoryGroupInput,
} from "./categoryGroup.validation.js";

async function getOwnedGroup(userId: string, groupId: string) {
  const group = await prisma.categoryGroup.findUnique({ where: { id: groupId } });

  if (!group) {
    throw new NotFoundError("Category group not found");
  }

  if (group.userId !== userId) {
    throw new ForbiddenError("You do not own this category group");
  }

  return group;
}

export async function createGroup(userId: string, input: CreateCategoryGroupInput) {
  const existing = await prisma.categoryGroup.findUnique({
    where: { userId_name_type: { userId, name: input.name, type: input.type } },
  });

  if (existing) {
    throw new ConflictError(`A ${input.type.toLowerCase()} group named "${input.name}" already exists`);
  }

  return prisma.categoryGroup.create({
    data: { name: input.name, type: input.type, userId },
  });
}

export async function listGroups(userId: string, type?: CategoryType) {
  return prisma.categoryGroup.findMany({
    where: { userId, ...(type ? { type } : {}) },
    include: {
      categories: { select: { id: true, name: true }, orderBy: { name: "asc" } },
    },
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });
}

export async function updateGroup(userId: string, groupId: string, input: UpdateCategoryGroupInput) {
  const group = await getOwnedGroup(userId, groupId);

  const existing = await prisma.categoryGroup.findUnique({
    where: { userId_name_type: { userId, name: input.name, type: group.type } },
  });

  if (existing && existing.id !== groupId) {
    throw new ConflictError(`A ${group.type.toLowerCase()} group named "${input.name}" already exists`);
  }

  return prisma.categoryGroup.update({
    where: { id: groupId },
    data: { name: input.name },
  });
}

export async function deleteGroup(userId: string, groupId: string) {
  await getOwnedGroup(userId, groupId);

  await prisma.$transaction([
    prisma.category.updateMany({ where: { groupId, userId }, data: { groupId: null } }),
    prisma.categoryGroup.delete({ where: { id: groupId } }),
  ]);
}
