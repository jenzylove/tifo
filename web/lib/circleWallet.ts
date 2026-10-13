"use client";
// Circle Modular Wallets: a passkey (Face ID / fingerprint) owns a Circle smart account on Arc.
// Circle's paymaster sponsors gas, so a fan only ever needs USDC.
import { createPublicClient, encodeFunctionData, erc20Abi, keccak256, toBytes, type Address, type Hex } from "viem";
import { createBundlerClient, formatUserOperationRequest, toWebAuthnAccount, type P256Credential, type SmartAccount, type UserOperation, type WebAuthnAccount } from "viem/account-abstraction";
import {
  createRpClient,
  getLoginOptions,
  getLoginVerification,
  getRegistrationOptions,
  getRegistrationVerification,
  getUserOperationGasPrice,
  toCircleSmartAccount,
  toModularTransport,
  toPasskeyTransport,
} from "@circle-fin/modular-wallets-core";
import { base64UrlToBytes, bytesToCryptoKey, cryptoKeyToBytes, parseCredentialPublicKey, parsePublicKey, serializePublicKey, verify as verifyP256 } from "webauthn-p256";
import { tifoAccountAbi, tifoFactoryAbi, tifoPromoAbi } from "./abi";
import { FACTORY, NETWORK, USDC, chain } from "./chain";

const CLIENT_KEY = process.env.NEXT_PUBLIC_CIRCLE_CLIENT_KEY ?? "";
const CLIENT_URL = "https://modular-sdk.circle.com/v1/rpc/w3s/buidl";
const CHAIN_PATH = NETWORK === "testnet" ? "arcTestnet" : "arc";

export const circleEnabled = () => CLIENT_KEY.length > 0;

function transports() {
  const passkey = toPasskeyTransport(CLIENT_URL, CLIENT_KEY);
  const modular = toModularTransport(`${CLIENT_URL}/${CHAIN_PATH}`, CLIENT_KEY);
  return {
    passkey,
    client: createPublicClient({ chain, transport: modular }),
    // Fees come from Circle's own gas price service. The node's default tip is far below the 1 gwei the mainnet
    // bundler requires, which made every operation fail its precheck.
    bundler: createBundlerClient({
      chain,
      transport: modular,
      userOperation: {
        async estimateFeesPerGas({ bundlerClient }) {
          const p = await getUserOperationGasPrice(bundlerClient);
          return { maxFeePerGas: BigInt(p.medium.maxFeePerGas), maxPriorityFeePerGas: BigInt(p.medium.maxPriorityFeePerGas) };
        },
      },
    }),
  };
}

const STORE = "tifo.circle.credential";

export function savedCredential(): P256Credential | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "null");
  } catch {
    return null;
  }
}

// iOS Safari only opens Face ID if navigator.credentials is called straight from the tap. Circle's
// toWebAuthnCredential fetches its options first, which spends that tap, so iPhones got "not allowed".
// We fetch the options ahead of time and call the passkey prompt as the very first thing on tap.
type Prepared = { at: number; reg: Awaited<ReturnType<typeof getRegistrationOptions>>; login: Awaited<ReturnType<typeof getLoginOptions>> };
let prepared: Prepared | null = null;
let preparing: Promise<Prepared> | null = null;
const FRESH_MS = 4 * 60_000;

/** Fetch passkey options before the user taps. Call when a wallet button appears. */
export function preparePasskey(): Promise<Prepared> {
  if (prepared && Date.now() - prepared.at < FRESH_MS) return Promise.resolve(prepared);
  if (preparing) return preparing;
  const rp = createRpClient({ transport: toPasskeyTransport(CLIENT_URL, CLIENT_KEY) });
  preparing = Promise.all([
    getRegistrationOptions(rp, { username: `tifo-${Math.random().toString(36).slice(2, 8)}` }),
    getLoginOptions(rp, { userId: "" }),
  ])
    .then(([reg, login]) => (prepared = { at: Date.now(), reg, login }))
    .finally(() => (preparing = null));
  return preparing;
}

