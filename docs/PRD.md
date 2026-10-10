# Tifo PRD

Status: RELOCKED 2026-10-10 (first lock 2026-10-01). Tameion Agents Hackathon (Canteen × Circle, on Arc).

Deadlines:
- Arc Microgrants: Wed 14 Oct 2026, 11:59 PM ET (Thu 15 Oct, 03:59 UTC). Needs a working app on Arc mainnet.
- Tameion: Sat 17 Oct 2026, 11:59 PM ET (Sun 18 Oct, 03:59 UTC).

## One line

Tifo is an AI sales manager with a budget it has to earn back. A seller gives it a small promo budget. It turns big matches into deal links ("free if your team wins"), keeps the cost inside the budget whoever wins, pays the winners in USDC on Arc seconds after full time, and reports what the deal earned against what it cost.

## Reframe

Small sellers don't have a money management problem. They have a money arriving problem. Every other agent manages money going out. This one brings money in, and can never spend more than it was given.

## What changed from the first lock

| Before | Now | Why |
|---|---|---|
| Storefront, shop registry, catalog editor | One link per deal, plus a QR | Sellers already sell in posts and DMs. A storefront made Tifo a second Shopify and buried the one new idea |
| Seller is any small shop | Sellers whose buyers already hold USDC: digital goods and CT sellers first | Buyers need no crypto lesson. Digital goods deliver on the page |
| Agent runs a formula on a timer | Agent owns a budget, makes the calls, and is scored on return | The rubric marks down "a cron job with a language model bolted on" |
| "30% back" for everyone | Agent picks the offer shape, including "free for the first N per side" | A full refund is a post people share. The budget is the same |
| A draw pays nothing | A draw pays every buyer a small thank you | Every match ends in a payout and a post |

## The money, in plain numbers

Tifo does not remove the cost of a promo. It does two things: it makes the cost the same whichever team wins, and it locks the most it can ever be before the first sale.

- The seller sets a **budget** in dollars. The contract refuses any sale that would push the refund bill past it (`OverCap`). This is already built and tested.
- The agent turns the budget into an offer. Example: a $20 product, a $100 budget.
  - Shape A, everyone: about 30% back, for roughly the first 16 buyers per side.
  - Shape B, headline: free for the first 5 buyers per side.
  - Once a side's spots are gone, that side drops to the floor offer. People can still buy.
- The worst case is the budget, here $100, and only if a team wins. A draw costs far less.
- **Break even** is shown before launch and again after: budget ÷ profit per sale. Digital product with $20 profit: 5 extra sales pays for the deal. Physical product with $8 profit: 13 extra sales.
- The agent will not launch a deal the seller's margin cannot carry. A thin margin gets a small offer or few spots, and the agent says so.

## Problem

1. **Small sellers can't make a promo anyone shares.** Discount codes are everywhere and nobody posts about them.
2. **Outcome promos work, but only big brands get them.**
   - Forme's World Cup promo ("100% back if the US reached the final") drove 4x week over week traffic. ([Modern Retail](https://www.modernretail.co/marketing/why-forme-launched-a-world-cup-promotion-hedged-on-kalshi/))
   - The tools that run them work on Shopify only, take about two weeks to launch, and pay refunds days later through a claim form.
   - Promo insurers charge 3 to 15% of the prize value and pay claims in 3 to 7 business days.
3. **A one sided promo is a swing a small seller can't carry.** "Free if Arsenal win" leaves the seller owing everything when the favourite wins.
4. **Refunds are slow and leaky.** Card refunds take days, claim forms lose people, and most of the world can't receive the usual payout apps.
5. **Nobody tells the seller if the promo paid off.** They spend, then guess.

## Users and front door

**Seller:** someone who sells online to people who hold USDC. Digital products, services, merch, creators on X.

**Buyer:** one of the seller's own followers.

**Seller's first minute:** one screen. Product name, photo, price, profit per sale, budget. The agent replies with the match, both offers, the most it can cost, and how many extra sales pay for it. One tap gives a link, a QR and a ready post.

**Buyer's first ten seconds:** one page. The product, the match, two sides with the spots left on each, "free if your team wins". Pick a side, pay with Face ID, no gas, from Arc or another chain. A digital product unlocks on the page. After full time the refund lands with a link to the transaction.

## Full scope (one build)

