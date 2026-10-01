import { NextResponse } from "next/server";
import { upcomingMatches } from "@/lib/matches";

export const revalidate = 120;

export async function GET() {
  const m = await upcomingMatches();
  return NextResponse.json(m.map(({ league, ...x }) => ({ ...x, league: league.name })));
}
