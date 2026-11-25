import { randomUUID } from "node:crypto";
import type { CategoryType, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../utils/errors.js";
import { roundMoney } from "../../utils/date.js";
import type { AssistantCategory, AssistantDebt, AssistantGroup } from "./assistant.prompt.js";
import type {
  ConfirmItem,
  EntityQuerySpec,
  ModelEntityAction,
} from "./assistant.schema.js";
import { normalizeDateValue } from "./assistant.time.js";

export type EntityKind = "DEBT" | "CATEGORY" | "GROUP";
export type DebtDirection = "TAKEN" | "GIVEN";

/**
 * A plain snapshot that can be stored as JSON for undo and rendered by the
 * client. Every entity reuses the same shape; `entity` says which fields count.
 */
export type EntitySnapshot = {
  entity: EntityKind;
  id: string;
  type?: DebtDirection | CategoryType;
  partyName?: string;
  amount?: number;
  description?: string | null;
  date?: string;
  status?: string;
  paidAmount?: number;
  outstanding?: number;
  paymentCount?: number;
  name?: string;
  groupId?: string | null;
  groupName?: string | null;
  transactionCount?: number;
  categoryCount?: number;
  memberIds?: string[];
};

export type EntityChanges = {
  type?: DebtDirection | CategoryType;
  partyName?: string;
  amount?: number;
  description?: string | null;
  date?: string;
  name?: string;
  groupId?: string | null;
};

export type AssistantEntityAction = {
  actionId: string;
  entity: EntityKind;
  kind: "CREATE" | "UPDATE" | "DELETE";
  targetId: string | null;
  before: EntitySnapshot | null;
  after: EntitySnapshot | null;
  changes: EntityChanges;
  confidence: number;
};

export type EntityUndoOperation = {
  kind: "CREATE" | "UPDATE" | "DELETE";
  entity: EntityKind;
  targetId: string;
  before: EntitySnapshot | null;
  after: EntitySnapshot | null;
};

export type EntityQueryResult = {
  entity: EntityKind;
  count: number;
  total: number;
  items: Array<{ id: string; title: string; subtitle: string; amount?: number }>;
  takenOutstanding?: number;
  givenOutstanding?: number;
};

export type ConfirmEntityItem = Extract<ConfirmItem, { kind: "ENTITY" }>;

const MAX_ENTITY_ACTIONS = 5;
const EPSILON = 0.005;
const CATEGORY_TYPES = ["INCOME", "EXPENSE", "SAVING", "INVESTMENT"] as const;

function round(value: number) {
  return roundMoney(value);
}

function asCategoryType(value: string | undefined): CategoryType | null {
  const upper = value?.trim().toUpperCase();
  return (CATEGORY_TYPES as readonly string[]).includes(upper ?? "")
    ? (upper as CategoryType)
    : null;
}

function asDebtDirection(value: string | undefined): DebtDirection | null {
  const upper = value?.trim().toUpperCase();
  return upper === "TAKEN" || upper === "GIVEN" ? upper : null;
}

function dateFromItem(value: string | undefined, timeZone: string): Date | null {
  if (!value) return null;
  return normalizeDateValue(value, timeZone);
}

function paidAmountOf(payments: { amount: number }[]) {
  return round(payments.reduce((sum, payment) => sum + payment.amount, 0));
}

function debtSnapshot(debt: {
  id: string;
  type: DebtDirection;
  partyName: string;
  amount: number;
  description: string | null;
  date: Date;
  status: string;
  payments: { amount: number }[];
}): EntitySnapshot {
  const paidAmount = paidAmountOf(debt.payments);
  return {
    entity: "DEBT",
    id: debt.id,
    type: debt.type,
    partyName: debt.partyName,
    amount: round(debt.amount),
    description: debt.description,
    date: debt.date.toISOString(),
    status: debt.status,
    paidAmount,
    outstanding: round(Math.max(0, debt.amount - paidAmount)),
    paymentCount: debt.payments.length,
  };
}

function categorySnapshot(category: {
  id: string;
  name: string;
  type: CategoryType;
  groupId: string | null;
  group?: { name: string } | null;
  _count?: { transactions: number };
}): EntitySnapshot {
  return {
    entity: "CATEGORY",
    id: category.id,
    name: category.name,
    type: category.type,
    groupId: category.groupId,
    groupName: category.group?.name ?? null,
    transactionCount: category._count?.transactions ?? 0,
  };
}

function groupSnapshot(group: {
  id: string;
  name: string;
  type: CategoryType;
  categories?: { id: string }[];
}): EntitySnapshot {
  return {
    entity: "GROUP",
    id: group.id,
    name: group.name,
    type: group.type,
    categoryCount: group.categories?.length ?? 0,
    memberIds: group.categories?.map((category) => category.id) ?? [],
  };
}

async function findGroup(
  tx: Prisma.TransactionClient,
  userId: string,
  groupId: string,
) {
  const group = await tx.categoryGroup.findUnique({ where: { id: groupId } });
  if (!group) throw new NotFoundError("That category group no longer exists");
  if (group.userId !== userId) throw new ForbiddenError("You do not own that category group");
  return group;
}

function assertGroupType(group: { type: CategoryType; name: string }, type: CategoryType) {
  if (group.type !== type) {
    throw new BadRequestError(
      `"${group.name}" is a ${group.type.toLowerCase()} group, so a ${type.toLowerCase()} category cannot go in it`,
    );
  }
}

/**
 * Turns the model's requested entity actions into reviewable cards. Missing or
 * ambiguous targets become clarifications instead of writes.
 */
export async function normalizeEntityActions(input: {
  actions: ModelEntityAction[];
  userId: string;
  timeZone: string;
  categories: AssistantCategory[];
  groups: AssistantGroup[];
  debts: AssistantDebt[];
}): Promise<{ actions: AssistantEntityAction[]; clarifications: string[] }> {
  const actions: AssistantEntityAction[] = [];
  const clarifications: string[] = [];
  const categoryIds = new Set(input.categories.map((category) => category.id));
  const groupIds = new Set(input.groups.map((group) => group.id));
  const debtIds = new Set(input.debts.map((debt) => debt.id));

  for (const action of input.actions.slice(0, MAX_ENTITY_ACTIONS)) {
    const confidence = Math.min(1, Math.max(0, action.confidence ?? 0.5));
    const targetId = action.targetId?.trim() || null;

    if (action.entity === "DEBT") {
      if (action.kind === "CREATE") {
        const partyName = action.partyName?.trim();
        const direction = asDebtDirection(action.type) ?? "TAKEN";
        const amount = round(Number(action.amount));

        if (!partyName) {
          clarifications.push("Who is the debt with?");
          continue;
        }
        if (!Number.isFinite(amount) || amount <= 0 || amount > 10_00_00_000) {
          clarifications.push("What is the debt amount?");
          continue;
        }

        const date = dateFromItem(action.date, input.timeZone) ?? new Date();
        const after: EntitySnapshot = {
          entity: "DEBT",
          id: "",
          type: direction,
          partyName,
          amount,
          description: action.description?.trim() || null,
          date: date.toISOString(),
          status: "ACTIVE",
          paidAmount: 0,
          outstanding: amount,
          paymentCount: 0,
        };

        actions.push({
          actionId: randomUUID(),
          entity: "DEBT",
          kind: "CREATE",
          targetId: null,
          before: null,
          after,
          changes: {
            type: direction,
            partyName,
            amount,
            description: after.description ?? null,
            date: after.date ?? date.toISOString(),
          },
          confidence,
        });
        continue;
      }

      if (!targetId || !debtIds.has(targetId)) {
        clarifications.push("Which debt do you mean?");
        continue;
      }

      const debt = await prisma.debt.findUnique({
        where: { id: targetId },
        include: { payments: { select: { amount: true } } },
      });

      if (!debt || debt.userId !== input.userId) {
        clarifications.push("I could not find that debt.");
        continue;
      }

      const before = debtSnapshot(debt);

      if (action.kind === "DELETE") {
        if ((before.paymentCount ?? 0) > 0) {
          clarifications.push(
            `"${debt.partyName}" already has payments. Remove those payments before deleting the debt.`,
          );
          continue;
        }

        actions.push({
          actionId: randomUUID(),
          entity: "DEBT",
          kind: "DELETE",
          targetId: debt.id,
          before,
          after: null,
          changes: {},
          confidence,
        });
        continue;
      }

      const direction = action.type ? asDebtDirection(action.type) : null;
      const amount = action.amount !== undefined ? round(Number(action.amount)) : debt.amount;
      const partyName = action.partyName?.trim() || debt.partyName;
      const date = dateFromItem(action.date, input.timeZone) ?? debt.date;

      if (!Number.isFinite(amount) || amount <= 0) {
        clarifications.push("That debt amount is not valid.");
        continue;
      }
      if (amount + EPSILON < (before.paidAmount ?? 0)) {
        clarifications.push(
          `"${debt.partyName}" already has ${before.paidAmount} paid, so the amount cannot be lower.`,
        );
        continue;
      }

      const changes: EntityChanges = {};
      if (direction && direction !== debt.type) changes.type = direction;
      if (partyName !== debt.partyName) changes.partyName = partyName;
      if (amount !== debt.amount) changes.amount = amount;
      if (action.description !== undefined && action.description !== debt.description) {
        changes.description = action.description?.trim() || null;
      }
      if (date.getTime() !== debt.date.getTime()) changes.date = date.toISOString();

      if (Object.keys(changes).length === 0) {
        clarifications.push("What should change on that debt?");
        continue;
      }

      actions.push({
        actionId: randomUUID(),
        entity: "DEBT",
        kind: "UPDATE",
        targetId: debt.id,
        before,
        after: {
          ...before,
          type: direction ?? debt.type,
          partyName,
          amount,
          description:
            action.description !== undefined
              ? action.description?.trim() || null
              : debt.description,
          date: date.toISOString(),
          outstanding: round(Math.max(0, amount - (before.paidAmount ?? 0))),
        },
        changes,
        confidence,
      });
      continue;
    }

    if (action.entity === "CATEGORY") {
      if (action.kind === "CREATE") {
        const name = action.name?.trim() || action.partyName?.trim() || "";
        const type = asCategoryType(action.type);
        if (!name) {
          clarifications.push("What should the category be called?");
          continue;
        }
        if (!type) {
          clarifications.push(`Is "${name}" an expense, income, saving or investment category?`);
          continue;
        }

        const existing = input.categories.find(
          (category) => category.name.toLowerCase() === name.toLowerCase() && category.type === type,
        );
        if (existing) {
          clarifications.push(`You already have a ${type.toLowerCase()} category named "${name}".`);
          continue;
        }

        const groupName = action.groupName?.trim() || null;
        const group = action.groupId
          ? input.groups.find((candidate) => candidate.id === action.groupId)
          : groupName
            ? input.groups.find(
                (candidate) =>
                  candidate.name.toLowerCase() === groupName.toLowerCase() && candidate.type === type,
              )
            : undefined;

        if (action.groupId && !groupIds.has(action.groupId)) {
          clarifications.push("I could not find that category group.");
          continue;
        }
        if (groupName && !group) {
          clarifications.push(`I could not find a ${type.toLowerCase()} group named "${groupName}".`);
          continue;
        }
        if (group && group.type !== type) {
          clarifications.push(`"${group.name}" is a ${group.type.toLowerCase()} group.`);
          continue;
        }

        const after: EntitySnapshot = {
          entity: "CATEGORY",
          id: "",
          name,
          type,
          groupId: group?.id ?? null,
          groupName: group?.name ?? null,
          transactionCount: 0,
        };

        actions.push({
          actionId: randomUUID(),
          entity: "CATEGORY",
          kind: "CREATE",
          targetId: null,
          before: null,
          after,
          changes: {
            name,
            type,
            groupId: after.groupId ?? null,
          },
          confidence,
        });
        continue;
      }

      if (!targetId || !categoryIds.has(targetId)) {
        clarifications.push("Which category do you mean?");
        continue;
      }

      const category = await prisma.category.findUnique({
        where: { id: targetId },
        include: { group: { select: { name: true } }, _count: { select: { transactions: true } } },
      });

      if (!category || category.userId !== input.userId) {
        clarifications.push("I could not find that category.");
        continue;
      }

      const before = categorySnapshot(category);

      if (action.kind === "DELETE") {
        if (category._count.transactions > 0) {
          clarifications.push(
            `"${category.name}" is used by ${category._count.transactions} transaction${
              category._count.transactions === 1 ? "" : "s"
            }, so it cannot be deleted. Move them to another category first.`,
          );
          continue;
        }

        actions.push({
          actionId: randomUUID(),
          entity: "CATEGORY",
          kind: "DELETE",
          targetId: category.id,
          before,
          after: null,
          changes: {},
          confidence,
        });
        continue;
      }

      const name = action.name?.trim() || category.name;
      const changes: EntityChanges = {};
      if (name !== category.name) changes.name = name;

      const nextType = asCategoryType(action.type);
      if (nextType && nextType !== category.type) {
        clarifications.push("A category's type cannot be changed. Create a new category instead.");
        continue;
      }

      let nextGroup = category.group ? { id: category.groupId!, name: category.group.name } : null;
      const wantsClear = action.groupId === null;
      const groupName = action.groupName?.trim() || null;

      if (wantsClear) {
        nextGroup = null;
      } else if (action.groupId) {
        if (!groupIds.has(action.groupId)) {
          clarifications.push("I could not find that category group.");
          continue;
        }
        const group = input.groups.find((candidate) => candidate.id === action.groupId);
        if (!group) {
          clarifications.push("I could not find that category group.");
          continue;
        }
        if (group.type !== category.type) {
          clarifications.push(`"${group.name}" is a ${group.type.toLowerCase()} group.`);
          continue;
        }
        nextGroup = { id: group.id, name: group.name };
      } else if (groupName) {
        const group = input.groups.find(
          (candidate) =>
            candidate.name.toLowerCase() === groupName.toLowerCase() &&
            candidate.type === category.type,
        );
        if (!group) {
          clarifications.push(`I could not find a group named "${groupName}".`);
          continue;
        }
        nextGroup = { id: group.id, name: group.name };
      }

      if ((nextGroup?.id ?? null) !== category.groupId) {
        changes.groupId = nextGroup?.id ?? null;
      }

      if (Object.keys(changes).length === 0) {
        clarifications.push("What should change on that category?");
        continue;
      }

      actions.push({
        actionId: randomUUID(),
        entity: "CATEGORY",
        kind: "UPDATE",
        targetId: category.id,
        before,
        after: {
          ...before,
          name,
          groupId: nextGroup?.id ?? null,
          groupName: nextGroup?.name ?? null,
        },
        changes,
        confidence,
      });
      continue;
    }

    // GROUP
    if (action.kind === "CREATE") {
      const name = action.name?.trim() || "";
      const type = asCategoryType(action.type);
      if (!name) {
        clarifications.push("What should the group be called?");
        continue;
      }
      if (!type) {
        clarifications.push(`Is "${name}" an expense, income, saving or investment group?`);
        continue;
      }

      const existing = input.groups.find(
        (group) => group.name.toLowerCase() === name.toLowerCase() && group.type === type,
      );
      if (existing) {
        clarifications.push(`You already have a ${type.toLowerCase()} group named "${name}".`);
        continue;
      }

      const after: EntitySnapshot = {
        entity: "GROUP",
        id: "",
        name,
        type,
        categoryCount: 0,
        memberIds: [],
      };

      actions.push({
        actionId: randomUUID(),
        entity: "GROUP",
        kind: "CREATE",
        targetId: null,
        before: null,
        after,
        changes: { name, type },
        confidence,
      });
      continue;
    }

    if (!targetId || !groupIds.has(targetId)) {
      clarifications.push("Which category group do you mean?");
      continue;
    }

    const group = await prisma.categoryGroup.findUnique({
      where: { id: targetId },
      include: { categories: { select: { id: true } } },
    });

    if (!group || group.userId !== input.userId) {
      clarifications.push("I could not find that category group.");
      continue;
    }

    const before = groupSnapshot(group);

    if (action.kind === "DELETE") {
      actions.push({
        actionId: randomUUID(),
        entity: "GROUP",
        kind: "DELETE",
        targetId: group.id,
        before,
        after: null,
        changes: {},
        confidence,
      });
      continue;
    }

    const name = action.name?.trim() || group.name;
    if (name === group.name) {
      clarifications.push("What should change on that group?");
      continue;
    }

    const nextType = asCategoryType(action.type);
    if (nextType && nextType !== group.type) {
      clarifications.push("A group's type cannot be changed. Create a new group instead.");
      continue;
    }

    actions.push({
      actionId: randomUUID(),
      entity: "GROUP",
      kind: "UPDATE",
      targetId: group.id,
      before,
      after: { ...before, name },
      changes: { name },
      confidence,
    });
  }

  return { actions, clarifications };
}

/** Applies one confirmed entity change inside the caller's transaction. */
export async function applyEntityAction(
  tx: Prisma.TransactionClient,
  userId: string,
  item: ConfirmEntityItem,
  timeZone: string,
): Promise<EntityUndoOperation> {
  if (item.entity === "DEBT") {
    if (item.action === "CREATE") {
      const partyName = item.partyName?.trim();
      const direction = asDebtDirection(item.type) ?? "TAKEN";
      const amount = round(Number(item.amount));

      if (!partyName) throw new BadRequestError("A debt needs a party name");
      if (!Number.isFinite(amount) || amount <= 0 || amount > 10_00_00_000) {
        throw new BadRequestError("That debt amount is not valid");
      }

      const created = await tx.debt.create({
        data: {
          type: direction,
          partyName,
          amount,
          description: item.description?.trim() || null,
          date: dateFromItem(item.date, timeZone) ?? new Date(),
          status: "ACTIVE",
          userId,
        },
      });

      return {
        kind: "CREATE",
        entity: "DEBT",
        targetId: created.id,
        before: null,
        after: debtSnapshot({ ...created, payments: [] }),
      };
    }

    if (!item.targetId) throw new BadRequestError("Choose a debt first");
    const debt = await tx.debt.findUnique({
      where: { id: item.targetId },
      include: { payments: { select: { amount: true } } },
    });
    if (!debt) throw new NotFoundError("That debt no longer exists");
    if (debt.userId !== userId) throw new ForbiddenError("You do not own that debt");

    const before = debtSnapshot(debt);

    if (item.action === "DELETE") {
      if (debt.payments.length > 0) {
        throw new BadRequestError("Remove this debt's payments before deleting it");
      }
      await tx.debt.delete({ where: { id: debt.id } });
      return { kind: "DELETE", entity: "DEBT", targetId: debt.id, before, after: null };
    }

    const direction = item.type ? asDebtDirection(item.type) ?? debt.type : debt.type;
    const amount = item.amount !== undefined ? round(Number(item.amount)) : debt.amount;
    const paid = paidAmountOf(debt.payments);

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestError("That debt amount is not valid");
    }
    if (amount + EPSILON < paid) {
      throw new BadRequestError("Amount cannot be less than what has already been paid");
    }

    const updated = await tx.debt.update({
      where: { id: debt.id },
      data: {
        type: direction,
        ...(item.partyName ? { partyName: item.partyName.trim() } : {}),
        amount,
        ...(item.description !== undefined
          ? { description: item.description?.trim() || null }
          : {}),
        ...(item.date ? { date: dateFromItem(item.date, timeZone) ?? debt.date } : {}),
        status: paid + EPSILON >= amount ? "SETTLED" : "ACTIVE",
      },
    });

    return {
      kind: "UPDATE",
      entity: "DEBT",
      targetId: debt.id,
      before,
      after: debtSnapshot({ ...updated, payments: debt.payments }),
    };
  }

  if (item.entity === "CATEGORY") {
    if (item.action === "CREATE") {
      const name = item.name?.trim();
      const type = asCategoryType(item.type);
      if (!name) throw new BadRequestError("A category needs a name");
      if (!type) throw new BadRequestError("A category needs a type");

      const existing = await tx.category.findUnique({
        where: { userId_name_type: { userId, name, type } },
      });
      if (existing) {
        throw new ConflictError(`A ${type.toLowerCase()} category named "${name}" already exists`);
      }

      let group: { id: string; name: string; type: CategoryType } | null = null;
      if (item.groupId) {
        const found = await findGroup(tx, userId, item.groupId);
        assertGroupType(found, type);
        group = found;
      }

      const created = await tx.category.create({
        data: { name, type, userId, groupId: group?.id ?? null },
      });

      return {
        kind: "CREATE",
        entity: "CATEGORY",
        targetId: created.id,
        before: null,
        after: categorySnapshot({ ...created, group }),
      };
    }

    if (!item.targetId) throw new BadRequestError("Choose a category first");
    const category = await tx.category.findUnique({
      where: { id: item.targetId },
      include: { group: { select: { name: true } }, _count: { select: { transactions: true } } },
    });
    if (!category) throw new NotFoundError("That category no longer exists");
    if (category.userId !== userId) throw new ForbiddenError("You do not own that category");

    const before = categorySnapshot(category);

    if (item.action === "DELETE") {
      if (category._count.transactions > 0) {
        throw new ConflictError(
          "Cannot delete a category with transactions. Reassign or delete them first.",
        );
      }
      await tx.budget.deleteMany({ where: { userId, scope: category.id } });
      await tx.category.delete({ where: { id: category.id } });
      return { kind: "DELETE", entity: "CATEGORY", targetId: category.id, before, after: null };
    }

    const name = item.name?.trim() || category.name;
    if (name !== category.name) {
      const existing = await tx.category.findUnique({
        where: { userId_name_type: { userId, name, type: category.type } },
      });
      if (existing && existing.id !== category.id) {
        throw new ConflictError(
          `A ${category.type.toLowerCase()} category named "${name}" already exists`,
        );
      }
    }

    let groupId = category.groupId;
    if (item.groupId === null) {
      groupId = null;
    } else if (item.groupId) {
      const found = await findGroup(tx, userId, item.groupId);
      assertGroupType(found, category.type);
      groupId = found.id;
    }

    const updated = await tx.category.update({
      where: { id: category.id },
      data: { name, groupId },
      include: { group: { select: { name: true } }, _count: { select: { transactions: true } } },
    });

    return {
      kind: "UPDATE",
      entity: "CATEGORY",
      targetId: category.id,
      before,
      after: categorySnapshot(updated),
    };
  }

  // GROUP
  if (item.action === "CREATE") {
    const name = item.name?.trim();
    const type = asCategoryType(item.type);
    if (!name) throw new BadRequestError("A group needs a name");
    if (!type) throw new BadRequestError("A group needs a type");

    const existing = await tx.categoryGroup.findUnique({
      where: { userId_name_type: { userId, name, type } },
    });
    if (existing) {
      throw new ConflictError(`A ${type.toLowerCase()} group named "${name}" already exists`);
    }

    const created = await tx.categoryGroup.create({ data: { name, type, userId } });
    return {
      kind: "CREATE",
      entity: "GROUP",
      targetId: created.id,
      before: null,
      after: groupSnapshot({ ...created, categories: [] }),
    };
  }

  if (!item.targetId) throw new BadRequestError("Choose a category group first");
  const group = await tx.categoryGroup.findUnique({
    where: { id: item.targetId },
    include: { categories: { select: { id: true } } },
  });
  if (!group) throw new NotFoundError("That category group no longer exists");
  if (group.userId !== userId) throw new ForbiddenError("You do not own that category group");

  const before = groupSnapshot(group);

  if (item.action === "DELETE") {
    await tx.category.updateMany({ where: { groupId: group.id, userId }, data: { groupId: null } });
    await tx.categoryGroup.delete({ where: { id: group.id } });
    return { kind: "DELETE", entity: "GROUP", targetId: group.id, before, after: null };
  }

  const name = item.name?.trim() || group.name;
  if (name !== group.name) {
    const existing = await tx.categoryGroup.findUnique({
      where: { userId_name_type: { userId, name, type: group.type } },
    });
    if (existing && existing.id !== group.id) {
      throw new ConflictError(
        `A ${group.type.toLowerCase()} group named "${name}" already exists`,
      );
    }
  }

  const updated = await tx.categoryGroup.update({
    where: { id: group.id },
    data: { name },
    include: { categories: { select: { id: true } } },
  });

  return {
    kind: "UPDATE",
    entity: "GROUP",
    targetId: group.id,
    before,
    after: groupSnapshot(updated),
  };
}