/** True once options are ready, so a tap can open Face ID / fingerprint immediately. */
export const passkeyReady = () => !!prepared && Date.now() - prepared.at < FRESH_MS;

/** Create a new passkey wallet, or sign in with an existing passkey on this device. */
export async function connectCircle(mode: "register" | "login"): Promise<SmartAccount> {
  const ready = passkeyReady() ? prepared! : await preparePasskey();
  prepared = null; // options are single use
  const rp = createRpClient({ transport: toPasskeyTransport(CLIENT_URL, CLIENT_KEY) });
  let credential: P256Credential;
  if (mode === "register") {
    const o = ready.reg;
    const cred = (await navigator.credentials.create({
      publicKey: { ...o, challenge: base64UrlToBytes(o.challenge), user: { ...o.user, id: base64UrlToBytes(o.user.id) } } as PublicKeyCredentialCreationOptions,
    })) as PublicKeyCredential | null;
    if (!cred) throw new Error("No passkey was created.");
    await getRegistrationVerification(rp, { credential: cred as never });
    const pub = await parseCredentialPublicKey((cred.response as AuthenticatorAttestationResponse).getPublicKey()!);
    credential = { id: cred.id, publicKey: serializePublicKey(pub, { compressed: true }), raw: cred as never };
  } else {
    const o = ready.login;
    const cred = (await navigator.credentials.get({
      publicKey: {
        ...o,
        challenge: base64UrlToBytes(o.challenge),
        allowCredentials: o.allowCredentials?.map((c: { id: string }) => ({ ...c, id: base64UrlToBytes(c.id) })),
      } as PublicKeyCredentialRequestOptions,
    })) as PublicKeyCredential | null;
    if (!cred) throw new Error("No passkey was chosen.");
    const { publicKey } = await getLoginVerification(rp, { credential: cred as never });
    const pub = parsePublicKey(await cryptoKeyToBytes(await bytesToCryptoKey(base64UrlToBytes(publicKey))));
    credential = { id: cred.id, publicKey: serializePublicKey(pub, { compressed: true }), raw: cred as never };
  }
  preparePasskey().catch(() => {});
  try {
    localStorage.setItem(STORE, JSON.stringify({ id: credential.id, publicKey: credential.publicKey }));
  } catch {
    // storage unavailable: the wallet still works for this visit
  }
  const { client } = transports();
  return toCircleSmartAccount({ client, owner: toWebAuthnAccount({ credential }) as WebAuthnAccount });
}

/** What this device calls its passkey prompt. */
export function biometric(): string {
  if (typeof navigator === "undefined") return "Face ID or fingerprint";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && "ontouchend" in document)) return "Face ID";
  if (/Macintosh/.test(ua)) return "Touch ID";
  if (/Android/.test(ua)) return "fingerprint";
  return "passkey";
}

