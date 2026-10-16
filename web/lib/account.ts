"use client";
// One Circle wallet per tab, shared by every component that needs it.
import { useEffect, useSyncExternalStore } from "react";
import type { SmartAccount } from "viem/account-abstraction";
import { restoreCircle, savedCredential } from "./circleWallet";
import { onGoogleExpired, restoreGoogle } from "./googleWallet";

let account: SmartAccount | null = null;
let restoring: Promise<void> | null = null;
const listeners = new Set<() => void>();
// A Google session that can no longer be renewed signs the page out, so the sign-in screen shows again.
onGoogleExpired(() => setAccount(null));

export function setAccount(a: SmartAccount | null) {
  account = a;
  listeners.forEach((l) => l());
}

export function useAccount(): SmartAccount | null {
  const a = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => account,
    () => null,
  );
  useEffect(() => {
    // A Google sign-in is restored as it is; a passkey wallet is rebuilt from the saved public key.
    const g = !account ? restoreGoogle() : null;
    if (g) return setAccount(g as unknown as SmartAccount);
    if (!account && !restoring && savedCredential())
      restoring = restoreCircle()
        .then((r) => {
          if (r) setAccount(r);
        })
        .catch(() => {})
        .finally(() => (restoring = null));
  }, []);
  return a;
}
