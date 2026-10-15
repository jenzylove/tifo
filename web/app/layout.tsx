import type { Metadata } from "next";
import TopNav from "@/components/TopNav";
import { Geist_Mono, Host_Grotesk } from "next/font/google";
import "./globals.css";
import Logo from "@/components/Logo";
import { MAIN_URL, NETWORK, practice } from "@/lib/chain";

const sans = Host_Grotesk({ subsets: ["latin"], variable: "--sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--mono" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://tifo.vercel.app"),
  title: "Tifo · turn any big match into sales",
  description:
    "Your matchday sales, run by an agent. Put your stock on a big match: buyers get money back in USDC if their team wins, you know the most it can cost before you post, and an agent runs the money inside a weekly limit you set.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        {NETWORK === "testnet" && (
          <div className="practice-bar">
            Practice version: test USDC only, nothing is shipped.{" "}
            <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">Get test USDC</a>
            {MAIN_URL && (
              <>
                {" · "}
                <a href={MAIN_URL}>Go to the real site</a>
              </>
            )}
          </div>
        )}
        <header className="top">
          <div className="bar">
            <Logo />
            <TopNav />
          </div>
        </header>
        <main>{children}</main>
        <footer className="foot">
          <div className="wrap">
            <div className="foot-top">
              <div>
                <Logo size={30} />
                <p>Your matchday sales, run by an agent.</p>
              </div>
              <nav>
                <a href="/manage?new=1">Make a drop</a>
                <a href="/drops">Live drops</a>
                <a href="/proof">Proof</a>
                <a href="/wallet">Wallet</a>
                {practice && <a href="/drops#practice">Try with test money</a>}
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
