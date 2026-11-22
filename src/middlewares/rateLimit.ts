import type { NextFunction, Request, Response } from "express";

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 20_000;

function prune(now: number) {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Small in-memory rate limiter for auth endpoints. It is intentionally
 * dependency-free and per-process: enough to stop casual brute force on a
 * single API instance. For multi-instance deployments use Redis.
 */
export function rateLimit(options: {
  windowMs: number;
  max: number;
  keyPrefix: string;
}) {
  return function limiter(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    prune(now);

    const key = `${options.keyPrefix}:${req.ip ?? "unknown"}`;
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    if (bucket.count >= options.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        message: `Too many attempts. Try again in ${retryAfter} seconds.`,
      });
      return;
    }

    bucket.count += 1;
    next();
  };
}
