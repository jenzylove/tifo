import { NextResponse } from "next/server";

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
    { error: "Too many requests. Try again in a minute." },
    { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(retryAfter))) } },
  );
}
