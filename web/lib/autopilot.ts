// When the agent plans for a seller: it gathers what is on chain, applies the plain guards, and asks the planner.
import "server-only";
import type { Address } from "viem";
import { managerData } from "./manager";
import { shortTeam, upcomingMatches } from "./matches";
import { planFrom, type Plan } from "./planner";

export type { Plan, Terms } from "./planner";

const cache = new Map<string, Plan>();

/** What the agent would do for this seller right now. Reads only; `autopilotTick` in agent.ts sends it. */
export async function planFor(owner: Address, fresh = false): Promise<Plan> {
  const key = owner.toLowerCase();
  const hit = cache.get(key);
  if (hit && !fresh && Date.now() - hit.at < 20 * 60_000) return hit;
  const plan = await decide(owner);
  cache.set(key, plan);
  return plan;
}

async function decide(owner: Address): Promise<Plan> {
  const skip = (reason: string): Plan => ({ act: "skip", reason, at: Date.now() });
  const data = await managerData(owner);
  if (!data.account) return skip("You have not set a weekly rule yet, so I only act when you ask.");
  if (!data.drops.length) return skip("Make your first drop yourself so I know what you sell and at what price. After that I can run them for you.");
  // One drop at a time: the next one is planned with the last one's result in hand.
  const running = data.drops.find((d) => d.phase !== "settled");
  if (running) return skip(`Your ${shortTeam(running.meta.teamA)} v ${shortTeam(running.meta.teamB)} drop is still running. I will plan the next one when it settles.`);
  if (data.account.proposals.some((p) => p.status === "waiting")) return skip("I am waiting for your answer on my last proposal.");
  const fixtures = (await upcomingMatches(Date.now() + 3 * 3600_000, Date.now() + 6 * 86_400_000)).filter((m) => m.odds).slice(0, 25);
  return planFrom({ name: data.name, account: data.account, drops: data.drops, fixtures });
}
