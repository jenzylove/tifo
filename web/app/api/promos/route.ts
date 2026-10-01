import { NextResponse } from "next/server";
import { listPromos } from "@/lib/promos";

export const dynamic = "force-dynamic";

export async function GET() {
  const p = await listPromos();
  return NextResponse.json(p.map((x) => ({ ...x, cap: x.cap.toString() })), { headers: { "cache-control": "no-store" } });
}
