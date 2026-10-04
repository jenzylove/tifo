"use client";
// Circle Modular Wallets: a passkey (Face ID / fingerprint) owns a Circle smart account on Arc.
// Circle's paymaster sponsors gas, so a fan only ever needs USDC.
import { createPublicClient, encodeFunctionData, erc20Abi, keccak256, toBytes, type Address, type Hex } from "viem";
import { createBundlerClient, toWebAuthnAccount, type P256Credential, type SmartAccount, type WebAuthnAccount } from "viem/account-abstraction";
import { WebAuthnMode, toCircleSmartAccount, toModularTransport, toPasskeyTransport, toWebAuthnCredential } from "@circle-fin/modular-wallets-core";
import { tifoFactoryAbi, tifoPromoAbi, tifoShopsAbi } from "./abi";
import { FACTORY, NETWORK, SHOPS, USDC, chain } from "./chain";

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
    bundler: createBundlerClient({ chain, transport: modular }),
  };
}

const STORE = "tifo.circle.credential";

export function savedCredential(): P256Credential | null {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "null");
  } catch {
    return null;
  }
}

/** Create a new passkey wallet, or sign in with an existing passkey on this device. */
export async function connectCircle(mode: "register" | "login"): Promise<SmartAccount> {
  const { passkey, client } = transports();
  const credential =
    mode === "register"
      ? await toWebAuthnCredential({ transport: passkey, mode: WebAuthnMode.Register, username: `tifo-${Math.random().toString(36).slice(2, 8)}` })
      : await toWebAuthnCredential({ transport: passkey, mode: WebAuthnMode.Login });
  try {
    localStorage.setItem(STORE, JSON.stringify(credential));
  } catch {
    // storage unavailable: the wallet still works for this visit
  }
  return toCircleSmartAccount({ client, owner: toWebAuthnAccount({ credential }) as WebAuthnAccount });
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

/** Send calls as one user operation; Circle's paymaster pays the gas. */
async function send(account: SmartAccount, calls: Call[], failure: string) {
  const { bundler } = transports();
  const userOpHash = await bundler.sendUserOperation({ account, calls, paymaster: true });
  const { receipt, success } = await bundler.waitForUserOperationReceipt({ hash: userOpHash });
  if (!success) throw new Error(failure);
  return receipt;
}

/** Approve and buy in one sponsored user operation. Returns the on-chain transaction hash. */
export async function buyWithCircle(account: SmartAccount, promo: Address, side: 0 | 1, amount: bigint): Promise<Hex> {
  const orderRef = keccak256(toBytes(`${promo}:${account.address}:${Date.now()}`));
  const receipt = await send(
    account,
    [
      { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [promo, amount] }) },
      { to: promo, data: encodeFunctionData({ abi: tifoPromoAbi, functionName: "buy", args: [side, amount, orderRef] }) },
    ],
    "The payment was not accepted on chain. Nothing was charged.",
  );
  return receipt.transactionHash;
}

/** Publish the shop's page (handle, branding, links, catalog) to the registry. */
export async function saveShopWithCircle(account: SmartAccount, handle: string, profile: object): Promise<Hex> {
  const data = encodeFunctionData({ abi: tifoShopsAbi, functionName: "save", args: [handle, JSON.stringify(profile)] });
  return (await send(account, [{ to: SHOPS, data }], "Your shop page was not saved. Nothing changed.")).transactionHash;
}

export type CreatePromoArgs = Parameters<typeof encodeFunctionData<typeof tifoFactoryAbi, "createPromo">>[0]["args"];

/** Open a promo from the shop's own wallet, so sales go straight to it. Returns the promo address. */
export async function createPromoWithCircle(account: SmartAccount, args: NonNullable<CreatePromoArgs>): Promise<{ hash: Hex; promo: Address }> {
  const data = encodeFunctionData({ abi: tifoFactoryAbi, functionName: "createPromo", args });
  const receipt = await send(account, [{ to: FACTORY, data }], "The promo was not created. Nothing was charged.");
  const log = receipt.logs.find((l) => l.address.toLowerCase() === FACTORY.toLowerCase());
  if (!log?.topics[1]) throw new Error("Promo created but its address was not found in the receipt.");
  return { hash: receipt.transactionHash, promo: `0x${log.topics[1].slice(26)}` as Address };
}

/** Pay out USDC from the shop wallet (to an exchange deposit address on Arc, a supplier, etc.). */
export async function sendUsdcWithCircle(account: SmartAccount, to: Address, amount: bigint): Promise<Hex> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
  return (await send(account, [{ to: USDC, data }], "The transfer did not go through. Nothing was sent.")).transactionHash;
}
