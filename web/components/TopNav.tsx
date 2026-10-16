"use client";
// The header's links. On a phone they fold into one menu, so live drops, your shop, your wallet and signing out
// are always one tap away from any page.
import { useEffect, useRef, useState } from "react";
import { setAccount, useAccount } from "@/lib/account";
import { savedCredential, signOutCircle } from "@/lib/circleWallet";
import { restoreGoogle, signOutGoogle } from "@/lib/googleWallet";

export default function TopNav() {
  const acct = useAccount();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setSaved(!!savedCredential() || !!restoreGoogle()), [acct]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const signedIn = !!acct || saved;
  const signOut = () => {
    signOutCircle();
    signOutGoogle();
    setAccount(null);
    location.href = "/";
  };

  return (
    <nav ref={box}>
      <a href="/drops" className="hide-sm">Live drops</a>
      <a href="/proof" className="hide-sm">Proof</a>
      {signedIn && <a href="/manage" className="hide-sm">Your shop</a>}
      <a href="/manage?new=1" className="btn sm">Make a drop</a>
      <button className="menu-btn" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <i />
        <i />
      </button>
      {open && (
        <div className="menu">
          <a href="/drops">Live drops</a>
          <a href="/manage?new=1">Make a drop</a>
          {signedIn && <a href="/manage">Your shop</a>}
          <a href="/wallet">Wallet</a>
          <a href="/proof">Proof</a>
          {signedIn && (
            <button className="link" onClick={signOut}>
              Sign out
            </button>
          )}
        </div>
      )}
    </nav>
  );
}
