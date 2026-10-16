// Everything the agent did, in one list, newest first. Read from the chain only: the decision notes it wrote into
// each drop's contract, and the drops, proposals and payouts it made through each seller's account.
import "server-only";
import type { Address } from "viem";
import { tifoAccountAbi } from "./abi";
import { publicClient, usd } from "./chain";
import { isCheckDrop, listPromos, promoJournal, promoState, type PromoSummary } from "./promos";
import { accountState } from "./tifoAccount";

export interface LogEntry {
  at: number;
  what: string; // a short label: "Read the result", "Opened a drop by itself"...
  why: string; // the agent's own words, as written on chain
  shop: string;
  drop?: Address; // the drop's contract (links to its page and to Arcscan)
  where: Address; // the contract that holds this record
  alone: boolean; // done without anyone clicking
}

const LABEL: Record<string, string> = {
  rates: "Changed the offer",
  result: "Read the result",
  opened: "Opened a drop by itself",
  "offer off": "Kept the offer off",
  referral: "Counted a referral",
  remainder: "Sent the rest back to the seller",
  proposed: "Proposed the result",
  final: "Settled the match",
  refunds: "Paid winning buyers back",
  corrected: "Result corrected by Tifo",
};

/** The agent writes "A", "B" or "Draw" for a result; say which team that is. */
function explain(kind: string, text: string, p: PromoSummary): string {
  if (kind === "remainder" && !text) return "The match is settled, so what was left of the money set aside went back to the seller.";
  const team = (o: string) => (o === "A" ? p.meta.teamA : o === "B" ? p.meta.teamB : null);
  if ((kind === "proposed" || kind === "final" || kind === "corrected") && /^(A|B|Draw|Void)$/.test(text.trim())) {
    const o = text.trim();
    const res = team(o) ? `${team(o)} won ${p.meta.teamA} v ${p.meta.teamB}` : o === "Draw" ? `${p.meta.teamA} v ${p.meta.teamB} was a draw` : "The match did not count, so every buyer is refunded";
    if (kind === "corrected") return `${res}. The result was corrected during the 15 minute window.`;
    return kind === "proposed" ? `${res}. Proposed on chain. For 15 minutes a separate Tifo key can correct it if it is wrong, then it is final.` : `${res}. Final, so the money back goes out to the winning side.`;
  }
  return text;
}

export async function agentLog(limit = 200): Promise<{ entries: LogEntry[]; drops: number; sellers: number }> {
  const promos = (await listPromos()).filter((p) => !isCheckDrop(p.meta));
  const byAddress = new Map(promos.map((p) => [p.address.toLowerCase(), p] as const));
  const entries: LogEntry[] = [];

  await Promise.all(
    promos.map(async (p) => {
      const st = await promoState(p.address).catch(() => null);
      if (!st?.journalCount) return;
      for (const j of await promoJournal(p.address, st.journalCount).catch(() => [])) {
        entries.push({
          at: j.at,
          what: LABEL[j.kind] ?? j.kind.charAt(0).toUpperCase() + j.kind.slice(1),
          why: explain(j.kind, j.text, p),
          shop: p.meta.shop ?? "A shop",
          drop: p.address,
          where: p.address,
          alone: j.kind !== "corrected", // a correction comes from Tifo's separate key, not the agent
        });
      }
    }),
  );

  // Sellers whose drops run through an account: what the agent did there.
  const sellers = [...new Set(promos.map((p) => p.seller.toLowerCase() as Address))];
  const probe = sellers.length ? await publicClient.multicall({ contracts: sellers.map((s) => ({ address: s, abi: tifoAccountAbi, functionName: "payout" }) as const) }) : [];
  const accounts = sellers.filter((_, i) => probe[i]?.status === "success");
  await Promise.all(
    accounts.map(async (acct) => {
      const a = await accountState(acct).catch(() => null);
      if (!a) return;
      const shopOf = (promo?: string) => (promo && byAddress.get(promo.toLowerCase())?.meta.shop) || promos.find((p) => p.seller.toLowerCase() === acct)?.meta.shop || "A shop";
      for (const d of a.deals.filter((d) => d.byAgent))
        entries.push({ at: d.at, what: "Opened a drop by itself", why: d.reason, shop: shopOf(d.promo), drop: d.promo, where: acct, alone: true });
      for (const pr of a.proposals)
        entries.push({
          at: pr.at,
          what: pr.status === "approved" ? "Asked first, the seller said yes" : pr.status === "declined" ? "Asked first, the seller said no" : "Asked the seller first",
          why: pr.reason,
          shop: shopOf(),
          where: acct,
          alone: false,
        });
      for (const po of a.payouts)
        entries.push({ at: po.at, what: `Sent ${usd(BigInt(po.amount))} to the seller`, why: po.reason, shop: shopOf(), where: acct, alone: true });
    }),
  );

  // The same drop opening can show twice: the account's record and the drop's own note. Keep one.
  const seen = new Set<string>();
  const unique = entries.filter((e) => {
    const k = e.what === "Opened a drop by itself" && e.drop ? `open:${e.drop.toLowerCase()}` : `${e.where}:${e.at}:${e.what}:${e.why}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => b.at - a.at);
  return { entries: unique.slice(0, limit), drops: promos.length, sellers: new Set(promos.map((p: PromoSummary) => p.seller.toLowerCase())).size };
}