/** Reverses a previously confirmed entity change. Returns what it did. */
export async function undoEntityOperation(
  tx: Prisma.TransactionClient,
  userId: string,
  operation: EntityUndoOperation,
): Promise<{ restored: number; removed: number }> {
  const { entity, kind, before, after } = operation;
  const id = operation.targetId;

  if (kind === "CREATE") {
    if (entity === "DEBT") {
      const debt = await tx.debt.findUnique({ where: { id } });
      if (!debt || debt.userId !== userId) return { restored: 0, removed: 0 };
      await tx.debtPayment.deleteMany({ where: { debtId: id } });
      await tx.debt.delete({ where: { id } });
      return { restored: 0, removed: 1 };
    }

    if (entity === "CATEGORY") {
      const category = await tx.category.findUnique({
        where: { id },
        include: { _count: { select: { transactions: true } } },
      });
      if (!category || category.userId !== userId) return { restored: 0, removed: 0 };
      if (category._count.transactions > 0) return { restored: 0, removed: 0 };
      await tx.budget.deleteMany({ where: { userId, scope: id } });
      await tx.category.delete({ where: { id } });
      return { restored: 0, removed: 1 };
    }

    const group = await tx.categoryGroup.findUnique({ where: { id } });
    if (!group || group.userId !== userId) return { restored: 0, removed: 0 };
    await tx.category.updateMany({ where: { groupId: id, userId }, data: { groupId: null } });
    await tx.categoryGroup.delete({ where: { id } });
    return { restored: 0, removed: 1 };
  }

  if (!before) return { restored: 0, removed: 0 };

  if (entity === "DEBT") {
    if (kind === "DELETE") {
      const existing = await tx.debt.findUnique({ where: { id } });
      if (existing) return { restored: 0, removed: 0 };
      await tx.debt.create({
        data: {
          id,
          type: (before.type as DebtDirection) ?? "TAKEN",
          partyName: before.partyName ?? "Debt",
          amount: before.amount ?? 0,
          description: before.description ?? null,
          date: before.date ? new Date(before.date) : new Date(),
          status: before.status ?? "ACTIVE",
          userId,
        },
      });
      return { restored: 1, removed: 0 };
    }

    const debt = await tx.debt.findUnique({ where: { id } });
    if (!debt || debt.userId !== userId) return { restored: 0, removed: 0 };
    await tx.debt.update({
      where: { id },
      data: {
        type: (before.type as DebtDirection) ?? debt.type,
        partyName: before.partyName ?? debt.partyName,
        amount: before.amount ?? debt.amount,
        description: before.description ?? null,
        date: before.date ? new Date(before.date) : debt.date,
        status: before.status ?? debt.status,
      },
    });
    return { restored: 1, removed: 0 };
  }

  if (entity === "CATEGORY") {
    if (kind === "DELETE") {
      const existing = await tx.category.findUnique({ where: { id } });
      if (existing) return { restored: 0, removed: 0 };
      const groupId =
        before.groupId && (await tx.categoryGroup.findUnique({ where: { id: before.groupId } }))
          ? before.groupId
          : null;
      await tx.category.create({
        data: {
          id,
          name: before.name ?? "Category",
          type: (before.type as CategoryType) ?? "EXPENSE",
          groupId,
          userId,
        },
      });
      return { restored: 1, removed: 0 };
    }

    const category = await tx.category.findUnique({ where: { id } });
    if (!category || category.userId !== userId) return { restored: 0, removed: 0 };
    const groupId =
      before.groupId && (await tx.categoryGroup.findUnique({ where: { id: before.groupId } }))
        ? before.groupId
        : null;
    await tx.category.update({
      where: { id },
      data: { name: before.name ?? category.name, groupId },
    });
    return { restored: 1, removed: 0 };
  }

  if (kind === "DELETE") {
    const existing = await tx.categoryGroup.findUnique({ where: { id } });
    if (existing) return { restored: 0, removed: 0 };
    await tx.categoryGroup.create({
      data: {
        id,
        name: before.name ?? "Group",
        type: (before.type as CategoryType) ?? "EXPENSE",
        userId,
      },
    });

    if (before.memberIds && before.memberIds.length > 0) {
      await tx.category.updateMany({
        where: { id: { in: before.memberIds }, userId },
        data: { groupId: id },
      });
    }
    return { restored: 1, removed: 0 };
  }

  const group = await tx.categoryGroup.findUnique({ where: { id } });
  if (!group || group.userId !== userId) return { restored: 0, removed: 0 };
  await tx.categoryGroup.update({
    where: { id },
    data: { name: before.name ?? group.name },
  });
  return { restored: 1, removed: 0 };
}

