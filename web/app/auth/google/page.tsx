"use client";
// Google sends the person back here after they pick their account. We finish the Circle sign-in, make their wallet the
// first time, and return them to the page they started from.
import { useEffect, useState } from "react";
import type { SmartAccount } from "viem/account-abstraction";
import { setAccount } from "@/lib/account";
import { finishGoogle } from "@/lib/googleWallet";

export default function GoogleReturn() {
  const [err, setErr] = useState("");
  useEffect(() => {
    finishGoogle()
      .then(({ account, returnTo }) => {
        setAccount(account as unknown as SmartAccount);
        location.replace(returnTo.startsWith("/") ? returnTo : "/manage");
      })
      .catch((e) => setErr((e as Error).message));
  }, []);
  return (
    <div className="wrap signin">
      <div className="panel">
        <span className="orb" style={{ width: 54, height: 54 }} />
        {err ? (
          <>
            <h1>Google sign-in did not finish</h1>
            <p className="status err">{err}</p>
            <a className="btn" href="/manage">Go back</a>
          </>
        ) : (
          <>
            <h1>Signing you in…</h1>
            <p className="muted">Setting up your wallet. This takes a few seconds the first time.</p>
          </>
        )}
      </div>
    </div>
  );
}
