import { NextResponse } from "next/server";
import { list, put } from "@vercel/blob";
import { limit, tooMany } from "@/lib/ratelimit";

// When a passkey signature is refused, the browser sends what it looked like here, so the cause can be found without
// asking the person for a screenshot. Nothing in it is secret: a wallet address, a public key, a signature over a
// test value and the browser name. It is written to the server log and kept as a small file.
export async function POST(req: Request) {
  const rl = limit(req, "diag", 12, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const text = (await req.text().catch(() => "")).slice(0, 8000);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const record = JSON.stringify({ at: new Date().toISOString(), ...(body as object) });
  console.error("[tifo diag]", record);
  if (process.env.BLOB_READ_WRITE_TOKEN) await put(`diag/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`, record, { access: "public", contentType: "application/json" }).catch(() => {});
  return new NextResponse(null, { status: 204 });
}

/** The last reports, for whoever holds the scheduler secret. */
export async function GET(req: Request) {
  const secret = process.env.TICK_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return NextResponse.json({ reports: [] });
  const { blobs } = await list({ prefix: "diag/", limit: 200 });
  const latest = blobs.sort((a, b) => +new Date(b.uploadedAt) - +new Date(a.uploadedAt)).slice(0, 15);
  const reports = await Promise.all(latest.map((b) => fetch(b.url).then((r) => r.json()).catch(() => null)));
  return NextResponse.json({ reports: reports.filter(Boolean) }, { headers: { "cache-control": "no-store" } });
}