/** Reads debts, categories or groups for the QUERY intent. */
export async function runEntityQuery(
  userId: string,
  spec: EntityQuerySpec,
): Promise<EntityQueryResult> {
  const limit = spec.limit ?? 10;
  const text = spec.text?.trim().toLowerCase();

  if (spec.entity === "DEBT") {
    const direction = asDebtDirection(spec.type);
    const debts = await prisma.debt.findMany({
      where: {
        userId,
        ...(spec.status ? { status: spec.status } : {}),
        ...(direction ? { type: direction } : {}),
      },
      orderBy: { date: "desc" },
      include: { payments: { select: { amount: true } } },
    });

    const rows = debts
      .map((debt) => {
        const paid = paidAmountOf(debt.payments);
        return {
          id: debt.id,
          type: debt.type,
          partyName: debt.partyName,
          description: debt.description,
          date: debt.date,
          status: debt.status,
          amount: round(debt.amount),
          paid,
          outstanding: round(Math.max(0, debt.amount - paid)),
        };
      })
      .filter(
        (debt) =>
          !text ||
          debt.partyName.toLowerCase().includes(text) ||
          debt.description?.toLowerCase().includes(text),
      );

    const active = rows.filter((debt) => debt.status === "ACTIVE");
    const takenOutstanding = round(
      active.filter((debt) => debt.type === "TAKEN").reduce((sum, debt) => sum + debt.outstanding, 0),
    );
    const givenOutstanding = round(
      active.filter((debt) => debt.type === "GIVEN").reduce((sum, debt) => sum + debt.outstanding, 0),
    );

    return {
      entity: "DEBT",
      count: rows.length,
      total: round(rows.reduce((sum, debt) => sum + debt.outstanding, 0)),
      takenOutstanding,
      givenOutstanding,
      items: rows.slice(0, limit).map((debt) => ({
        id: debt.id,
        title: `${debt.partyName} · ${debt.type === "TAKEN" ? "you owe" : "owed to you"}`,
        subtitle: `${debt.status === "ACTIVE" ? `outstanding ${debt.outstanding}` : "settled"} · ${debt.date.toISOString().slice(0, 10)}`,
        amount: debt.outstanding,
      })),
    };
  }

  if (spec.entity === "CATEGORY") {
    const type = asCategoryType(spec.type);
    const categories = await prisma.category.findMany({
      where: { userId, ...(type ? { type } : {}) },
      orderBy: [{ type: "asc" }, { name: "asc" }],
      include: { group: { select: { name: true } }, _count: { select: { transactions: true } } },
    });

    const rows = categories.filter((category) => !text || category.name.toLowerCase().includes(text));

    return {
      entity: "CATEGORY",
      count: rows.length,
      total: round(rows.reduce((sum, category) => sum + category._count.transactions, 0)),
      items: rows.slice(0, limit).map((category) => ({
        id: category.id,
        title: category.name,
        subtitle: `${category.type.toLowerCase()}${category.group ? ` · ${category.group.name}` : ""} · ${category._count.transactions} transaction${
          category._count.transactions === 1 ? "" : "s"
        }`,
      })),
    };
  }

  const groups = await prisma.categoryGroup.findMany({
    where: { userId, ...(asCategoryType(spec.type) ? { type: asCategoryType(spec.type)! } : {}) },
    orderBy: [{ type: "asc" }, { name: "asc" }],
    include: { categories: { select: { id: true } } },
  });

  const rows = groups.filter((group) => !text || group.name.toLowerCase().includes(text));

  return {
    entity: "GROUP",
    count: rows.length,
    total: round(rows.reduce((sum, group) => sum + group.categories.length, 0)),
    items: rows.slice(0, limit).map((group) => ({
      id: group.id,
      title: group.name,
      subtitle: `${group.type.toLowerCase()} · ${group.categories.length} categor${
        group.categories.length === 1 ? "y" : "ies"
      }`,
    })),
  };
}

