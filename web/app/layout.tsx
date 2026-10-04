import type { Metadata } from "next";
import { Anton, Barlow } from "next/font/google";
import "./globals.css";
import { NETWORK } from "@/lib/chain";

const display = Anton({ weight: "400", subsets: ["latin"], variable: "--display" });
const body = Barlow({ weight: ["400", "500", "700"], subsets: ["latin"], variable: "--body" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://tifo.vercel.app"),
  title: "Tifo · matchday drops for small shops",
  description: "Fans of both teams buy at full price. The winners' fans get money back in USDC on Arc after the final whistle. The shop's worst case is capped before kickoff.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>
        <header className="top">
          <a href="/" className="brand">
            TIFO
          </a>
          {NETWORK === "testnet" && <span className="badge">Arc testnet</span>}
          <nav>
            <a href="/sell">Run a drop</a>
            <a href="/proof">Proof</a>
          </nav>
        </header>
        <main>{children}</main>
        <footer className="foot">
          Settled in USDC on Arc. Rebates are a fixed % of a full-price purchase, paid only if your team wins. Not a bet: you keep what you bought either way.
        </footer>
      </body>
    </html>
  );
}
