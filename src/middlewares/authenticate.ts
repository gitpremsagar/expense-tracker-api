import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { UnauthorizedError } from "../utils/errors.js";

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    next(new UnauthorizedError("Access token missing"));
    return;
  }

  const token = authHeader.slice("Bearer ".length);

  try {
    const payload = verifyAccessToken(token);

    // Re-read the account so a deleted/suspended user (or a role change) takes
    // effect immediately instead of waiting for the access token to expire.
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, userType: true, tokenVersion: true },
    });

    if (!user) {
      next(new UnauthorizedError("Account is no longer active"));
      return;
    }

    // Password changes and "sign out everywhere" bump tokenVersion, which
    // invalidates access tokens issued before that moment on every device.
    if (payload.tokenVersion !== user.tokenVersion) {
      next(new UnauthorizedError("Session is no longer valid"));
      return;
    }

    req.user = { id: user.id, userType: user.userType };
    next();
  } catch {
    next(new UnauthorizedError("Invalid access token"));
  }
}
