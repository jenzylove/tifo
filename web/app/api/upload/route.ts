import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { limit, tooMany } from "@/lib/ratelimit";

// Product photos for drop pages. Images only, 4 MB max.
const TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

export async function POST(req: Request) {
  const rl = limit(req, "upload", 10, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  if (!process.env.BLOB_READ_WRITE_TOKEN) return NextResponse.json({ error: "Uploads are not set up. Paste an image link instead." }, { status: 503 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
  if (!TYPES.has(file.type)) return NextResponse.json({ error: "Use a JPG, PNG or WebP image." }, { status: 400 });
  if (file.size > 4 * 1024 * 1024) return NextResponse.json({ error: "Images up to 4 MB." }, { status: 400 });
  const ext = file.type.split("/")[1];
  const blob = await put(`drops/${crypto.randomUUID()}.${ext}`, file, { access: "public", contentType: file.type });
  return NextResponse.json({ url: blob.url });
}