/** Plain words for wallet and passkey errors. */
export function walletError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  const name = (e as Error)?.name ?? "";
  if (typeof navigator !== "undefined" && /Instagram|FBAN|FBAV|Telegram|musical_ly|TikTok|Snapchat/i.test(navigator.userAgent + ((window as unknown as { TelegramWebviewProxy?: unknown }).TelegramWebviewProxy ? " Telegram" : "")))
    return `This app's built-in browser does not allow ${biometric()}. Open the link in your phone's own browser (Safari or Chrome) and try again. Nothing was charged.`;
  if (name === "NotAllowedError" || /not allowed by the user agent|NotAllowed|timed out|cancel/i.test(m))
    return `The ${biometric()} prompt was closed or timed out, so nothing was charged. Tap the button again and finish the prompt. If your passkey is on your phone, keep the phone nearby.`;
  if (name === "InvalidStateError" || /already registered/i.test(m)) return "This phone already has a Tifo wallet. Tap \"I already have one\".";
  if (/Credential Management API not supported|PublicKeyCredential/i.test(m)) return "This browser can't use passkeys. Open the link in Safari or Chrome.";
  // RPC errors from Circle hide the reason behind "An unknown RPC error occurred": surface code and details.
  const x = e as { code?: number; details?: string; shortMessage?: string; cause?: { code?: number; message?: string; details?: string } };
  console.error("[tifo] wallet error", e);
  const detail = x.details || x.cause?.details || x.cause?.message;
  const code = x.code ?? x.cause?.code;
  if (/unknown RPC error/i.test(m) || detail) {
    if (/domain|origin|rp ?id|not allowed/i.test(detail ?? "")) return `Circle refused this site's address for passkeys (${detail}). The passkey domain in Circle Console must be ${location.hostname}.`;
    if (/key|unauthori[sz]ed|forbidden|401|403/i.test(`${detail} ${code}`)) return `Circle refused the wallet key (${detail ?? code}). Check the client key for this network in Circle Console.`;
    return `Circle's wallet service said: ${detail ?? "no details"}${code ? ` (code ${code})` : ""}. Nothing was charged; try again in a minute.`;
  }
  return m.split("\n")[0];
}

export async function restoreCircle(): Promise<SmartAccount | null> {
  const credential = savedCredential();
  if (!credential) return null;
  const { client } = transports();
  return toCircleSmartAccount({ client, owner: toWebAuthnAccount({ credential }) as WebAuthnAccount });
}

export async function usdcBalance(address: Address): Promise<bigint> {
  const { client } = transports();
  return (await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] })) as bigint;
}

type Call = { to: Address; data: Hex };

/** Thrown when the phone refused the passkey prompt because the network work before it used up the tap
 * (iOS). The operation is already prepared, so calling `go` from a fresh tap opens Face ID immediately. */
export class NeedsTap<T = Hex> extends Error {
  constructor(public go: () => Promise<T>) {
    super("Tap again to confirm.");
  }
}

type Receipt = Awaited<ReturnType<ReturnType<typeof transports>["bundler"]["waitForUserOperationReceipt"]>>["receipt"];

/** Run send(), mapping its receipt to a result, including when the user has to tap again. */
async function sendAs<T>(account: SmartAccount, calls: Call[], failure: string, map: (r: Receipt) => T): Promise<T> {
  try {
    return map(await send(account, calls, failure));
  } catch (e) {
    if (e instanceof NeedsTap) {
      const go = (e as NeedsTap<Receipt>).go;
      throw new NeedsTap<T>(async () => map(await go()));
    }
    throw e;
  }
}

/** Send calls as one user operation; Circle's paymaster pays the gas. Prepares first, then signs, so the
 * passkey prompt comes as late and as close to the tap as possible. */
async function send(account: SmartAccount, calls: Call[], failure: string) {
  const { bundler } = transports();
  let prepared;
  try {
    prepared = await bundler.prepareUserOperation({ account, calls, paymaster: true });
  } catch (e) {
    console.error("[tifo] prepare failed", e);
    if (/invalid account signature/i.test(errorText(e)))
      throw new Error(
        `Circle refused wallet ${account.address.slice(0, 8)}… before your passkey was asked to sign (while pricing the gas). The wallet setup itself is not accepted, not your passkey. Nothing was charged.`,
      );
    throw e;
  }
  // Drop the account object before signing, but keep the paymaster address the service filled in. Removing it
  // sends the operation unsponsored, and a new wallet with no balance is then refused.
  const { account: _a, ...rest } = prepared as typeof prepared & { account?: unknown };
  const op = rest as unknown as UserOperation;
  if (typeof (op as { paymaster?: unknown }).paymaster !== "string") delete (op as { paymaster?: unknown }).paymaster;
  const submit = async () => {
    const signature = await account.signUserOperation(op);
    const hash = (await bundler.request({
      method: "eth_sendUserOperation",
      params: [formatUserOperationRequest({ ...op, signature }), account.entryPoint.address],
    } as never)) as Hex;
    const { receipt, success } = await bundler.waitForUserOperationReceipt({ hash });
    if (!success) throw new Error(failure);
    return receipt;
  };
  try {
    return await submit();
  } catch (e) {
    const name = (e as Error)?.name ?? "";
    const msg = String((e as Error)?.message ?? "");
    // A browser that blocked the prompt, a prompt that timed out and a prompt the person closed all end here.
    // Keep the prepared payment behind a "Confirm" button so one more tap retries it.
    if (name === "NotAllowedError" || /not allowed by the user agent|NotAllowed|timed out|operation either/i.test(msg)) {
      let used = false;
      throw new NeedsTap(async () => {
        if (used) throw new Error("This confirmation was already used. Start again.");
        used = true;
        return submit();
      });
    }
    if (/invalid account signature/i.test(errorText(e))) throw await diagnoseSignature(account, e);
    throw e;
  }
}

