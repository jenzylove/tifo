import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { list, put } from "@vercel/blob";

// Sliding window limiter kept in memory. It is per server instance (each serverless
// instance has its own counts), so it is a first line of defence, not a guarantee.
const hits = new Map<string, number[]>();
const MAX_KEYS = 5000;

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || req.headers.get("x-real-ip")?.trim() || "anon";
}

export function limit(req: Request, bucket: string, max: number, windowMs: number): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const key = `${bucket}:${clientIp(req)}`;
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.delete(key);
    hits.set(key, recent);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)) };
  }
  recent.push(now);
  hits.delete(key); // re-insert so Map order tracks recency
  hits.set(key, recent);
  if (hits.size > MAX_KEYS) {
    let drop = hits.size - MAX_KEYS;
    for (const k of hits.keys()) {
      if (drop-- <= 0) break;
      hits.delete(k);
    }
  }
  return { ok: true };
}

export function tooMany(retryAfter: number) {
  return NextResponse.json(
    { error: "Too many requests. Please try again a little later." },
    { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(retryAfter))) } },
  );
}

// Shared limiter for the endpoints that spend Claude tokens. Each serverless instance has its own memory, so the
// in-memory limit above cannot stop one person spread over many instances. Here every allowed call leaves one tiny
// marker blob, and the count is the number of markers in the current window: one for this IP, one for the whole
// site per day. If the store is missing or slow, the in-memory limit above is all that applies.
const DAILY_CAP = Math.max(1, Number(process.env.CLAUDE_DAILY_CAP) || 1500);
const STORE_TIMEOUT_MS = 2500;

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const withTimeout = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("store timeout")), STORE_TIMEOUT_MS))]);

async function countIn(prefix: string, stop: number): Promise<number> {
  const { blobs } = await list({ prefix, limit: stop });
  return blobs.length;
}

export async function limitShared(req: Request, bucket: string, max: number, windowMs: number): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const local = limit(req, bucket, max, windowMs);
  if (!local.ok || !process.env.BLOB_READ_WRITE_TOKEN) return local;
  try {
    const now = Date.now();
    const win = Math.floor(now / windowMs);
    const mine = `rl/${bucket}/${sha(clientIp(req))}/${win}/`;
    const day = `rl/day/${new Date(now).toISOString().slice(0, 10)}/`;
    const [used, today] = await withTimeout(Promise.all([countIn(mine, max), countIn(day, DAILY_CAP)]));
    if (used >= max) return { ok: false, retryAfter: Math.max(1, Math.ceil(((win + 1) * windowMs - now) / 1000)) };
    if (today >= DAILY_CAP) return { ok: false, retryAfter: Math.max(1, Math.ceil((Date.parse(day.slice(7, 17)) + 86_400_000 - now) / 1000)) };
    await withTimeout(Promise.all([put(`${mine}${now}`, "1", { access: "public", addRandomSuffix: true }), put(`${day}${now}`, "1", { access: "public", addRandomSuffix: true })]));
  } catch (e) {
    console.error("shared rate limit unavailable, using the in-memory one", (e as Error).message);
  }
  return { ok: true };
}
