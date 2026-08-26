import type { Response } from "express";
import { env } from "../config/env.js";
import { getRefreshCookieMaxAgeMs } from "./jwt.js";

export const REFRESH_TOKEN_COOKIE = "refreshToken";

export function setRefreshTokenCookie(res: Response, token: string): void {
  res.cookie(REFRESH_TOKEN_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/auth",
    maxAge: getRefreshCookieMaxAgeMs(),
  });
}

export function clearRefreshTokenCookie(res: Response): void {
  res.clearCookie(REFRESH_TOKEN_COOKIE, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/auth",
  });
}
