import "dotenv/config";
import { z } from "zod";

const booleanFromEnv = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const booleanFromEnvDefaultFalse = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  ACCESS_TOKEN_EXPIRY: z.string().default("15m"),
  REFRESH_TOKEN_EXPIRY: z.string().default("7d"),
  FRONTEND_URL: z.string().url(),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().optional(),
  APP_TIMEZONE: z.string().default("Asia/Kolkata"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.string().default("deepseek-flash"),
  ASSISTANT_ENABLED: booleanFromEnv,
  ASSISTANT_THINKING_DEFAULT: booleanFromEnvDefaultFalse,
  ASSISTANT_REASONING_EFFORT_DEFAULT: z.enum(["low", "high", "max"]).default("high"),
  ASSISTANT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  ASSISTANT_IMPORT_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  ASSISTANT_MAX_TEXT_CHARS: z.coerce.number().int().positive().default(2_000),
  ASSISTANT_MAX_CREATES_PER_TURN: z.coerce.number().int().positive().default(10),
  ASSISTANT_DAILY_MESSAGES: z.coerce.number().int().positive().default(100),
  ASSISTANT_DAILY_IMPORT_PAGES: z.coerce.number().int().positive().default(50),
  ASSISTANT_MAX_IMPORT_ROWS: z.coerce.number().int().positive().default(500),
  ASSISTANT_MAX_IMAGE_MB: z.coerce.number().positive().default(10),
  ASSISTANT_MAX_AUDIO_MB: z.coerce.number().positive().default(8),
  ASSISTANT_MAX_STATEMENT_MB: z.coerce.number().positive().default(20),
  ASSISTANT_GLOBAL_DAILY_COST_USD: z.coerce.number().positive().default(10),
});

export const env = envSchema.parse({
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  ACCESS_TOKEN_EXPIRY: process.env.ACCESS_TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY: process.env.REFRESH_TOKEN_EXPIRY,
  FRONTEND_URL: process.env.FRONTEND_URL,
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  APP_TIMEZONE: process.env.APP_TIMEZONE,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
  PASSWORD_RESET_TTL_MINUTES: process.env.PASSWORD_RESET_TTL_MINUTES,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
  ASSISTANT_ENABLED: process.env.ASSISTANT_ENABLED,
  ASSISTANT_THINKING_DEFAULT: process.env.ASSISTANT_THINKING_DEFAULT,
  ASSISTANT_REASONING_EFFORT_DEFAULT: process.env.ASSISTANT_REASONING_EFFORT_DEFAULT,
  ASSISTANT_TIMEOUT_MS: process.env.ASSISTANT_TIMEOUT_MS,
  ASSISTANT_IMPORT_TIMEOUT_MS: process.env.ASSISTANT_IMPORT_TIMEOUT_MS,
  ASSISTANT_MAX_TEXT_CHARS: process.env.ASSISTANT_MAX_TEXT_CHARS,
  ASSISTANT_MAX_CREATES_PER_TURN: process.env.ASSISTANT_MAX_CREATES_PER_TURN,
  ASSISTANT_DAILY_MESSAGES: process.env.ASSISTANT_DAILY_MESSAGES,
  ASSISTANT_DAILY_IMPORT_PAGES: process.env.ASSISTANT_DAILY_IMPORT_PAGES,
  ASSISTANT_MAX_IMPORT_ROWS: process.env.ASSISTANT_MAX_IMPORT_ROWS,
  ASSISTANT_MAX_IMAGE_MB: process.env.ASSISTANT_MAX_IMAGE_MB,
  ASSISTANT_MAX_AUDIO_MB: process.env.ASSISTANT_MAX_AUDIO_MB,
  ASSISTANT_MAX_STATEMENT_MB: process.env.ASSISTANT_MAX_STATEMENT_MB,
  ASSISTANT_GLOBAL_DAILY_COST_USD: process.env.ASSISTANT_GLOBAL_DAILY_COST_USD,
});
