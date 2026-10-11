import type { Metadata } from "next";
import { Geist_Mono, Host_Grotesk } from "next/font/google";
import "./globals.css";
import { NETWORK } from "@/lib/chain";

const sans = Host_Grotesk({ subsets: ["latin"], variable: "--sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--mono" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://tifo.vercel.app"),
  title: "Tifo · turn any big match into sales",
  description:
    "An AI sales manager with a budget it has to earn back. Give it one product and it hands you a link. Fans of both teams buy, the winning side gets money back in USDC, and you never spend more than the budget you set.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <header className="top">
          <div className="bar">
            <a href="/" className="brand">
              <i />
              tifo
            </a>
            <nav>
              <a href="/drops" className="hide-sm">Drops</a>
              <a href="/proof" className="hide-sm">Proof</a>
              <a href="/manage" className="btn sm">Make a drop</a>
            </nav>
          </div>
        </header>
        <main>{children}</main>
        <footer className="foot">
          <div className="wrap">
            <div className="foot-top">
              <div>
                <a href="/" className="brand">
                  <i />
                  tifo
                </a>
                <p>An AI sales manager with a budget it has to earn back. One link per product, paid in USDC on Arc.</p>
              </div>
              <div>
                <h4>Product</h4>
                <ul>
                  <li><a href="/manage">Make a drop</a></li>
                  <li><a href="/drops">Drops</a></li>
                  <li><a href="/proof">Proof</a></li>
                </ul>
              </div>
              <div>
                <h4>Project</h4>
                <ul>
                  <li><a href="https://github.com/jenzylove/tifo" target="_blank" rel="noreferrer">Code</a></li>
                  <li><a href="https://tameion.thecanteenapp.com" target="_blank" rel="noreferrer">Tameion Agents Hackathon</a></li>
                  <li><a href="https://docs.arc.network" target="_blank" rel="noreferrer">Arc</a></li>
                </ul>
              </div>
            </div>
            <div className="foot-bottom">
              <span>© 2026 Tifo. You pay full price for a real product and keep it whatever happens.</span>
              <span>{NETWORK === "testnet" ? "Running on Arc testnet" : "Running on Arc"} · USDC by Circle</span>
            </div>
          </div>
          <div className="foot-word" aria-hidden>
            tifo
          </div>
        </footer>
      </body>
    </html>
  );
}
