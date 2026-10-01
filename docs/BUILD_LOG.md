# Build log

| Date | Commit | What now works |
|---|---|---|
| 2026-10-01 | 4a0aea2 | PRD, plan, submission checklist |
| 2026-10-01 | 13c869a | Spikes: S1 live three-way odds from Polymarket's public API (153 match markets incl. Premier League 10 Oct) PASS; S2 ESPN + TheSportsDB agree on Premier League matchweek 5 results PASS; S4 Polymarket trading blocked from our server (`blocked: true`), so the hedge is cut. Core promo math in TypeScript: 8 tests including 2,000 simulated lopsided promos where the reserve always covers either result, stays under the cap, and every dollar is accounted for |
| 2026-10-01 | 03a2218 | `TifoPromo` + `TifoFactory` contracts: the reserve is the larger refund bill and the rest goes to the seller at sale; one side per wallet; the agent can only change future offers within bounds and propose a result; 15-min challenge window; the operator (not the seller) can correct; abandoned promos void after 3 days. 7 unit tests plus an invariant run (256 runs, 15,360 random calls, 0 violations) |
