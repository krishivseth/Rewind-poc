/** Access key check and in-memory write rate limiting. Viewing is public; writes need X-Rewind-Key. */
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { settings } from "../lib/config";

export const keyId = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

export function validKey(key: string | undefined): boolean {
  if (!key || !settings.accessKey) return false;
  const a = Buffer.from(key), b = Buffer.from(settings.accessKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.header("x-rewind-key");
  if (!validKey(key)) { res.status(401).json({ detail: "missing or invalid X-Rewind-Key" }); return; }
  res.locals.keyId = keyId(key!);
  next();
}

class SlidingWindow {
  private events = new Map<string, number[]>();
  constructor(private windowMs = 3_600_000) {}
  private prune(bucket: string): number[] {
    const now = Date.now();
    const q = (this.events.get(bucket) ?? []).filter((t) => t > now - this.windowMs);
    this.events.set(bucket, q);
    return q;
  }
  remaining(bucket: string, limit: number): number { return Math.max(0, limit - this.prune(bucket).length); }
  take(bucket: string, n: number): void { const q = this.prune(bucket); const now = Date.now(); for (let i = 0; i < n; i += 1) q.push(now); }
  reset(): void { this.events.clear(); }
}
export const branchLimiter = new SlidingWindow();

export const clientIp = (req: Request) => (req.header("x-forwarded-for")?.split(",")[0]?.trim()) || req.ip || "unknown";

/** Reserve n branch creations against both the key and the IP, or return false. */
export function takeBranchQuota(req: Request, key: string, n: number): boolean {
  const limit = settings.rateLimitBranchesPerHour;
  const ip = clientIp(req);
  if (branchLimiter.remaining(`key:${key}`, limit) < n || branchLimiter.remaining(`ip:${ip}`, limit) < n) return false;
  branchLimiter.take(`key:${key}`, n);
  branchLimiter.take(`ip:${ip}`, n);
  return true;
}
