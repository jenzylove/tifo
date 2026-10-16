import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { NETWORK } from "@/lib/chain";
import { limit, tooMany } from "@/lib/ratelimit";

// Google sign-in wallets (Circle user-controlled wallets). The browser holds the user's own session token; this route
// adds the server's Circle key and passes the call on. Every call acts only for the user whose token it carries.
const API = "https://api.circle.com/v1/w3s";
const KEY = () => (process.env.CIRCLE_WALLETS_API_KEY || process.env.CIRCLE_API_KEY || "").trim();
const CHAIN = NETWORK === "testnet" ? "ARC-TESTNET" : "ARC";
const hex = (s: unknown) => typeof s === "string" && /^0x([0-9a-fA-F]{2})*$/.test(s) && s.length <= 40_000;
const uuid = (s: unknown) => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);

async function circle(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const r = await fetch(`${API}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      authorization: `Bearer ${KEY()}`,
      "content-type": "application/json",
      ...(init.token ? { "x-user-token": init.token } : {}),
    },
    body: init.body ? JSON.stringify({ idempotencyKey: crypto.randomUUID(), ...(init.body as object) }) : undefined,
    cache: "no-store",
  });
  const j = (await r.json().catch(() => ({}))) as { data?: Record<string, unknown>; code?: number; message?: string };
  return { ok: r.ok, status: r.status, data: j.data ?? {}, code: j.code, message: j.message };
}

export async function POST(req: Request) {
  const rl = limit(req, "ucw", 120, 10 * 60_000);
  if (!rl.ok) return tooMany(rl.retryAfter);
  if (!KEY()) return NextResponse.json({ error: "Google sign-in is not set up on this site." }, { status: 503 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const token = typeof b.userToken === "string" ? b.userToken : undefined;
  const fail = (r: { status: number; code?: number; message?: string }) =>
    NextResponse.json({ error: r.message ?? "Circle did not answer.", code: r.code }, { status: r.status >= 400 && r.status < 600 ? r.status : 502 });

  switch (b.action) {
    case "device": {
      if (typeof b.deviceId !== "string" || b.deviceId.length > 200) return NextResponse.json({ error: "bad request" }, { status: 400 });
      const r = await circle("/users/social/token", { body: { deviceId: b.deviceId } });
      return r.ok ? NextResponse.json({ deviceToken: r.data.deviceToken, deviceEncryptionKey: r.data.deviceEncryptionKey }) : fail(r);
    }
    case "refresh": {
      if (!token || typeof b.refreshToken !== "string" || typeof b.deviceId !== "string") return NextResponse.json({ error: "bad request" }, { status: 400 });
      const r = await circle("/users/token/refresh", { token, body: { refreshToken: b.refreshToken, deviceId: b.deviceId } });
      return r.ok ? NextResponse.json({ userToken: r.data.userToken, encryptionKey: r.data.encryptionKey, refreshToken: r.data.refreshToken }) : fail(r);
    }
    case "init": {
      if (!token) return NextResponse.json({ error: "bad request" }, { status: 400 });
      const r = await circle("/user/initialize", { token, body: { accountType: "SCA", blockchains: [CHAIN] } });
      if (r.ok) return NextResponse.json({ challengeId: r.data.challengeId });
      if (r.code === 155106) return NextResponse.json({ challengeId: null }); // already has a wallet
      return fail(r);
    }
    case "wallet": {
      if (!token) return NextResponse.json({ error: "bad request" }, { status: 400 });
      const r = await circle(`/wallets?blockchain=${CHAIN}&pageSize=50`, { token });
      if (!r.ok) return fail(r);
      const w = ((r.data.wallets as { id: string; address: string; blockchain: string; state: string }[]) ?? []).find((x) => x.blockchain === CHAIN && x.state === "LIVE");
      return NextResponse.json(w ? { walletId: w.id, address: w.address } : { walletId: null });
    }
    case "exec": {
      if (!token || !uuid(b.walletId) || typeof b.to !== "string" || !isAddress(b.to) || !hex(b.data)) return NextResponse.json({ error: "bad request" }, { status: 400 });
      const r = await circle("/user/transactions/contractExecution", { token, body: { walletId: b.walletId, contractAddress: b.to, callData: b.data, feeLevel: "MEDIUM" } });
      return r.ok ? NextResponse.json({ challengeId: r.data.challengeId }) : fail(r);
    }
    case "sign": {
      if (!token || !uuid(b.walletId) || typeof b.message !== "string" || b.message.length > 2000) return NextResponse.json({ error: "bad request" }, { status: 400 });
      const r = await circle("/user/sign/message", { token, body: { walletId: b.walletId, message: b.message, encodedByHex: false } });
      return r.ok ? NextResponse.json({ challengeId: r.data.challengeId }) : fail(r);
    }
    case "txs": {
      if (!token || !uuid(b.walletId)) return NextResponse.json({ error: "bad request" }, { status: 400 });
      const r = await circle(`/transactions?walletIds=${b.walletId}&pageSize=10`, { token });
      if (!r.ok) return fail(r);
      const txs = ((r.data.transactions as Record<string, unknown>[]) ?? []).map((t) => ({ id: t.id, state: t.state, txHash: t.txHash ?? null, createDate: t.createDate, errorReason: t.errorReason ?? null }));
      return NextResponse.json({ txs });
    }
    default:
      return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}
