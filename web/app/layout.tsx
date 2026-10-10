import type { Metadata } from "next";
import { Anton, Barlow } from "next/font/google";
import "./globals.css";
import { NETWORK } from "@/lib/chain";

const display = Anton({ weight: "400", subsets: ["latin"], variable: "--display" });
const body = Barlow({ weight: ["400", "500", "600", "700"], subsets: ["latin"], variable: "--body" });
const ACCENT = process.env.NEXT_PUBLIC_ACCENT === "blue" ? "blue" : "green";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://tifo.vercel.app"),
  title: "Tifo · the AI manager that turns match day into sales",
  description:
    "An AI sales manager with a budget it has to earn back. One link per drop: both teams' fans buy at full price, the winners get money back in USDC, and it never costs you more than the budget you set.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-accent={ACCENT} className={`${display.variable} ${body.variable}`}>
      <body>
        <header className="top">
          <div className="wrap">
            <a href="/" className="brand">
              TIFO
            </a>
            {NETWORK === "testnet" && <span className="badge">Testnet</span>}
            <nav>
              <a href="/drops" className="hide-sm">Live drops</a>
              <a href="/proof" className="hide-sm">Proof</a>
              <a href="/manage" className="btn sm">Make a drop</a>
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
              <a href="/drops">Live drops</a> · <a href="/manage">Make a drop</a> · <a href="/proof">Proof on chain</a>
            </p>
            <p>
              Built for the{" "}
              <a href="https://tameion.thecanteenapp.com" target="_blank" rel="noreferrer">
                Tameion Agents Hackathon
              </a>{" "}
              by Canteen and Circle.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