function formatInr(value: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

export function composeEntityQueryReply(result: EntityQueryResult): string {
  if (result.count === 0) {
    if (result.entity === "DEBT") return "I could not find any debts matching that.";
    if (result.entity === "CATEGORY") return "I could not find any categories matching that.";
    return "I could not find any category groups matching that.";
  }

  const lines: string[] = [];

  if (result.entity === "DEBT") {
    const taken = result.takenOutstanding ?? 0;
    const given = result.givenOutstanding ?? 0;
    if (taken > 0 && given > 0) {
      lines.push(`You owe ${formatInr(taken)} and ${formatInr(given)} is owed to you.`);
    } else if (taken > 0) {
      lines.push(`You owe ${formatInr(taken)} across ${result.count} debt${result.count === 1 ? "" : "s"}.`);
    } else if (given > 0) {
      lines.push(`${formatInr(given)} is owed to you across ${result.count} debt${result.count === 1 ? "" : "s"}.`);
    } else {
      lines.push(`You have ${result.count} settled debt${result.count === 1 ? "" : "s"}.`);
    }
  } else if (result.entity === "CATEGORY") {
    lines.push(`You have ${result.count} categor${result.count === 1 ? "y" : "ies"} matching that.`);
  } else {
    lines.push(`You have ${result.count} category group${result.count === 1 ? "" : "s"} matching that.`);
  }

  for (const item of result.items.slice(0, 8)) {
    lines.push(
      `• ${item.title}${item.amount !== undefined && result.entity === "DEBT" ? ` (${formatInr(item.amount)} outstanding)` : ""} — ${item.subtitle}`,
    );
  }

  if (result.count > 8) lines.push(`…and ${result.count - 8} more.`);

  return lines.join("\n");
}
