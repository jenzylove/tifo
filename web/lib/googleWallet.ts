"use client";
// Sign in with Google: a Circle user-controlled wallet on Arc, made the first time a person signs in. No passkey,
// no Face ID. Each payment opens Circle's own confirmation window. It plugs into the same send path as passkey
// wallets, so every screen that can pay with a passkey wallet can pay with this one too.
import { decodeAbiParameters, decodeErrorResult, erc20Abi, keccak256, toBytes, type Address, type BaseError, type Hex, type Log } from "viem";
import { tifoAccountAbi, tifoFactoryAbi, tifoPromoAbi } from "./abi";
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

/** The payment left the wallet but Arc has not confirmed it yet. Paying again could pay twice, so the person is told to wait. */
export class PendingError extends Error {
  constructor() {
    super("Your payment was sent and is still confirming on Arc. Don't pay again: refresh this page in a minute to see it.");
    this.name = "PendingError";
  }
}

const APPROVE = "0x095ea7b3";
const USER_OP_EVENT = keccak256(toBytes("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)"));
const ERRORS = [...tifoPromoAbi, ...tifoFactoryAbi, ...tifoAccountAbi].filter((x) => x.type === "error");

/** True when the bundle carried this wallet's operation and the operation itself failed. */
function opFailed(logs: Log[], wallet: Address): boolean {
  const ev = logs.find((l) => l.topics[0] === USER_OP_EVENT && l.topics[2] && `0x${l.topics[2].slice(26)}`.toLowerCase() === wallet.toLowerCase());
  if (!ev) return false;
  const [, success] = decodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], ev.data);
  return !success;
}

/** The contract's own reason for refusing (OfferGone, Closed...), so the page can explain it. */
function revertName(e: unknown): string | null {
  const data = (e as BaseError)?.walk?.((x) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | null;
  if (!data?.data) return null;
  try {
    return decodeErrorResult({ abi: ERRORS, data: data.data }).errorName;
  } catch {
    return null;
  }
}

/** The checkout shows which step the person is on while Google's windows open one after another. */
let progress: ((text: string) => void) | null = null;
export function onGoogleProgress(cb: ((text: string) => void) | null) {
  progress = cb;
}

/** Called when the Google session can no longer be renewed, so the page shows sign-in again. */
let expired: (() => void) | null = null;
export function onGoogleExpired(cb: () => void) {
  expired = cb;
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
    expired?.();
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
    // Circle runs one call per confirmation, so a payment (allow USDC, then buy) can ask twice.
    async send(calls, failure) {
      // Skip an approval the wallet already gave: one confirmation instead of two, and nothing to redo after a retry.
      const todo: { to: Address; data: Hex }[] = [];
      for (const call of calls) {
        if (call.data.startsWith(APPROVE)) {
          const [spender, amount] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], `0x${call.data.slice(10)}`);
          const has = await publicClient.readContract({ address: call.to, abi: erc20Abi, functionName: "allowance", args: [session.address, spender] }).catch(() => 0n);
          if (has >= amount) continue;
        }
        todo.push(call);
      }
      let last: { transactionHash: Hex; logs: Log[] } | null = null;
      for (const [i, call] of todo.entries()) {
        progress?.(todo.length > 1 ? `Step ${i + 1} of ${todo.length}: ${call.data.startsWith(APPROVE) ? "allow the payment" : "pay"}. Confirm in the Google window.` : "Confirm in the Google window.");
        // Check the call first, so a closed sale or a changed offer is explained before anything is signed.
        await publicClient.call({ account: session.address, to: call.to, data: call.data }).catch((e) => {
          throw new Error(revertName(e) ?? failure);
        });
        const { userToken } = await fresh();
        type Tx = { id: string; state: string; txHash: string | null; errorReason: string | null; refId: string | null; direction: string | null; contractAddress: string | null };
        const before = new Set((await api<{ txs: Tx[] }>({ action: "txs", userToken, walletId: session.walletId }).catch(() => ({ txs: [] as Tx[] }))).txs.map((t) => t.id));
        const refId = `tifo-${crypto.randomUUID()}`;
        const { challengeId } = await api<{ challengeId: string }>({ action: "exec", userToken, walletId: session.walletId, to: call.to, data: call.data, refId });
        await confirm(challengeId);
        progress?.("Sent. Waiting for Arc to confirm…");
        let hash: Hex | null = null;
        for (let n = 0; n < 80 && !hash; n++) {
          await new Promise((r) => setTimeout(r, 1500));
          const { txs } = await api<{ txs: Tx[] }>({ action: "txs", userToken, walletId: session.walletId }).catch(() => ({ txs: [] as Tx[] }));
          // Our reference first; failing that, a new outgoing call to the same contract. Never an incoming transfer.
          const t =
            txs.find((x) => x.refId === refId) ??
            txs.find((x) => !before.has(x.id) && x.direction !== "INBOUND" && x.contractAddress?.toLowerCase() === call.to.toLowerCase());
          if (!t) continue;
          if (t.state === "FAILED" || t.state === "CANCELLED" || t.state === "DENIED") throw new Error(`${failure}${t.errorReason ? ` (${t.errorReason})` : ""}`);
          if (t.txHash && (t.state === "COMPLETE" || t.state === "CONFIRMED")) hash = t.txHash as Hex;
        }
        if (!hash) throw new PendingError();
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 }).catch(() => {
          throw new PendingError();
        });
        // A smart wallet's call runs inside a bundle: the bundle can succeed while this wallet's call failed.
        if (receipt.status !== "success" || opFailed(receipt.logs, session.address)) throw new Error(failure);
        last = { transactionHash: receipt.transactionHash, logs: receipt.logs };
      }
      if (!last) throw new Error(failure);
      return last;
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
