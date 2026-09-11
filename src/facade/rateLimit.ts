// A minimal in-memory sliding-window rate limiter -- no new dependency,
// matching this project's established preference for hand-rolled code
// over a framework when the need is genuinely simple (see router.ts's own
// header comment). Closes a real, previously-flagged gap: every façade
// route accepted unlimited request volume from an authenticated caller,
// most exposed on the login route (brute-force resistance depended
// entirely on loginAttempts.ts's per-account lockout, with no per-IP
// layer at all) and Payroll's export routes (a real, potentially
// expensive query).
//
// Honest limitation, not hidden: this is per-process, in-memory state --
// it resets on every restart and doesn't coordinate across multiple
// façade processes. That's an accepted trade for this deployment's actual
// shape (a single façade process, confirmed in ops/DISASTER_RECOVERY.md
// and this project's production posture notes) -- a Postgres-backed or
// Redis-backed limiter would be the real fix if this ever runs as more
// than one process, not attempted here since that's not today's shape.
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./context.js";

type Bucket = { count: number; windowStartMs: number };

const buckets = new Map<string, Bucket>();

// Cheap, bounded cleanup -- avoids an unbounded Map growing forever from
// one-off callers/IPs that never come back. Runs opportunistically on
// every check rather than a separate timer, since this router has no
// existing background-job infrastructure to hook into.
const MAX_TRACKED_KEYS = 5000;

function pruneIfNeeded(nowMs: number, windowMs: number) {
  if (buckets.size <= MAX_TRACKED_KEYS) return;
  for (const [key, bucket] of buckets) {
    if (nowMs - bucket.windowStartMs > windowMs) buckets.delete(key);
  }
}

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  pruneIfNeeded(now, windowMs);
  const existing = buckets.get(key);
  if (!existing || now - existing.windowStartMs > windowMs) {
    buckets.set(key, { count: 1, windowStartMs: now });
    return { allowed: true };
  }
  if (existing.count >= limit) {
    const retryAfterSeconds = Math.ceil((existing.windowStartMs + windowMs - now) / 1000);
    return { allowed: false, retryAfterSeconds };
  }
  existing.count += 1;
  return { allowed: true };
}

// req.socket.remoteAddress is the real client IP here -- this façade sits
// directly behind Caddy on the same box (see docs/ARCHITECTURE.md's
// deploy notes), which is configured to pass the connecting IP through
// rather than proxying opaquely, so no X-Forwarded-For trust decision is
// needed. If a second reverse-proxy hop is ever added in front of Caddy,
// this needs revisiting -- trusting a client-supplied X-Forwarded-For
// header blindly would let a rate limit be trivially bypassed.
function clientKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

// Two tiers, matching the two real risk profiles identified in the
// backlog: login (brute-force resistance) gets a tight per-IP limit
// independent of loginAttempts.ts's own per-account lockout -- the two
// are complementary, not redundant (an attacker spraying many different
// email addresses from one IP never trips a single account's lockout).
// Everything else gets a generous general limit, mainly to bound
// Payroll's export routes and any other real query cost, not to
// meaningfully throttle normal dashboard use.
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 min, matches loginAttempts.ts's own window
const GENERAL_LIMIT = 120;
const GENERAL_WINDOW_MS = 60 * 1000; // 1 min

export function checkFacadeRateLimit(req: IncomingMessage, pathname: string): RateLimitResult {
  const ip = clientKey(req);
  if (pathname.startsWith("/api/v1/users/auth/login")) {
    return checkRateLimit(`login:${ip}`, LOGIN_LIMIT, LOGIN_WINDOW_MS);
  }
  return checkRateLimit(`general:${ip}`, GENERAL_LIMIT, GENERAL_WINDOW_MS);
}

export function sendRateLimited(res: ServerResponse, retryAfterSeconds: number): void {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  sendJson(res, 429, { detail: "Too many requests. Try again shortly." });
}

// Test-only: buckets is module-private by design (no direct manipulation
// from route handlers), but tests need a way to reset state between runs
// without waiting out real windows.
export function resetRateLimitStateForTests(): void {
  buckets.clear();
}
