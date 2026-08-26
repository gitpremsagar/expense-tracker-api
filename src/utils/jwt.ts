import jwt from "jsonwebtoken";
import type { UserType } from "@prisma/client";
import { env } from "../config/env.js";

export type AccessTokenPayload = {
  sub: string;
  userType: UserType;
};

export type RefreshTokenPayload = {
  sub: string;
  jti: string;
};

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_EXPIRY,
  } as jwt.SignOptions);
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.REFRESH_TOKEN_EXPIRY,
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
}

export function getRefreshTokenExpiryDate(): Date {
  const expiry = env.REFRESH_TOKEN_EXPIRY;
  const match = /^(\d+)([smhd])$/.exec(expiry);

  if (!match) {
    return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  }

  const value = Number(match[1]);
  const unit = match[2];

  if (!unit) {
    return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  }

  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  const multiplier = multipliers[unit];
  if (!multiplier) {
    return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  }

  return new Date(Date.now() + value * multiplier);
}

export function getRefreshCookieMaxAgeMs(): number {
  const expiryDate = getRefreshTokenExpiryDate();
  return expiryDate.getTime() - Date.now();
}
