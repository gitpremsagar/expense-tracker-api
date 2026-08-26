import { createHash, randomUUID } from "node:crypto";
import type { User } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { comparePassword, hashPassword } from "../../utils/password.js";
import {
  getRefreshTokenExpiryDate,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../utils/jwt.js";
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from "../../utils/errors.js";
import type { LoginInput, SignupInput } from "./auth.validation.js";

export type AuthUser = Pick<User, "id" | "name" | "email" | "userType">;

export type AuthResult = {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
};

function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    userType: user.userType,
  };
}

async function createTokenPair(user: User): Promise<AuthResult> {
  const tokenId = randomUUID();
  const refreshToken = signRefreshToken({ sub: user.id, jti: tokenId });
  const accessToken = signAccessToken({
    sub: user.id,
    userType: user.userType,
  });

  await prisma.refreshToken.create({
    data: {
      tokenHash: hashRefreshToken(refreshToken),
      userId: user.id,
      expiresAt: getRefreshTokenExpiryDate(),
    },
  });

  return {
    accessToken,
    refreshToken,
    user: toAuthUser(user),
  };
}

export async function signup(input: SignupInput): Promise<AuthResult> {
  const email = input.email.toLowerCase();

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    throw new ConflictError("Email is already registered");
  }

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.user.create({
    data: {
      name: input.name,
      email,
      password: passwordHash,
      userType: "CUSTOMER",
    },
  });

  return createTokenPair(user);
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const email = input.email.toLowerCase();

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new UnauthorizedError("Invalid email or password");
  }

  const isValidPassword = await comparePassword(input.password, user.password);
  if (!isValidPassword) {
    throw new UnauthorizedError("Invalid email or password");
  }

  return createTokenPair(user);
}

export async function refresh(refreshToken: string): Promise<AuthResult> {
  let payload;

  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new UnauthorizedError("Invalid refresh token");
  }

  const tokenHash = hashRefreshToken(refreshToken);

  const storedToken = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (
    !storedToken ||
    storedToken.revokedAt ||
    storedToken.expiresAt <= new Date() ||
    storedToken.userId !== payload.sub
  ) {
    throw new UnauthorizedError("Invalid refresh token");
  }

  await prisma.refreshToken.update({
    where: { id: storedToken.id },
    data: { revokedAt: new Date() },
  });

  return createTokenPair(storedToken.user);
}

export async function logout(refreshToken?: string): Promise<void> {
  if (!refreshToken) {
    return;
  }

  const tokenHash = hashRefreshToken(refreshToken);

  await prisma.refreshToken.updateMany({
    where: {
      tokenHash,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
}

export async function getUserById(userId: string): Promise<AuthUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user) {
    throw new NotFoundError("User not found");
  }

  return toAuthUser(user);
}
