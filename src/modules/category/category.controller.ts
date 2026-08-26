import type { Request, Response, NextFunction } from "express";
import * as categoryService from "./category.service.js";
import { createCategorySchema, updateCategorySchema } from "./category.validation.js";
import type { CategoryType } from "@prisma/client";

export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = createCategorySchema.parse(req.body);
    const category = await categoryService.createCategory(req.user!.id, input);
    res.status(201).json({ category });
  } catch (error) {
    next(error);
  }
}

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rawType = req.query.type;
    const type = typeof rawType === "string" ? (rawType as CategoryType) : undefined;
    const categories = await categoryService.listCategories(req.user!.id, type);
    res.status(200).json({ categories });
  } catch (error) {
    next(error);
  }
}

export async function update(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = updateCategorySchema.parse(req.body);
    const category = await categoryService.updateCategory(req.user!.id, String(req.params["id"]), input);
    res.status(200).json({ category });
  } catch (error) {
    next(error);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await categoryService.deleteCategory(req.user!.id, String(req.params["id"]));
    res.status(200).json({ message: "Category deleted successfully" });
  } catch (error) {
    next(error);
  }
}
