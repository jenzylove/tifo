"use client";
// Sign in with Google: a Circle user-controlled wallet on Arc, made the first time a person signs in. No passkey,
// no Face ID. Each payment opens Circle's own confirmation window. It plugs into the same send path as passkey
// wallets, so every screen that can pay with a passkey wallet can pay with this one too.
import type { Address, Hex, Log } from "viem";
import { publicClient } from "./chain";

export const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
export const googleEnabled = () => GOOGLE_CLIENT_ID.length > 0;
let appId: Promise<string> | null = null;
const CIRCLE_APP_ID = () =>
  (appId ??= api<{ appId: string }>({ action: "config" }).then((r) => r.appId).catch((e) => {
    appId = null;
    throw e;
  }));

const SESSION = "tifo.google";
const DEVICE = "tifo.google.device";
const RETURN = "tifo.google.return";
export const GOOGLE_RETURN_PATH = "/auth/google";

interface Session {
  userToken: string;
  encryptionKey: string;
  refreshToken: string;
  at: number;
  walletId: string;
  address: Address;
  email?: string;
}

export interface GoogleAccount {
  kind: "google";
  address: Address;
  walletId: string;
  email?: string;
  signMessage(args: { message: string }): Promise<Hex>;
  send(calls: { to: Address; data: Hex }[], failure: string): Promise<{ transactionHash: Hex; logs: Log[] }>;
}

export const isGoogle = (a: unknown): a is GoogleAccount => !!a && (a as { kind?: string }).kind === "google";

type Sdk = import("@circle-fin/w3s-pw-web-sdk").W3SSdk;
let sdkPromise: Promise<Sdk> | null = null;

async function api<T>(body: Record<string, unknown>): Promise<T> {
  const r = await fetch("/api/ucw", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? "Circle did not answer. Try again in a minute.");
  return j as T;
}

function read<T>(k: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(k) ?? "null");
  } catch {
    return null;
  }
}
function write(k: string, v: unknown) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // storage blocked: the sign-in lasts for this visit only
  }
}

type LoginResult = { userToken: string; encryptionKey: string; refreshToken: string; oAuthInfo?: { socialUserInfo?: { email?: string } } };
const googleLogin = () => ({ clientId: GOOGLE_CLIENT_ID, redirectUri: location.origin + GOOGLE_RETURN_PATH, selectAccountPrompt: true });

/** One SDK per page. With a login callback it also reads Google's answer from the address bar (on /auth/google). */
async function sdk(onLogin?: (e: Error | undefined, r: LoginResult | undefined) => void): Promise<Sdk> {
  if (sdkPromise && !onLogin) return sdkPromise;
  sdkPromise = (async () => {
    const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
    const device = read<{ deviceToken: string; deviceEncryptionKey: string }>(DEVICE);
    const configs = {
      appSettings: { appId: await CIRCLE_APP_ID() },
      ...(device && onLogin ? { loginConfigs: { deviceToken: device.deviceToken, deviceEncryptionKey: device.deviceEncryptionKey, google: googleLogin() } } : {}),
    };
    return new W3SSdk(configs as never, onLogin as never);
  })();
  return sdkPromise;
}

/** Leave for Google. The person comes back to /auth/google, which finishes the sign-in and returns them here. */
export async function startGoogle(): Promise<void> {
  const s = await sdk();
  const deviceId = await s.getDeviceId();
  const { deviceToken, deviceEncryptionKey } = await api<{ deviceToken: string; deviceEncryptionKey: string }>({ action: "device", deviceId });
  write(DEVICE, { deviceId, deviceToken, deviceEncryptionKey });
  write(RETURN, location.pathname + location.search);
  s.updateConfigs({ appSettings: { appId: await CIRCLE_APP_ID() }, loginConfigs: { deviceToken, deviceEncryptionKey, google: googleLogin() } } as never, () => {});
  await s.performLogin("Google" as never);
}

function execute(s: Sdk, challengeId: string): Promise<{ status?: string; data?: { signature?: string; txHash?: string } } | undefined> {
  return new Promise((resolve, reject) =>
    s.execute(challengeId, (err, result) => {
      if (err) reject(new Error((err as Error).message || "The confirmation was closed. Nothing was charged."));
      else resolve(result as never);
    }),
  );
}