/** Every message and detail in an error and its causes, so a reason buried in `cause.details` is still found. */
function errorText(e: unknown): string {
  const out: string[] = [];
  for (let x = e as { message?: string; details?: string; shortMessage?: string; cause?: unknown } | undefined, i = 0; x && i < 6; x = x.cause as typeof x, i++)
    out.push(String(x.message ?? ""), String(x.details ?? ""), String(x.shortMessage ?? ""));
  return out.join(" ");
}

/** Circle refused the signature. Check it here: does this passkey actually sign for this wallet's key? */
async function diagnoseSignature(account: SmartAccount, original: unknown): Promise<Error> {
  try {
    const owner = (account as unknown as { owner?: WebAuthnAccount }).owner;
    if (!owner?.sign) return original as Error;
    const hash = keccak256(toBytes(`tifo-signature-check-${Date.now()}`));
    const { signature, webauthn } = await owner.sign({ hash });
    const ok = await verifyP256({ hash, publicKey: owner.publicKey, signature, webauthn: webauthn as never });
    console.error("[tifo] signature check", { wallet: account.address, publicKey: owner.publicKey, rpId: (webauthn as { authenticatorData?: string }).authenticatorData?.slice(0, 66), ok });
    return new Error(
      ok
        ? `Your passkey signed correctly for wallet ${account.address.slice(0, 8)}…, but Circle still refused it. This points at Circle's side (wallet version or domain). Nothing was charged. Your money is safe in this wallet.`
        : `The passkey you picked does not match wallet ${account.address.slice(0, 8)}…. Tap "Switch wallet" and pick the other passkey, or check which device created this wallet. Nothing was charged.`,
    );
  } catch (e) {
    return new Error(`Circle refused the signature, and the check could not finish (${(e as Error).message.split("\n")[0]}). Nothing was charged.`);
  }
}

/** Approve and buy in one sponsored user operation. Returns the on-chain transaction hash. */
export async function buyWithCircle(account: SmartAccount, promo: Address, side: 0 | 1, amount: bigint, orderRef: Hex, minRateBps: number): Promise<Hex> {
  return sendAs(
    account,
    [
      { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [promo, amount] }) },
      { to: promo, data: encodeFunctionData({ abi: tifoPromoAbi, functionName: "buy", args: [side, amount, orderRef, minRateBps] }) },
    ],
    "The payment was not accepted on chain. Nothing was charged.",
    (r) => r.transactionHash,
  );
}

export type CreatePromoArgs = Parameters<typeof encodeFunctionData<typeof tifoFactoryAbi, "createPromo">>[0]["args"];

