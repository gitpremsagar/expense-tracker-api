import type { Request, Response, NextFunction } from "express";
import * as authService from "./auth.service.js";
import {
  changePasswordSchema,
  deleteAccountSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshTokenBodySchema,
  resetPasswordSchema,
  signupSchema,
  updateProfileSchema,
} from "./auth.validation.js";
import { REFRESH_TOKEN_COOKIE, clearRefreshTokenCookie, setRefreshTokenCookie } from "../../utils/cookies.js";
import { AppError } from "../../utils/errors.js";

function isMobileClient(req: Request): boolean {
  return req.headers["x-client"] === "mobile";
}

function authPayload(req: Request, result: { accessToken: string; refreshToken: string; user: unknown }) {
  return {
    accessToken: result.accessToken,
    // Web clients use the HttpOnly cookie. Only the native app needs the token
    // in the body because it has no cookie jar.
    ...(isMobileClient(req) ? { refreshToken: result.refreshToken } : {}),
    user: result.user,
  };
}

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

    res.status(201).json(authPayload(req, result));
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

    res.status(200).json(authPayload(req, result));
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

    res.status(200).json(authPayload(req, result));
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

export async function forgotPassword(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = forgotPasswordSchema.parse(req.body);
    const result = await authService.requestPasswordReset(input.email);

    res.status(200).json({
      message: "If an account exists for that email, a reset link has been sent.",
      delivered: result.delivered,
      ...(result.devResetUrl ? { devResetUrl: result.devResetUrl } : {}),
    });
  } catch (error) {
    next(error);
  }
}

export async function resetPassword(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = resetPasswordSchema.parse(req.body);
    await authService.resetPassword(input.token, input.password);
    clearRefreshTokenCookie(res);
    res.status(200).json({ message: "Password updated. Please sign in." });
  } catch (error) {
    next(error);
  }
}

export async function updateMe(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError(401, "Unauthorized");
    }
    const input = updateProfileSchema.parse(req.body);
    const user = await authService.updateProfile(req.user.id, input);
    res.status(200).json({ user });
  } catch (error) {
    next(error);
  }
}

export async function changePassword(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError(401, "Unauthorized");
    }
    const input = changePasswordSchema.parse(req.body);
    await authService.changePassword(req.user.id, input.currentPassword, input.newPassword);
    clearRefreshTokenCookie(res);
    res.status(200).json({ message: "Password changed. Please sign in again." });
  } catch (error) {
    next(error);
  }
}

export async function logoutAll(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError(401, "Unauthorized");
    }
    await authService.logoutAllSessions(req.user.id);
    clearRefreshTokenCookie(res);
    res.status(200).json({ message: "Signed out on all devices." });
  } catch (error) {
    next(error);
  }
}

export async function deleteMe(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError(401, "Unauthorized");
    }
    const input = deleteAccountSchema.parse(req.body);
    await authService.deleteAccount(req.user.id, input.password);
    clearRefreshTokenCookie(res);
    res.status(200).json({ message: "Account deleted." });
  } catch (error) {
    next(error);
  }
}
