"use client";
// Browser wallet helpers (any EIP-1193 wallet: MetaMask, Rabby, Coinbase Wallet, exchange wallets).
import { createWalletClient, custom, numberToHex, type Address, type EIP1193Provider } from "viem";
import { chain } from "./chain";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export function hasWallet() {
  return typeof window !== "undefined" && !!window.ethereum;
}

export async function connect(): Promise<{ address: Address; client: ReturnType<typeof createWalletClient> }> {
  if (!window.ethereum) throw new Error("No wallet found. Open this page in a wallet browser or install MetaMask or Rabby.");
  const [address] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(chain.id) }] });
  } catch {
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: numberToHex(chain.id),
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http,
          blockExplorerUrls: [chain.blockExplorers!.default.url],
        },
      ],
    });
  }
  const client = createWalletClient({ account: address, chain, transport: custom(window.ethereum) });
  return { address, client };
}
