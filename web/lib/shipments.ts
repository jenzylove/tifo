// Delivery of physical orders. Drops opened on the newer factory hold the seller's share of each sale until the buyer
// has the product (see TifoPromo.markSent / confirmReceived). Older drops have no hold and return null here.
import type { Address } from "viem";
import { tifoPromoAbi } from "./abi";
import { publicClient } from "./chain";

export const DELIVERY = ["None", "Held", "Sent", "Disputed", "Released", "Refunded"] as const;
export type DeliveryState = (typeof DELIVERY)[number];

export interface Shipment {
  state: DeliveryState;
  sentAt: number;
  held: bigint;
  tracking: string;
}

export interface Deliveries {
  holdSecs: number;
  list: Shipment[]; // same index as the drop's orders
}

/** null when the drop does not hold payment (digital, or opened before delivery holds existed). */
export async function readDeliveries(promo: Address, count: number, client = publicClient): Promise<Deliveries | null> {
  try {
    const holdSecs = Number(await client.readContract({ address: promo, abi: tifoPromoAbi, functionName: "holdSecs" }));
    if (!holdSecs) return null;
    const list: Shipment[] = [];
    for (let start = 0; start < count; start += 200) {
      const page = await client.readContract({ address: promo, abi: tifoPromoAbi, functionName: "getShipments", args: [BigInt(start), 200n] });
      for (const s of page) list.push({ state: DELIVERY[Number(s.state)] ?? "None", sentAt: Number(s.sentAt), held: s.held, tracking: s.tracking });
    }
    return { holdSecs, list };
  } catch {
    return null; // an older drop without the delivery functions
  }
}

/** What a step is due on an order right now, if anything: pay the seller, or return an unsent order to the buyer. */
export function dueAction(s: Shipment, orderAt: number, holdSecs: number, now: number): "release" | "refundUnsent" | null {
  if (s.state === "Sent" && now >= s.sentAt + holdSecs) return "release";
  if (s.state === "Held" && now >= orderAt + holdSecs) return "refundUnsent";
  return null;
}
