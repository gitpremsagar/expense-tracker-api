import type { Request, Response, NextFunction } from "express";
import * as authService from "./auth.service.js";
import { loginSchema, refreshTokenBodySchema, signupSchema } from "./auth.validation.js";
import { REFRESH_TOKEN_COOKIE, clearRefreshTokenCookie, setRefreshTokenCookie } from "../../utils/cookies.js";
import { AppError } from "../../utils/errors.js";

function getRefreshToken(req: Request): string | null {
  const cookieToken = req.cookies[REFRESH_TOKEN_COOKIE];
  if (typeof cookieToken === "string" && cookieToken.length > 0) {
    return cookieToken;
  }

  const bodyToken = req.body?.refreshToken;
  if (typeof bodyToken === "string" && bodyToken.length > 0) {
    return bodyToken;
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const bearerToken = authHeader.slice(7).trim();
    if (bearerToken.length > 0) {
      return bearerToken;
    }
  }

  return null;
}

export async function signup(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = signupSchema.parse(req.body);
    const result = await authService.signup(input);

    setRefreshTokenCookie(res, result.refreshToken);

    res.status(201).json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
    });
  } catch (error) {
    next(error);
  }
}

export async function login(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = loginSchema.parse(req.body);
    const result = await authService.login(input);

    setRefreshTokenCookie(res, result.refreshToken);

    res.status(200).json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
    });
  } catch (error) {
    next(error);
  }
}

export async function refresh(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    refreshTokenBodySchema.parse(req.body ?? {});
    const refreshToken = getRefreshToken(req);

    if (!refreshToken) {
      throw new AppError(401, "Refresh token missing");
    }

    const result = await authService.refresh(refreshToken);

    setRefreshTokenCookie(res, result.refreshToken);

    res.status(200).json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
    });
  } catch (error) {
    next(error);
  }
}

export async function logout(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    refreshTokenBodySchema.parse(req.body ?? {});
    const refreshToken = getRefreshToken(req);

    if (refreshToken) {
      await authService.logout(refreshToken);
    }

    clearRefreshTokenCookie(res);

    res.status(200).json({ message: "Logged out successfully" });
  } catch (error) {
    next(error);
  }
}

export async function me(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError(401, "Unauthorized");
    }

    const user = await authService.getUserById(req.user.id);

    res.status(200).json({ user });
  } catch (error) {
    next(error);
  }
}
