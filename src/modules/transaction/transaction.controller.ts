import type { Request, Response, NextFunction } from "express";
import * as transactionService from "./transaction.service.js";
import {
  createTransactionSchema,
  listTransactionsSchema,
  updateTransactionSchema,
} from "./transaction.validation.js";

export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = createTransactionSchema.parse(req.body);
    const transaction = await transactionService.createTransaction(req.user!.id, input);
    res.status(201).json({ transaction });
  } catch (error) {
    next(error);
  }
}

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = listTransactionsSchema.parse(req.query);
    const result = await transactionService.listTransactions(req.user!.id, query);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function getOne(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const transaction = await transactionService.getTransaction(req.user!.id, String(req.params["id"]));
    res.status(200).json({ transaction });
  } catch (error) {
    next(error);
  }
}

export async function update(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = updateTransactionSchema.parse(req.body);
    const transaction = await transactionService.updateTransaction(
      req.user!.id,
      String(req.params["id"]),
      input,
    );
    res.status(200).json({ transaction });
  } catch (error) {
    next(error);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await transactionService.deleteTransaction(req.user!.id, String(req.params["id"]));
    res.status(200).json({ message: "Transaction deleted successfully" });
  } catch (error) {
    next(error);
  }
}
