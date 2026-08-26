import type { UserType } from "@prisma/client";
import type { Request, Response, NextFunction } from "express";
import { ForbiddenError, UnauthorizedError } from "../utils/errors.js";

export function authorize(...allowedRoles: UserType[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError());
      return;
    }

    if (!allowedRoles.includes(req.user.userType)) {
      next(new ForbiddenError());
      return;
    }

    next();
  };
}
