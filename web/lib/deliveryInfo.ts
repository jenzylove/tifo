// Where a physical order goes. The buyer adds it after paying; it is sealed for the drop's seller (see lib/delivery.ts)
// and kept as a small file named after the drop and the buyer's wallet. Only the seller, after signing with their own
// wallet, gets it opened.
import "server-only";
import { list, put } from "@vercel/blob";
import { decodeEventLog, keccak256, type Address, type Hex } from "viem";
import { tifoPromoAbi } from "./abi";
import { publicClient } from "./chain";
import { open, seal } from "./delivery";
import type { PromoSummary } from "./promos";

export interface DeliveryInfo {
  name: string;
  phone: string;
  address: string;
  note?: string;
}

export const infoEnabled = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN) && (process.env.DELIVERY_SECRET ?? "").length >= 32;
const path = (promo: string, buyer: string) => `addresses/${promo.toLowerCase()}/${buyer.toLowerCase()}.json`;

/** The wallet that paid in this transaction, if it holds an order on this drop with the buyer's secret as its reference. */
export async function paidBuyer(promo: PromoSummary, hash: Hex, secret: Hex): Promise<Address | null> {
  const receipt = await publicClient.getTransactionReceipt({ hash });
  if (receipt.status !== "success") return null;
  const want = keccak256(secret);
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== promo.address.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: tifoPromoAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "Sale" && (ev.args as { orderRef: Hex }).orderRef === want) return (ev.args as { buyer: Address }).buyer;
    } catch {
      // another event
    }
  }
  return null;
}

export async function saveInfo(promo: PromoSummary, owner: Address, buyer: Address, info: DeliveryInfo) {
  const body = JSON.stringify({ v: 1, buyer, at: Math.floor(Date.now() / 1000), sealed: seal(JSON.stringify(info), owner) });
  await put(path(promo.address, buyer), body, { access: "public", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 });
}

export async function readInfo(promo: PromoSummary, owner: Address): Promise<{ buyer: Address; at: number; info: DeliveryInfo | null }[]> {
  const { blobs } = await list({ prefix: `addresses/${promo.address.toLowerCase()}/`, limit: 1000 });
  const out = await Promise.all(
    blobs.map(async (b) => {
      try {
        const j = (await (await fetch(`${b.url}?t=${Date.now()}`, { cache: "no-store" })).json()) as { buyer: Address; at: number; sealed: string };
        let info: DeliveryInfo | null = null;
        try {
          info = JSON.parse(open(j.sealed, owner)) as DeliveryInfo;
        } catch {
          // sealed for someone else: not shown
        }
        return { buyer: j.buyer, at: j.at, info };
      } catch {
        return null;
      }
    }),
  );
  return out.filter((x): x is NonNullable<typeof x> => !!x && !!x.info);
}

export { viewMessage } from "./deliveryMessage";