/** Called on /auth/google after Google sends the person back. Makes the wallet the first time. */
export function finishGoogle(): Promise<{ account: GoogleAccount; returnTo: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Google sign-in did not finish. Go back and try again.")), 60_000);
    sdk(async (err, result) => {
      clearTimeout(timer);
      try {
        if (err || !result) throw new Error(err?.message || "Google sign-in was cancelled.");
        const s = await sdkPromise!;
        s.setAuthentication({ userToken: result.userToken, encryptionKey: result.encryptionKey });
        let w = await api<{ walletId: string | null; address?: Address }>({ action: "wallet", userToken: result.userToken });
        if (!w.walletId) {
          const { challengeId } = await api<{ challengeId: string | null }>({ action: "init", userToken: result.userToken });
          if (challengeId) await execute(s, challengeId);
          for (let i = 0; i < 20 && !w.walletId; i++) {
            await new Promise((r) => setTimeout(r, 1500));
            w = await api({ action: "wallet", userToken: result.userToken });
          }
        }
        if (!w.walletId || !w.address) throw new Error("Your wallet is still being made. Try again in a minute.");
        const session: Session = {
          userToken: result.userToken,
          encryptionKey: result.encryptionKey,
          refreshToken: result.refreshToken,
          at: Date.now(),
          walletId: w.walletId,
          address: w.address,
          email: result.oAuthInfo?.socialUserInfo?.email,
        };
        write(SESSION, session);
        const returnTo = read<string>(RETURN) ?? "/manage";
        write(RETURN, null);
        resolve({ account: accountFrom(session), returnTo });
      } catch (e) {
        reject(e);
      }
    }).catch(reject);
  });
}

/** Circle's session token lasts about an hour; renew it before it runs out. */
async function fresh(): Promise<Session> {
  const s = read<Session>(SESSION);
  if (!s) throw new Error("You are signed out. Sign in with Google again.");
  if (Date.now() - s.at < 45 * 60_000) return s;
  const device = read<{ deviceId: string }>(DEVICE);
  try {
    const r = await api<{ userToken: string; encryptionKey: string; refreshToken: string }>({ action: "refresh", userToken: s.userToken, refreshToken: s.refreshToken, deviceId: device?.deviceId });
    const next = { ...s, ...r, at: Date.now() };
    write(SESSION, next);
    return next;
  } catch {
    write(SESSION, null);
    throw new Error("Your Google sign-in expired. Sign in with Google again. Nothing was charged.");
  }
}

async function confirm(challengeId: string) {
  const session = await fresh();
  const s = await sdk();
  s.setAuthentication({ userToken: session.userToken, encryptionKey: session.encryptionKey });
  const r = await execute(s, challengeId);
  if (r?.status && r.status !== "COMPLETE" && r.status !== "IN_PROGRESS" && r.status !== "PENDING") throw new Error("The confirmation did not go through. Nothing was charged.");
  return r;
}

function accountFrom(session: Session): GoogleAccount {
  return {
    kind: "google",
    address: session.address,
    walletId: session.walletId,
    email: session.email,
    async signMessage({ message }) {
      const { userToken } = await fresh();
      const { challengeId } = await api<{ challengeId: string }>({ action: "sign", userToken, walletId: session.walletId, message });
      const r = await confirm(challengeId);
      if (!r?.data?.signature) throw new Error("The signature did not come back. Try again.");
      return r.data.signature as Hex;
    },
    // Circle runs one call per confirmation, so a payment (approve, then buy) asks twice.
    async send(calls, failure) {
      let last: { transactionHash: Hex; logs: Log[] } | null = null;
      for (const call of calls) {
        const { userToken } = await fresh();
        type Tx = { id: string; state: string; txHash: string | null; errorReason: string | null };
        const before = new Set((await api<{ txs: Tx[] }>({ action: "txs", userToken, walletId: session.walletId })).txs.map((t) => t.id));
        const { challengeId } = await api<{ challengeId: string }>({ action: "exec", userToken, walletId: session.walletId, to: call.to, data: call.data });
        await confirm(challengeId);
        let hash: Hex | null = null;
        for (let i = 0; i < 60 && !hash; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          const { txs } = await api<{ txs: Tx[] }>({ action: "txs", userToken, walletId: session.walletId });
          const t = txs.find((x) => !before.has(x.id));
          if (t?.state === "FAILED" || t?.state === "CANCELLED" || t?.state === "DENIED") throw new Error(`${failure}${t.errorReason ? ` (${t.errorReason})` : ""}`);
          if (t?.txHash) hash = t.txHash as Hex;
        }
        if (!hash) throw new Error("The payment is taking longer than usual. Check your wallet in a minute before trying again.");
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
        if (receipt.status !== "success") throw new Error(failure);
        last = { transactionHash: receipt.transactionHash, logs: receipt.logs };
      }
      return last!;
    },
  };
}

export function restoreGoogle(): GoogleAccount | null {
  if (typeof localStorage === "undefined") return null;
  const s = read<Session>(SESSION);
  return s ? accountFrom(s) : null;
}

export function signOutGoogle() {
  write(SESSION, null);
}
