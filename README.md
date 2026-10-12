# Tifo

**An AI sales manager with a budget it has to earn back.**

Built for the [Tameion Agents Hackathon](https://tameion.thecanteenapp.com) (Canteen × Circle), settled in USDC on [Arc](https://docs.arc.network/). Everything here was built during the event, which opened on 27 September 2026.

Live: [tifo.vercel.app](https://tifo.vercel.app)

## What it does

Someone who sells online gives Tifo one product and a budget. Tifo picks a real match, sets the offer and hands back one link to share.

- Fans of both teams buy at full price and pick their side.
- The first buyers on each side get the full price back if their team wins. It lands in their wallet about 20 minutes after full time: two result sources must agree, then a 15 minute correction window passes.
- On a draw every buyer gets a small thank you.
- The seller's cost is the same whoever wins and can never pass the budget. A contract enforces that, not a prompt.
- A digital product opens on the page the moment the buyer pays.
- After each match the seller sees what the drop brought in against what it cost.

## What the agent decides

It sizes the budget, picks the match, and chooses the offer. It checks the result against three sources and pays the winners. Every decision is written on chain with its reason. It can open drops by itself only inside a weekly rule the seller sets on their account contract. Anything bigger is a proposal the seller approves. It has no way to take money out.

## What you trust

- The contract caps the cost and only pays the wallet that ordered.
- Results come from public sources (ESPN, TheSportsDB, Polymarket) and two must agree.
- A team operator key can correct a wrong result inside the 15 minute window, and that is the one place you trust the team.

## How it answers "Agents and Ledgers"

The hackathon's required reading, [Agents and Ledgers in 2026](https://thecanteenapp.com/analysis/2026/09/12/agents-and-ledgers.html), names the mistakes an agent can make while the books still balance. This is where each one is stopped in Tifo.

| The reading asks for | In Tifo |
|---|---|
| Every entry points at a document | Every refund is computed from one stored order: buyer, amount and the offer locked at purchase. There is no free form "pay X" call. |
| No wrong payee | A refund can only go to the wallet that placed the order. The agent never supplies an address. |
| No duplicate on retry | An order reference is charged once (`DuplicateOrder`). Refunds move a cursor, so a repeated payout call pays nobody twice. |
| A witness in front of every write | A result is proposed only when two of three outside sources agree, then waits 15 minutes for a correction. If they disagree the agent proposes nothing and escalates. |
| The model's output is an input, never the release | The model picks the match and the terms. A contract checks the budget and the weekly rule, and plain math sets every amount. No model output releases money. |
| Agent writes go through the same code as people | The agent opens a drop through the same factory call a seller uses, so it inherits every check. Each call is simulated before it is sent. |
| Repair is loud, or it refuses | A wrong result is corrected by a new, named entry in the journal, never by an edit. A buyer shown an offer that has run out is refused (`OfferGone`), not quietly given less. |
| No fictitious entries | Every number on the site is read from the chain. There is no second ledger to drift from it. |

## Circle and Arc

USDC on Arc for payment, refunds and gas. Circle passkey wallets, so buyers and sellers sign with Face ID or a fingerprint. Circle Paymaster covers gas. Three contracts hold the rules: `TifoPromo` (one drop), `TifoFactory`, `TifoAccount` (the seller's standing rule for the agent).

## Run it

```bash
npm install
cd contracts && forge test        # 13 contract tests, including an invariant run
cd .. && npm test                 # 12 tests of the core math
cd web && npm run dev
```

The app needs the variables in `web/.env.local`. See `web/.env.example`.

## Where to look

| | |
|---|---|
| The plan and acceptance tests | [docs/PRD.md](docs/PRD.md) |
| What works, with transactions | [docs/BUILD_LOG.md](docs/BUILD_LOG.md) |
| Contracts | [contracts/src](contracts/src) |
| The money math | [packages/core/src/index.ts](packages/core/src/index.ts) |
| End to end runs on Arc testnet | [scripts/e2e-money.mts](scripts/e2e-money.mts), [scripts/e2e-delivery.mts](scripts/e2e-delivery.mts) |
