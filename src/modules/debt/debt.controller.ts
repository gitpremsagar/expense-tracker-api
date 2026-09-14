import type { Request, Response, NextFunction } from "express";
import * as debtService from "./debt.service.js";
import {
  createDebtSchema,
  listDebtsSchema,
  updateDebtSchema,
} from "./debt.validation.js";

export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = createDebtSchema.parse(req.body);
    const debt = await debtService.createDebt(req.user!.id, input);
    res.status(201).json({ debt });
  } catch (error) {
    next(error);
  }
}

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = listDebtsSchema.parse(req.query);
    const result = await debtService.listDebts(req.user!.id, query);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function getOne(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const debt = await debtService.getDebt(req.user!.id, String(req.params["id"]));
    res.status(200).json({ debt });
  } catch (error) {
    next(error);
  }
}

export async function update(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = updateDebtSchema.parse(req.body);
    const debt = await debtService.updateDebt(
      req.user!.id,
      String(req.params["id"]),
      input,
    );
    res.status(200).json({ debt });
  } catch (error) {
    next(error);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await debtService.deleteDebt(req.user!.id, String(req.params["id"]));
    res.status(200).json({ message: "Debt deleted successfully" });
  } catch (error) {
    next(error);
  }
}
