"use client";
import { useEffect, useState } from "react";
import { passkeyReady, preparePasskey } from "./circleWallet";

/** True once a tap can open the passkey prompt straight away. Wallet buttons wait for it, so the first tap never
 * fails on iPhones. After a few seconds it gives up waiting and lets the tap through anyway. */
export function usePasskeyReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    preparePasskey().catch(() => {});
    const started = Date.now();
    const t = setInterval(() => {
      const ok = passkeyReady() || Date.now() - started > 8_000;
      setReady(ok);
      if (!passkeyReady()) preparePasskey().catch(() => {});
    }, 250);
    return () => clearInterval(t);
  }, []);
  return ready;
}
