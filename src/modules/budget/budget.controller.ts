import type { NextFunction, Request, Response } from "express";
import * as budgetService from "./budget.service.js";
import { listBudgetsSchema, upsertBudgetSchema } from "./budget.validation.js";

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = listBudgetsSchema.parse(req.query);
    const result = await budgetService.listBudgets(req.user!.id, query.month);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function upsert(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = upsertBudgetSchema.parse(req.body);
    const budget = await budgetService.upsertBudget(req.user!.id, input);
    res.status(200).json({ budget });
  } catch (error) {
    next(error);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await budgetService.deleteBudget(req.user!.id, String(req.params["id"]));
    res.status(200).json({ message: "Budget deleted successfully" });
  } catch (error) {
    next(error);
  }
}