/** Open a promo from the shop's own wallet, so sales go straight to it. Returns the promo address. */
export async function createPromoWithCircle(account: SmartAccount, args: NonNullable<CreatePromoArgs>): Promise<{ hash: Hex; promo: Address }> {
  const data = encodeFunctionData({ abi: tifoFactoryAbi, functionName: "createPromo", args });
  return sendAs(account, [{ to: FACTORY, data }], "The promo was not created. Nothing was charged.", (receipt) => {
    const log = receipt.logs.find((l) => l.address.toLowerCase() === FACTORY.toLowerCase());
    if (!log?.topics[1]) throw new Error("Promo created but its address was not found in the receipt.");
    return { hash: receipt.transactionHash, promo: `0x${log.topics[1].slice(26)}` as Address };
  });
}

/** Pay out USDC from the shop wallet (to an exchange deposit address on Arc, a supplier, etc.). */
export async function sendUsdcWithCircle(account: SmartAccount, to: Address, amount: bigint): Promise<Hex> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
  return sendAs(account, [{ to: USDC, data }], "The transfer did not go through. Nothing was sent.", (r) => r.transactionHash);
}

// ---------------------------------------------------------------- the seller's account

/** Open the seller's account with their weekly rule for the agent. Returns the transaction hash. */
export async function createAccountWithCircle(account: SmartAccount, weeklyBps: number, baseWeekly: bigint, perDealCap: bigint): Promise<Hex> {
  const data = encodeFunctionData({ abi: tifoFactoryAbi, functionName: "createAccount", args: [weeklyBps, baseWeekly, perDealCap] });
  return sendAs(account, [{ to: FACTORY, data }], "Your account was not created. Nothing changed.", (r) => r.transactionHash);
}

export async function setLimitsWithCircle(account: SmartAccount, tifoAccount: Address, weeklyBps: number, baseWeekly: bigint, perDealCap: bigint): Promise<Hex> {
  const data = encodeFunctionData({ abi: tifoAccountAbi, functionName: "setLimits", args: [weeklyBps, baseWeekly, perDealCap] });
  return sendAs(account, [{ to: tifoAccount, data }], "Your rule was not saved. Nothing changed.", (r) => r.transactionHash);
}

/** Approve or decline what the agent proposed above the rule. Approving opens the drop. */
export async function decideWithCircle(account: SmartAccount, tifoAccount: Address, id: number, approve: boolean): Promise<Hex> {
  const data = encodeFunctionData({ abi: tifoAccountAbi, functionName: "decide", args: [BigInt(id), approve] });
  return sendAs(account, [{ to: tifoAccount, data }], "Your answer was not recorded. Nothing changed.", (r) => r.transactionHash);
}

export async function withdrawFromAccountWithCircle(account: SmartAccount, tifoAccount: Address, to: Address, amount: bigint): Promise<Hex> {
  const data = encodeFunctionData({ abi: tifoAccountAbi, functionName: "withdraw", args: [to, amount] });
  return sendAs(account, [{ to: tifoAccount, data }], "The transfer did not go through. Nothing was sent.", (r) => r.transactionHash);
}

/** Open a drop through the seller's account, so its sales land there and it counts toward the week. */
export async function openViaAccountWithCircle(account: SmartAccount, tifoAccount: Address, args: NonNullable<CreatePromoArgs>): Promise<{ hash: Hex; promo: Address }> {
  const [fixtureId, closesAt, settleNotBefore, cap, minBps, maxBps, rateA, rateB, floorBps, drawBps, meta] = args;
  const data = encodeFunctionData({
    abi: tifoAccountAbi,
    functionName: "open",
    args: [{ fixtureId, closesAt, settleNotBefore, cap, minBps, maxBps, rateA, rateB, floorBps, drawBps }, meta],
  });
  return sendAs(account, [{ to: tifoAccount, data }], "The drop was not created. Nothing was charged.", (receipt) => {
    const log = receipt.logs.find((l) => l.address.toLowerCase() === FACTORY.toLowerCase());
    if (!log?.topics[1]) throw new Error("Drop created but its address was not found in the receipt.");
    return { hash: receipt.transactionHash, promo: `0x${log.topics[1].slice(26)}` as Address };
  });
}
