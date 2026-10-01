import type { Metadata } from "next";
import "./globals.css";
import { NETWORK } from "@/lib/chain";

export const metadata: Metadata = {
  title: "Tifo",
  description: "Match promos for small shops. Fans of both teams buy; the winners' fans get money back in USDC on Arc after the final whistle.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <a href="/" className="brand">TIFO</a>
          {NETWORK === "testnet" && <span className="badge">Arc testnet</span>}
          <nav>
            <a href="/sell">Run a promo</a>
            <a href="/proof">Proof</a>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
