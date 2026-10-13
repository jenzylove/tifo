import { createPublicClient, defineChain, fallback, http, type Address } from "viem";

export const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Testnet Explorer", url: "https://explorer.testnet.arc.io" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

export const NETWORK = process.env.NEXT_PUBLIC_NETWORK === "testnet" ? "testnet" : "mainnet";
export const chain = NETWORK === "testnet" ? arcTestnet : arcMainnet;
export const USDC: Address = "0x3600000000000000000000000000000000000000";
export const FACTORY = (process.env.NEXT_PUBLIC_FACTORY ?? "0x0000000000000000000000000000000000000000") as Address;
export const FACTORY_BLOCK = BigInt(process.env.NEXT_PUBLIC_FACTORY_BLOCK ?? "0");

// Override with a dedicated provider (Alchemy, QuickNode, dRPC) if the public RPC throttles.
export const RPC_URL = process.env.NEXT_PUBLIC_ARC_RPC_URL || chain.rpcUrls.default.http[0];
// On the server, testnet calls go through the Canteen hosted Arc node first (the URL carries our builder token, so it
// is never sent to the browser) and fall back to the public RPC if that node refuses a call or is down.
const CANTEEN_RPC = typeof window === "undefined" && NETWORK === "testnet" ? process.env.ARC_RPC_URL : undefined;
const publicRpc = http(RPC_URL, { batch: true, retryCount: 3 });
export const transport = CANTEEN_RPC ? fallback([http(CANTEEN_RPC, { retryCount: 1, timeout: 8_000 }), publicRpc]) : publicRpc;
export const publicClient = createPublicClient({ chain, transport });

// Practice version: the same app deployed on Arc testnet, where anyone can try a drop with free test USDC.
// The real site reads its drops (reads only) to list them under the real ones, each linking to the practice site.
export const PRACTICE_URL = (process.env.NEXT_PUBLIC_PRACTICE_URL ?? "").replace(/\/$/, "");
export const MAIN_URL = (process.env.NEXT_PUBLIC_MAIN_URL ?? "").replace(/\/$/, "");
const PRACTICE_FACTORY = (process.env.NEXT_PUBLIC_PRACTICE_FACTORY ?? "") as Address;
export const practice =
  NETWORK === "mainnet" && PRACTICE_URL && /^0x[0-9a-fA-F]{40}$/.test(PRACTICE_FACTORY)
    ? { url: PRACTICE_URL, factory: PRACTICE_FACTORY, client: createPublicClient({ chain: arcTestnet, transport: http(arcTestnet.rpcUrls.default.http[0], { batch: true, retryCount: 3 }) }) as unknown as typeof publicClient }
    : null;

/** Where a set of drops lives: the factory to read and the client that reads it. */
export interface Source {
  factory: Address;
  client: typeof publicClient;
}
export const mainSource: Source = { factory: FACTORY, client: publicClient };

export const explorerTx =(h: string) => `${chain.blockExplorers.default.url}/tx/${h}`;
export const explorerAddr = (a: string) => `${chain.blockExplorers.default.url}/address/${a}`;

/** USDC base units (6 decimals) to a display string. */
export function usd(units: bigint | number): string {
  const n = Number(units) / 1e6;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const pct = (bps: number | bigint) => `${(Number(bps) / 100).toFixed(Number(bps) % 100 === 0 ? 0 : 1)}%`;
