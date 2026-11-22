import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { User } from "@prisma/client";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import {
  isPasswordResetEmailConfigured,
  sendPasswordResetEmail,
} from "../../lib/email.js";
import { comparePassword, hashPassword } from "../../utils/password.js";
import { clearAssistantData } from "../assistant/assistant.threads.js";
import {
  getRefreshTokenExpiryDate,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../utils/jwt.js";
import {
  AppError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from "../../utils/errors.js";
import { addStarterCategories } from "../category/starter.service.js";
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
    tokenVersion: user.tokenVersion,
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

  // A brand-new account should be usable immediately. Seeding is best-effort:
  // a failure here must never block signup, and the Categories page can add
  // the starters later.
  try {
    await addStarterCategories(user.id);
  } catch (error) {
    console.error("Could not seed starter categories", error);
  }

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

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function requestPasswordReset(emailInput: string): Promise<{
  delivered: boolean;
  devResetUrl?: string;
}> {
  const email = emailInput.toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });

  // Always behave the same whether or not the email exists. This prevents
  // using the endpoint to discover which emails have accounts.
  if (!user) {
    return { delivered: false };
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60_000);

  await prisma.passwordResetToken.deleteMany({
    where: { userId: user.id, usedAt: null },
  });

  await prisma.passwordResetToken.create({
    data: {
      tokenHash: hashResetToken(token),
      userId: user.id,
      expiresAt,
    },
  });

  const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${encodeURIComponent(token)}`;
  const delivered = await sendPasswordResetEmail(user.email, resetUrl, user.name).catch(
    (error) => {
      console.error("Could not send password reset email", error);
      return false;
    },
  );

  return {
    delivered,
    // Email is optional in local development. Returning the link here makes
    // the flow testable without an email provider; never expose it in prod.
    ...(env.NODE_ENV !== "production" && !isPasswordResetEmailConfigured()
      ? { devResetUrl: resetUrl }
      : {}),
  };
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(token) },
  });

  if (!stored || stored.usedAt || stored.expiresAt <= new Date()) {
    throw new AppError(400, "This reset link is invalid or has expired. Request a new one.");
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: stored.userId },
      data: { password: passwordHash, tokenVersion: { increment: 1 } },
    }),
    prisma.passwordResetToken.update({
      where: { id: stored.id },
      data: { usedAt: new Date() },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}

export async function updateProfile(
  userId: string,
  input: { name?: string | undefined; email?: string | undefined },
): Promise<AuthUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError("User not found");
  }

  const email = input.email?.toLowerCase();
  if (email && email !== user.email) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictError("Email is already registered");
    }
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(email ? { email } : {}),
    },
  });

  return toAuthUser(updated);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError("User not found");
  }

  const valid = await comparePassword(currentPassword, user.password);
  if (!valid) {
    throw new UnauthorizedError("Current password is incorrect");
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { password: passwordHash, tokenVersion: { increment: 1 } },
    }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}

export async function logoutAllSessions(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}

export async function deleteAccount(userId: string, password: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError("User not found");
  }

  const valid = await comparePassword(password, user.password);
  if (!valid) {
    throw new UnauthorizedError("Password is incorrect");
  }

  // Explicit deletion order keeps Mongo/Prisma predictable and also works if
  // cascade behaviour changes. Nothing here touches another user's data.
  await clearAssistantData(userId);
  await prisma.transaction.deleteMany({ where: { userId } });
  await prisma.debtPayment.deleteMany({ where: { userId } });
  await prisma.debt.deleteMany({ where: { userId } });
  await prisma.budget.deleteMany({ where: { userId } });
  await prisma.category.deleteMany({ where: { userId } });
  await prisma.categoryGroup.deleteMany({ where: { userId } });
  await prisma.passwordResetToken.deleteMany({ where: { userId } });
  await prisma.refreshToken.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}
