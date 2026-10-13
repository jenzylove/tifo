import { NextResponse } from "next/server";
import { NETWORK, PRACTICE_URL, practice } from "@/lib/chain";

export const dynamic = "force-dynamic";

// Which practice settings this deployment sees. Only public values, never secrets.
export function GET() {
  const raw = process.env.NEXT_PUBLIC_PRACTICE_FACTORY ?? "";
  return NextResponse.json({
    network: NETWORK,
    practiceUrl: PRACTICE_URL || null,
    factoryRawLength: raw.length,
    factoryRawSet: raw.length > 0,
    runtimeUrlSet: Boolean(process.env.NEXT_PUBLIC_PRACTICE_URL),
    on: Boolean(practice),
  });
}
