import { createPublicClient, defineChain, http, type Address } from "viem";

export const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
});

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Testnet Explorer", url: "https://explorer.testnet.arc.io" } },
  testnet: true,
});

export const NETWORK = process.env.NEXT_PUBLIC_NETWORK === "testnet" ? "testnet" : "mainnet";
export const chain = NETWORK === "testnet" ? arcTestnet : arcMainnet;
export const USDC: Address = "0x3600000000000000000000000000000000000000";
export const FACTORY = (process.env.NEXT_PUBLIC_FACTORY ?? "0x0000000000000000000000000000000000000000") as Address;
export const FACTORY_BLOCK = BigInt(process.env.NEXT_PUBLIC_FACTORY_BLOCK ?? "0");

export const publicClient = createPublicClient({ chain, transport: http() });

export const explorerTx = (h: string) => `${chain.blockExplorers.default.url}/tx/${h}`;
export const explorerAddr = (a: string) => `${chain.blockExplorers.default.url}/address/${a}`;

/** USDC base units (6 decimals) to a display string. */
export function usd(units: bigint | number): string {
  const n = Number(units) / 1e6;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const pct = (bps: number | bigint) => `${(Number(bps) / 100).toFixed(Number(bps) % 100 === 0 ? 0 : 1)}%`;
