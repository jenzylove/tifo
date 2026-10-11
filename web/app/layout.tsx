import type { Metadata } from "next";
import { Geist_Mono, Host_Grotesk } from "next/font/google";
import "./globals.css";
import Logo from "@/components/Logo";
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
            <Logo />
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
                <Logo size={30} />
                <p>An AI sales manager with a budget it has to earn back.</p>
              </div>
              <nav>
                <a href="/manage">Make a drop</a>
                <a href="/drops">Drops</a>
                <a href="/proof">Proof</a>
                <a href="https://github.com/jenzylove/tifo" target="_blank" rel="noreferrer">
                  GitHub
                </a>
              </nav>
            </div>
            <div className="foot-bottom">
              <span>© 2026 Tifo</span>
              <span>{NETWORK === "testnet" ? "On Arc testnet" : "On Arc"} · paid in USDC</span>
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
