"use client";
import { useEffect, useState } from "react";
import { circleEnabled, passkeyReady, preparePasskey } from "./circleWallet";

/** True once a tap can open the passkey prompt straight away. Wallet buttons wait for it, so the first tap never
 * fails on iPhones. After a few seconds it gives up waiting and lets the tap through anyway. */
export function usePasskeyReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!circleEnabled()) return;
    preparePasskey().catch(() => {});
    const started = Date.now();
    let lastTry = started;
    const t = setInterval(() => {
      const ok = passkeyReady() || Date.now() - started > 8_000;
      setReady(ok);
      // If fetching the options failed (a bad connection), try again every few seconds, not on every check.
      if (!passkeyReady() && Date.now() - lastTry > 5_000) {
        lastTry = Date.now();
        preparePasskey().catch(() => {});
      }
    }, 250);
    return () => clearInterval(t);
  }, []);
  return ready;
}