1. **Deal contract (Arc).** Already built: rate locked per order, reserve equals the larger refund bill, the rest to the seller at once, hard budget cap, agent can only change future offers within bounds and propose results, 15 minute correction window, one side per wallet. **To add:** the draw thank you (reserve covers the largest of three bills), and a floor offer after spots fill.
2. **Seller account contract.** The seller's sales land here. One rule set by the seller: the share of the last 7 days of sales the agent may commit to deals each week, and a per deal limit. The agent funds deal reserves from it inside those limits and can never withdraw. Anything above the limit is a proposal the seller approves.
3. **The agent's calls**, each logged on chain with its reason:
   - sizes the budget from the seller's real sales and profit per sale
   - picks the match for that seller's audience
   - picks the offer shape (everyone, or free spots) and prices both sides from live odds
   - live: trims, pauses or reopens a side; tops up a deal's reserve from the seller account inside the limit
   - refuses a deal the margin can't carry, and says why
   - settles on 2 of 3 result sources, pays refunds, returns what's left
   - after each deal: writes the scorecard and uses it to change the next deal
4. **Scorecard.** Per deal and per seller, read from chain: sales brought, refunds paid, kept, break even hit or missed. Public.
5. **Payments.** Circle passkey wallets, gas sponsored by Circle Paymaster, USDC on Arc, pay in from other chains through Gateway or CCTP.
6. **Deal page.** Product first, spots meter, checkout, digital delivery, refund status, share card before and after the result.
7. **Seller screen.** Create a deal, see open deals, the account, the scorecard, the agent's log, approvals.
8. **Result posts.** Drafted by the agent with one tap sharing.
9. **`/proof`.** Every deal, order, agent call, result check and refund, each linked to Arc mainnet.
10. **Removed:** storefront pages, shop registry, catalog editor, shop branding.

## Acceptance tests

| # | Test | Passes when |
|---|---|---|
| 1 | Budget holds | No sequence of sales can make the refund bill exceed the budget (invariant run, three outcomes) |
| 2 | Free spots | With a $100 budget and a $20 product, the sixth buyer on a side gets the floor offer, not a full refund |
| 3 | Draw | A draw pays every buyer the thank you rate and returns the rest to the seller |
| 4 | Account limit | The agent's attempt to commit more than the weekly share reverts and shows as an approval request |
| 5 | Refusal | Given a profit per sale too thin for the asked offer, the agent declines and proposes a smaller one |
| 6 | Learning | After a lopsided deal, the agent's next proposal for that seller opens with different offers and cites the last deal |
| 7 | Cross chain pay in | A buyer with USDC on another chain buys on a mainnet deal |
| 8 | Digital delivery | The product unlocks only after the sale transaction confirms |
| 9 | Settlement | A real match settles with no human touch: result, refunds and remainder, all on mainnet |
| 10 | Scorecard | Numbers on the scorecard match the chain to the cent |
| 11 | One screen | A new seller goes from nothing to a live deal link without leaving one screen |
| 12 | Traction | Real sellers other than the test wallets, real buyers, mainnet refunds, all listed in `TRACTION.md` |

## How each judging criterion is met

| Criterion | How |
|---|---|
| Agentic sophistication (30%) | The agent owns a budget and makes every call that moves money: size, match, shape, pause, top up, refuse, settle. It explains each one on chain and changes its next deal from the last. Contract limits bound it |
| Traction (30%) | Each deal is a post and each result is a second post. Real sellers, real buyers, mainnet USDC. Measured: sellers, buyer wallets, volume, refunds, seconds from full time to refund |
| Circle tool usage (20%) | USDC on Arc, Circle Wallets (passkey), Paymaster, Gateway or CCTP pay in, contracts for budget, limits and reserve |
| Innovation (20%) | A two sided promo where the seller's cost is the same whoever wins, run by an agent scored on return |

## What it does not do

- It is not a sportsbook. Buyers pay full price for a real product. The refund is a rebate on that purchase. No betting words anywhere. (Not legal advice. Each seller is responsible for promo rules in their market.)
- It does not remove the cost of a promo. It caps it and makes it known.
- It does not reach buyers who hold no USDC.
- It does not hedge on prediction markets (cut after spike S4).
- No yield on reserves and no local currency stablecoins: both are limited to approved institutions.

## Risks

| Risk | Status |
|---|---|
| Sellers may not find the cost worth it | Open. Only real deals answer it. Break even is shown before and after |
| Buyers need USDC | Known. Target sellers whose followers already hold it |
| Physical delivery trust | Known. Digital goods first; physical is the same trust as any DM sale |
| Legal framing of picking a side | Known. Rebate framing, terms on every deal |
| Mainnet: funding, Circle mainnet client key, Paymaster on mainnet | Needs the user: about 5 USDC for the deployer and a mainnet Circle key |
| Cross chain pay in on mainnet | Needs a spike |
