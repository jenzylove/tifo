// Services sold by the time slot (a consultation, a hair appointment, a lesson). Each slot has its own order
// reference, and the drop contract refuses a reference it has already been paid for (DuplicateOrder), so a slot
// can be paid for once and only once. Nothing else has to remember who booked what.
import { encodePacked, keccak256, type Address, type Hex } from "viem";
import { tifoPromoAbi } from "./abi";
import { publicClient } from "./chain";

export const slotRef = (promo: Address, i: number): Hex => keccak256(encodePacked(["string", "address", "uint256"], ["tifo-slot", promo, BigInt(i)]));

/** Which slots are already paid for, read from the drop contract. */
export async function bookedSlots(promo: Address, count: number, client = publicClient): Promise<boolean[]> {
  if (!count) return [];
  const r = await client.multicall({
    allowFailure: true,
    contracts: Array.from({ length: count }, (_, i) => ({ address: promo, abi: tifoPromoAbi, functionName: "usedRef", args: [slotRef(promo, i)] }) as const),
  });
  return r.map((x) => x.status === "success" && x.result === true);
}

export const slotLabel = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
