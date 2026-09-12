import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as reportService from "./report.service.js";

const monthlyQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "month must be in YYYY-MM format")
    .default(() => {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    }),
});

const annualQuerySchema = z.object({
  year: z
    .string()
    .regex(/^\d{4}$/, "year must be in YYYY format")
    .default(() => String(new Date().getFullYear())),
});

export async function monthly(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { month } = monthlyQuerySchema.parse(req.query);
    const report = await reportService.getMonthlyReport(req.user!.id, month);
    res.status(200).json({ report });
  } catch (error) {
    next(error);
  }
}

export async function annual(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { year } = annualQuerySchema.parse(req.query);
    const report = await reportService.getAnnualReport(req.user!.id, parseInt(year, 10));
    res.status(200).json({ report });
  } catch (error) {
    next(error);
  }
}
