import type { Metadata } from "next";
import { Bricolage_Grotesque, Instrument_Sans } from "next/font/google";
import "./globals.css";
import { NETWORK } from "@/lib/chain";

const display = Bricolage_Grotesque({ weight: ["600", "700", "800"], subsets: ["latin"], variable: "--display" });
const body = Instrument_Sans({ weight: ["400", "500", "600", "700"], subsets: ["latin"], variable: "--body" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://tifo.vercel.app"),
  title: "Tifo · the AI manager that turns match day into sales",
  description:
    "An AI business manager for small shops. It runs match drops where both teams' fans buy at full price and the winners get money back in USDC, keeps your worst case capped, and watches your sales and cash.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>
        <header className="top">
          <div className="wrap">
            <a href="/" className="brand">
              <i aria-hidden /> tifo
            </a>
            {NETWORK === "testnet" && <span className="badge">Testnet</span>}
            <nav>
              <a href="/drops" className="hide-sm">Live drops</a>
              <a href="/proof" className="hide-sm">Proof</a>
              <a href="/manage" className="btn sm">For shops</a>
            </nav>
          </div>
        </header>
        <main>{children}</main>
        <footer className="foot">
          <div className="wrap">
            <p>
              Payments settle in USDC on Arc through Circle wallets. A rebate is a fixed % of a full-price purchase, paid only if your team wins. You keep what
              you bought either way, so it&apos;s a discount, not a bet.
            </p>
            <p>
              <a href="/drops">Live drops</a> · <a href="/manage">Run your shop</a> · <a href="/proof">Proof on chain</a>
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
