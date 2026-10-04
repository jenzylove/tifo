"use client";
// Circle Modular Wallets: a passkey (Face ID / fingerprint) owns a Circle smart account on Arc.
// Circle's paymaster sponsors gas, so a fan only ever needs USDC.
import { createPublicClient, encodeFunctionData, erc20Abi, keccak256, toBytes, type Address, type Hex } from "viem";
import { createBundlerClient, toWebAuthnAccount, type P256Credential, type SmartAccount, type WebAuthnAccount } from "viem/account-abstraction";
import { WebAuthnMode, toCircleSmartAccount, toModularTransport, toPasskeyTransport, toWebAuthnCredential } from "@circle-fin/modular-wallets-core";
import { tifoPromoAbi } from "./abi";
import { NETWORK, USDC, chain } from "./chain";

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

/** Approve and buy in one sponsored user operation. Returns the on-chain transaction hash. */
export async function buyWithCircle(account: SmartAccount, promo: Address, side: 0 | 1, amount: bigint): Promise<Hex> {
  const { bundler } = transports();
  const orderRef = keccak256(toBytes(`${promo}:${account.address}:${Date.now()}`));
  const userOpHash = await bundler.sendUserOperation({
    account,
    calls: [
      { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [promo, amount] }) },
      { to: promo, data: encodeFunctionData({ abi: tifoPromoAbi, functionName: "buy", args: [side, amount, orderRef] }) },
    ],
    paymaster: true,
  });
  const { receipt, success } = await bundler.waitForUserOperationReceipt({ hash: userOpHash });
  if (!success) throw new Error("The payment was not accepted on chain. Nothing was charged.");
  return receipt.transactionHash;
}
