# Tifo — Plan

Today: Thu 1 Oct 2026. Deadline: Sat 10 Oct, 11:59 PM ET (Sun 11 Oct, 03:59 UTC).

Match calendar:
- The Premier League is on international break until 6 Oct.
- This weekend (3–6 Oct) has international matches and NFL week 5.
- The Premier League returns Sat 10 Oct (MW6), with Arsenal v Leeds, Chelsea v Bournemouth and Man United v Tottenham. Saturday matches settle before the deadline.

## Phases (each ends with a check that proves it is done)

### Phase 0: Spikes (Thu 1 – Fri 2 Oct)
| Spike | Question | Done when |
|---|---|---|
| S1 Odds | Can we read live two-way odds for upcoming matches (Polymarket public API plus one more source)? | A script prints both sides' prices for 3 real upcoming fixtures |
| S2 Fixtures & results | Can we get fixtures and final results from two independent free sources? | A script prints last weekend's results from both sources, and they match |
| S3 Checkout | Can a fan pay USDC on Arc mainnet with a passkey wallet, with no gas token? | A real $1 payment on the Arc explorer |
| S4 Hedge | Can an agent wallet buy and redeem a Polymarket position, and get USDC there and back with CCTP? | One small position bought, or a documented "no" that cuts the hedge |
| S5 Posting | Can the agent post to X? | One post made, or the share-link fallback chosen |

Results are written up in `docs/spikes/<name>.md`.

### Phase 1: Core logic (Fri 2 Oct)
- Pure functions: price both sides from odds, budget and margin. Compute the refund bill for each result, the required reserve and the rebalance step.
- Unit tests, plus replay tests on past matches with skewed sales.
- **Check:** the tests pass, and the replays show the reserve always covers the larger refund bill.

### Phase 2: Promo contract (Fri 2 – Sat 3 Oct)
- The contract does: buy, rate fixed per order, reserve kept from each sale and the rest forwarded to the seller, the agent's bounded role, settlement on two agreeing sources or the seller's signature, refunds, return of leftover reserve, one side per wallet.
- Foundry tests, including an invariant: the reserve is always at least the larger refund bill.
- Deploy to Arc testnet, then Arc mainnet.
- **Check:** a full promo on mainnet with real tiny amounts: two buys, settle, refund, leftover returned, all linked on the explorer.

### Phase 3: First real promo (Sat 3 – Sun 4 Oct)
- A minimal promo page with checkout. The agent prices and the seller launches by chat (a simple version is fine).
- Run one real promo with a real seller on a weekend match (an international or NFL game). Settle it and refund real buyers.
- **Check:** distinct buyer wallets on mainnet, refunds settled, a screen recording of a real buyer.

### Phase 4: The full agent (Mon 5 – Wed 7 Oct)
- Seller chat, match picking, live rebalancing, the decision to cover what's left at kickoff, the two-source result check and settlement, posts.
- The business-money view: books, reserve, refunds, surplus, and escalation above the seller's limits.
- The `/proof` page.
- **Check:** a simulated skewed promo rebalances live on testnet. Then a real mid-week promo (Champions League or other fixtures if available, otherwise the next weekend).

### Phase 5: Design and audit (Wed 7 – Fri 9 Oct)
- Design pass (its own look, checked in dark and light), release readiness audit, secrets scan, README.
- **Check:** the audit's findings are fixed or listed under Scope and limits; screenshots approved by the user.

### Phase 6: Deadline day promos (Sat 10 Oct)
- Promos on the Premier League MW6 Saturday matches. Settle them, refund buyers, post the results.
- Demo video, submission form, traction answers.
- **Check:** the form is submitted before 11:59 PM ET, with links to live refunds.

## Risks

| Risk | Status |
|---|---|
| Seller recruitment | Known. The user starts lining up sellers now |
| Legal framing | Known. Rebate framing, terms, no betting language |
| Odds and result APIs | Needs a spike (S1, S2) |
| Passkey checkout on mainnet | Needs a spike (S3) |
| Polymarket hedge | Needs a spike (S4). It can be cut without breaking the product |
| X posting | Needs a spike (S5). Share-link fallback |
| GitHub repo creation | Known. This session can't create repos; the user creates `jenzylove/tifo` |
