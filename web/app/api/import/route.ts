import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { z } from "zod";
import { importPost } from "@/lib/importPost";
import { limit, tooMany } from "@/lib/ratelimit";

export const maxDuration = 60;

const Body = z.object({
  image: z.string().url().max(2000).optional(),
  text: z.string().max(4000).optional(),
  url: z.string().url().max(2000).optional(),
});

// Fill a new drop from a post the seller already made. Optional: sellers without one fill the form themselves.
export async function POST(req: Request) {
  const rl = limit(req, "import", 10, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success || (!p.data.image && !p.data.text?.trim() && !p.data.url)) return NextResponse.json({ error: "Add a screenshot, the caption or the post's link." }, { status: 400 });
  try {
    const out = await importPost(p.data);
    // A photo taken from someone else's server can expire, so keep our own copy.
    if (out.image && out.image !== p.data.image && process.env.BLOB_READ_WRITE_TOKEN) {
      const r = await fetch(out.image, { signal: AbortSignal.timeout(6000) }).catch(() => null);
      const type = r?.headers.get("content-type") ?? "";
      const buf = r?.ok && /^image\//.test(type) ? await r.arrayBuffer() : null;
      out.image = buf && buf.byteLength < 4 * 1024 * 1024 ? (await put(`drops/${crypto.randomUUID()}.${type.split("/")[1].split(";")[0]}`, buf, { access: "public", contentType: type })).url : null;
    }
    return NextResponse.json(out);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: (e as Error).message.includes("couldn't read") ? (e as Error).message : "We couldn't read that post. Fill in the details yourself." }, { status: 502 });
  }
}
