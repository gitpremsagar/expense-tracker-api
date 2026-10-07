import type { Request, Response, NextFunction } from "express";
import type { CategoryType } from "@prisma/client";
import * as categoryGroupService from "./categoryGroup.service.js";
import {
  createCategoryGroupSchema,
  updateCategoryGroupSchema,
} from "./categoryGroup.validation.js";

export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = createCategoryGroupSchema.parse(req.body);
    const group = await categoryGroupService.createGroup(req.user!.id, input);
    res.status(201).json({ group });
  } catch (error) {
    next(error);
  }
}

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rawType = req.query.type;
    const type = typeof rawType === "string" ? (rawType as CategoryType) : undefined;
    const groups = await categoryGroupService.listGroups(req.user!.id, type);
    res.status(200).json({ groups });
  } catch (error) {
    next(error);
  }
}

export async function update(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = updateCategoryGroupSchema.parse(req.body);
    const group = await categoryGroupService.updateGroup(req.user!.id, String(req.params["id"]), input);
    res.status(200).json({ group });
  } catch (error) {
    next(error);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await categoryGroupService.deleteGroup(req.user!.id, String(req.params["id"]));
    res.status(200).json({ message: "Category group deleted successfully" });
  } catch (error) {
    next(error);
  }
}
