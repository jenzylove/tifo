# Tifo — PRD

Status: LOCKED 2026-10-01. Tameion Agents Hackathon (Canteen × Circle, on Arc).
Deadline: Sat 10 Oct 2026, 11:59 PM ET (Sun 11 Oct, 03:59 UTC). Target code freeze: Fri 9 Oct.

## One line

An AI sales rep for small shops. It runs weekend promos where fans of both teams in a match get money back if their team wins, and it keeps the shop's book balanced so the refund bill is known and capped whoever wins. Refunds land in USDC on Arc within seconds of the final whistle.

## Problem

1. **Small sellers can't make a promo anyone cares about.** Shops selling on X, Instagram and WhatsApp compete with plain discounts that nobody shares.
2. **Outcome promos work, but only big brands get them.**
   - Forme's World Cup promo ran with Playably and Kalshi: "100% back if the US reached the final". It drove 4x week-over-week menswear traffic. ([Modern Retail](https://www.modernretail.co/marketing/why-forme-launched-a-world-cup-promotion-hedged-on-kalshi/))
   - Playably works only on Shopify, takes about 14 days to launch, and pays refunds through Venmo or PayPal "within days" after the shopper fills in a claim form. ([playably.ai](https://playably.ai/))
   - SCA Promotions insures "money back if the team wins" deals for a fixed fee of 3–15% of the prize value. ([SCA](https://scapromotions.com/sports-rebates/))
3. **A one-sided promo is a bet the shop can't afford.** "30% back if Arsenal win" leaves the shop owing everything if the favourite wins. A small shop can't carry that swing.
4. **Refunds are slow and leaky.** Card and PayPal refunds take days, claim forms lose people, and most of the world can't receive Venmo.

Evidence still to add during the build (sourced only): real sellers' current promo spend and conversion; buyer reactions from the first live promos.

## User and front door

**Seller** (primary): a small shop that takes USDC, or is willing to, and whose buyers follow football or other sports. Examples: crypto merch, digital products, creators' stores, side shops run by people on X.

**Buyer**: a fan who already holds USDC, or can withdraw it to Arc from an exchange (13 exchanges, including Binance, Bybit, OKX, Coinbase and Kraken, support Arc USDC since 16 Sep 2026).

**First ten seconds, buyer:** the promo page reads "Man United v Tottenham · Sat 10 Oct". It shows two live meters, one per fan base, filling as people buy, and each side's current offer ("United fans: 30% back if United win" / "Spurs fans: 40% back if Spurs win"). The buyer picks a product and their side, then pays with a passkey wallet. After the match the refund lands, with a link to the transaction on Arc's explorer.

**First ten seconds, seller:** one chat with the agent. The seller writes: "I sell hoodies, my buyers are United and Spurs fans, budget $100." The agent proposes the match, both offers, the worst-case cost and the draw rule. Launch takes one click, and the seller watches the book live.

## Full scope (one build, nothing deferred silently)

1. **Promo contract (Arc).**
   - One promo per match, holding two sides plus the draw rule.
   - When a buyer pays, the rebate rate is fixed for that order at that moment.
   - From each sale, the contract keeps just enough in reserve so the reserve always covers the larger of the two possible refund bills, after counting any reserve the seller topped up. The rest goes to the seller immediately.
   - The agent's role is limited to three things: change the offer for **future** orders within limits the seller sets, close the promo at kickoff, and submit the result. It can never withdraw funds.
   - The agent proposes the result only when two independent sources (ESPN and TheSportsDB) agree. It's final after a 15-minute challenge window. During the window, an operator key (the team, not the seller, since the seller pays the refunds) can correct it. If the sources disagree, the agent proposes nothing and escalates. A postponed or abandoned match is voided: no rebates, and the reserve returns to the seller.
   - On settlement, the winning side's buyers are refunded automatically and the leftover reserve returns to the seller.
   - One side per wallet.
2. **The agent's decisions** (each logged with its reasons):
   - Picks the match: live fixtures, filtered by the seller's audience and timing.
   - Prices both sides from live odds (the Polymarket public API, cross-checked with the DraftKings odds on ESPN), the seller's budget and their margin.
   - Rebalances live: as sales skew toward one side, it raises the other side's offer and lowers or caps the heavy side, so neither refund bill exceeds the cap.
   - Decides when to stop taking orders on the heavy side. The contract never lets the larger refund bill exceed the seller's cap, and the reserve always covers it. (The prediction-market hedge was cut after spike S4.)
   - Settles: checks the final result against two sources, proposes it on chain with the source evidence hashed, and pushes refunds the moment the window closes. It escalates to the operator when the sources disagree.
   - Writes the promo copy and the result post.
3. **Business-money frame (RFB 4).** The shop's books show revenue in, promo budget, reserve held, refunds owed and paid, and surplus. The agent checks cash against the refunds owed before launching or raising an offer. It escalates to the seller only above their limits.
4. **Payments.**
   - Circle passkey wallets for buyers.
   - Paying in from other chains with Gateway or CCTP.
   - Direct payment from an exchange withdrawal to Arc.
5. **Seller app.** Agent chat, live book, books view and decision log.
6. **Buyer promo page.** Live meters, offers, checkout and refund status.
7. **Result posts.** The agent drafts the result post ("Spurs won. 23 Spurs fans just got 40% back, $96 total, refunded in 0.4s on Arc") with one-click sharing. It auto-posts to X only if API access allows.
8. **`/proof` page.** Every promo, order, rebalance decision, result check and refund, each linked to Arc mainnet.
9. **Test set.** Replays of past matches with real historical odds, showing the book stays within its cap under skewed sales. Published, misses included.

## How each judging criterion is met

| Criterion | How |
|---|---|
| Agentic sophistication (30%) | The agent chooses the match, prices risk from odds, rebalances live, decides how to cover what's left, checks results and settles. Every call moves money and carries a reason. Contract limits bound it, so it cannot talk its way past them. |
| Traction (30%) | Real sellers and real fans paying their own USDC on mainnet. Every weekend creates a public refund moment that brings the next wave. Metrics: sellers, distinct buyer wallets, USDC volume, refunds settled, and time from final whistle to refund. |
| Circle tool usage (20%) | USDC on Arc (gas and settlement), Circle Wallets (passkey), Gateway and CCTP for paying in from other chains, Paymaster/Gas Station so buyers never need gas, App Kit (Send, Bridge), and the promo contracts. |
| Innovation (20%) | A two-sided, self-balancing promo where the shop doesn't care who wins. No retailer, promo insurer or Tameion entry does it. |

## Claims and how each is proven

| Claim | Proof |
|---|---|
| Refunds land within seconds of the result | Timestamps of the result transaction and refund transactions on the Arc explorer, shown on `/proof` |
| The shop's worst case is known before kickoff | The contract enforces the reserve covers the larger bill. Shown live in the seller's book. Tested with skewed-sales replays |
| The agent cannot take the money | Contract roles and tests. The agent's key has no withdraw path |
| Real users | Distinct buyer wallets, sellers on video, mainnet transactions |

Any number shown on the site is read live from the chain or the API, or not shown.

## What it does not do

- It is not a sportsbook. Buyers pay full price for real goods. The refund is a fixed-percentage rebate on that purchase, not a prize or winnings, and there is no betting language anywhere. (Not legal advice. Each seller is responsible for promo rules in their market. Terms are shown on every promo.)
- It doesn't hold buyers' money beyond the capped reserve, and doesn't custody the seller's revenue.
- It doesn't cash out to banks.
- No yield on reserves: USYC is limited to allowlisted institutions with a $100k minimum.
- No local-currency stablecoins: StableFX is limited to approved institutions.
- It doesn't run promos on matches with no reliable two-source result.

## Risks and unknowns

| Risk | Status |
|---|---|
| Legal framing of picking a side | Known. Mitigated by framing it as a rebate, tying the side to the product edition where possible, clear terms, and no betting language. Stated plainly in Scope and limits |
| Recruiting 3–5 real sellers by Oct 4 | Known. The user owns this; the build has to be seller-ready by Oct 3 |
| Fan bases badly lopsided | Known. The agent rebalances and caps, and the reserve covers the rest; replay tests prove the cap holds |
| Polymarket hedge from an agent wallet | **Cut** after spike S4: Polymarket blocks trading from our server region (`blocked: true`). Coverage is the two-sided balance plus the capped reserve |
| Second result source and a free fixtures API | Needs a spike: football-data.org needs a free key, plus a second source |
| Passkey wallet + gasless checkout on Arc mainnet | Needs a spike |
| Auto-posting to X (API access and cost) | Needs a spike. The fallback is a drafted post with one-click share |

## Sponsor checklist

This becomes `docs/SUBMISSION_CHECKLIST.md`. It is ticked only from the live app.
