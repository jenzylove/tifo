import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { isAddress, type Address } from "viem";
import { listPromos, promoState } from "@/lib/promos";
import { shortTeam } from "@/lib/matches";
import { inkOn, teamColors } from "@/lib/teams";
import { usd } from "@/lib/chain";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 60;

// The share card: what a promo link looks like on X and WhatsApp.
// Before kickoff it sells the drop; after full time it shows what the winners got back.
export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const font = await readFile(join(process.cwd(), "assets/anton.woff")).catch(() => null);
  const p = isAddress(address) ? (await listPromos()).find((x) => x.address.toLowerCase() === address.toLowerCase()) : undefined;
  if (!p) return new ImageResponse(<div style={{ display: "flex", width: "100%", height: "100%", background: "#0c0d0f", color: "#fff", fontSize: 120, alignItems: "center", justifyContent: "center" }}>TIFO</div>, size);
  const st = await promoState(p.address as Address);
  const A = shortTeam(p.meta.teamA), B = shortTeam(p.meta.teamB);
  const [ca, cb] = teamColors(p.meta.teamA, p.meta.teamB);
  const winner = st.finalOutcome === "A" ? 0 : st.finalOutcome === "B" ? 1 : null;
  const team = [A, B], color = [ca, cb];
  const footer =
    winner !== null
      ? `${team[winner].toUpperCase()} WON · ${usd(st.refundedTotal)} PAID BACK TO FANS`
      : st.finalOutcome !== "None"
        ? "FULL TIME"
        : `${st.ordersCount} FANS IN · ${p.meta.shop.toUpperCase()} · ${p.meta.product.toUpperCase()} $${p.meta.priceUsd}`;
  return new ImageResponse(
    (
      <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", background: "#0c0d0f", fontFamily: "Anton" }}>
        <div style={{ display: "flex", flex: 1 }}>
          {[0, 1].map((s) => (
            <div
              key={s}
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                alignItems: s === 0 ? "flex-start" : "flex-end",
                width: "50%",
                padding: "44px 48px",
                background: color[s],
                color: inkOn(color[s]),
                opacity: winner !== null && winner !== s ? 0.35 : 1,
              }}
            >
              <div style={{ fontSize: 84, lineHeight: 1 }}>{team[s].toUpperCase()}</div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: s === 0 ? "flex-start" : "flex-end" }}>
                <div style={{ fontSize: 150, lineHeight: 0.9 }}>{`${st.rates[s] / 100}%`}</div>
                <div style={{ fontSize: 30 }}>{`BACK IF ${team[s].toUpperCase()} WIN`}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "22px 48px", color: "#f3efe6", fontSize: 34 }}>
          <span>{footer}</span>
          <span style={{ letterSpacing: 6 }}>TIFO</span>
        </div>
      </div>
    ),
    { ...size, fonts: font ? [{ name: "Anton", data: font, style: "normal", weight: 400 }] : [] },
  );
}
