import type { CategoryType } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

type StarterGroup = {
  name: string;
  type: CategoryType;
  categories: string[];
};

const STARTER_GROUPS: StarterGroup[] = [
  {
    name: "Essentials",
    type: "EXPENSE",
    categories: ["Groceries", "Rent", "Utilities", "Transport"],
  },
  {
    name: "Lifestyle",
    type: "EXPENSE",
    categories: ["Food & Dining", "Shopping", "Entertainment"],
  },
  {
    name: "Health & Learning",
    type: "EXPENSE",
    categories: ["Health", "Education"],
  },
  {
    name: "Earnings",
    type: "INCOME",
    categories: ["Salary", "Business", "Freelance"],
  },
  {
    name: "Goals",
    type: "SAVING",
    categories: ["Emergency Fund", "Travel Fund", "General Savings"],
  },
  {
    name: "Wealth",
    type: "INVESTMENT",
    categories: ["Mutual Funds", "Stocks", "Fixed Deposit", "Gold", "Retirement"],
  },
];

const STARTER_UNGROUPED: { name: string; type: CategoryType }[] = [
  { name: "Insurance", type: "EXPENSE" },
  { name: "Other", type: "EXPENSE" },
  { name: "Interest", type: "INCOME" },
  { name: "Gifts", type: "INCOME" },
  { name: "Other Income", type: "INCOME" },
];

export const STARTER_CATEGORY_COUNT =
  STARTER_GROUPS.reduce((sum, group) => sum + group.categories.length, 0) +
  STARTER_UNGROUPED.length;

/**
 * Adds the starter groups/categories to an account that has no categories yet.
 * Safe to call more than once: it becomes a no-op as soon as a category exists.
 */
export async function addStarterCategories(userId: string): Promise<{ created: number }> {
  const existing = await prisma.category.count({ where: { userId } });
  if (existing > 0) {
    return { created: 0 };
  }

  let created = 0;

  for (const group of STARTER_GROUPS) {
    const createdGroup = await prisma.categoryGroup.create({
      data: { name: group.name, type: group.type, userId },
    });

    for (const name of group.categories) {
      await prisma.category.create({
        data: {
          name,
          type: group.type,
          userId,
          groupId: createdGroup.id,
        },
      });
      created += 1;
    }
  }

  for (const category of STARTER_UNGROUPED) {
    await prisma.category.create({
      data: {
        name: category.name,
        type: category.type,
        userId,
        groupId: null,
      },
    });
    created += 1;
  }

  return { created };
}
