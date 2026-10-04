import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { managerBrief } from "@/lib/brief";

export const maxDuration = 120;

export async function GET(req: Request) {
  const u = new URL(req.url);
  const a = u.searchParams.get("address") ?? "";
  if (!isAddress(a)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  try {
    return NextResponse.json(await managerBrief(a, u.searchParams.get("fresh") === "1"));
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Your manager couldn't put the briefing together just now." }, { status: 502 });
  }
}
