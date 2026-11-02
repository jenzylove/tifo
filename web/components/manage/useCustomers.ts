"use client";
// The seller's private customer list in the browser. Opening it takes one wallet confirmation; the server then gives a
// 12 hour token, kept only in this tab's session storage.
import { useCallback, useEffect, useState } from "react";
import type { SmartAccount } from "viem/account-abstraction";
import { walletError } from "@/lib/circleWallet";
import { sessionMessage, type Customer } from "@/lib/customers";

const KEY = (a: string) => `tifo.customers.${a.toLowerCase()}`;
const readToken = (a: string) => {
  try {
    const t = sessionStorage.getItem(KEY(a));
    return t && Number(t.split(".")[1]) > Date.now() / 1000 + 60 ? t : null;
  } catch {
    return null;
  }
};

export interface CustomersApi {
  ready: boolean; // unlocked and loaded
  customers: Customer[];
  sent: Record<string, string[]>;
  busy: string;
  error: string;
  unlock: () => Promise<void>;
  save: (list: Customer[]) => Promise<void>;
  importFrom: (x: { text?: string; image?: { data: string; mediaType: string }; shop: string | null }) => Promise<{ found: number; added: number } | null>;
  toggleSent: (drop: string, id: string, on: boolean) => Promise<void>;
}

export function useCustomers(acct: SmartAccount): CustomersApi {
  const [token, setToken] = useState<string | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sent, setSent] = useState<Record<string, string[]>>({});
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const call = useCallback(
    async (path: string, init: RequestInit = {}, t = token) => {
      const r = await fetch(path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${t}` }, cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) {
        try {
          sessionStorage.removeItem(KEY(acct.address));
        } catch {}
        setToken(null);
        setReady(false);
      }
      if (!r.ok) throw new Error(j.error ?? "Something went wrong.");
      return j;
    },
    [token, acct.address],
  );

  const load = useCallback(
    async (t: string) => {
      const j = await call("/api/customers", {}, t);
      setCustomers(j.customers);
      setSent(j.sent);
      setReady(true);
    },
    [call],
  );

  useEffect(() => {
    const t = readToken(acct.address);
    if (t) {
      setToken(t);
      load(t).catch((e) => setError((e as Error).message));
    }
  }, [acct.address]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run<T>(label: string, f: () => Promise<T>): Promise<T | null> {
    setBusy(label);
    setError("");
    try {
      return await f();
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy("");
    }
  }

  return {
    ready,
    customers,
    sent,
    busy,
    error,
    unlock: async () => {
      setBusy("Confirm it is you…");
      setError("");
      try {
        const at = Math.floor(Date.now() / 1000);
        const signature = await acct.signMessage({ message: sessionMessage(acct.address, at) });
        const r = await fetch("/api/customers/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: acct.address, at, signature }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        try {
          sessionStorage.setItem(KEY(acct.address), j.token);
        } catch {}
        setToken(j.token);
        await load(j.token);
      } catch (e) {
        setError(walletError(e));
      } finally {
        setBusy("");
      }
    },
    save: async (list) => {
      await run("Saving…", async () => {
        const j = await call("/api/customers", { method: "PUT", body: JSON.stringify({ customers: list }) });
        setCustomers(j.customers);
        setSent(j.sent);
      });
    },
    importFrom: (x) =>
      run("Reading your customers…", async () => {
        const j = await call("/api/customers/import", { method: "POST", body: JSON.stringify(x) });
        setCustomers(j.customers);
        setSent(j.sent);
        return { found: j.found as number, added: j.added as number };
      }),
    toggleSent: async (drop, id, on) => {
      const d = drop.toLowerCase();
      setSent((s) => ({ ...s, [d]: on ? [...new Set([...(s[d] ?? []), id])] : (s[d] ?? []).filter((x) => x !== id) }));
      await call("/api/customers/sent", { method: "POST", body: JSON.stringify({ drop, id, sent: on }) })
        .then((j) => setSent(j.sent))
        .catch((e) => setError((e as Error).message));
    },
  };
}

/** A screenshot, made small enough to send: at most 1600px wide, JPEG. Read in the browser, never uploaded to storage. */
export async function shrinkImage(file: File): Promise<{ data: string; mediaType: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = bad;
      i.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return { data: c.toDataURL("image/jpeg", 0.85).split(",")[1], mediaType: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(url);
  }
}
