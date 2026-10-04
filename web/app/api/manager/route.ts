import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { managerData } from "@/lib/manager";

export async function GET(req: Request) {
  const a = new URL(req.url).searchParams.get("address") ?? "";
  if (!isAddress(a)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  try {
    return NextResponse.json(await managerData(a));
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Couldn't read your shop from Arc just now." }, { status: 502 });
  }
}
