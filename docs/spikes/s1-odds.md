# S1: Live match odds

**Question:** Can we read live win/draw/win prices for upcoming matches without an account or key?

**Ran:** `GET https://gamma-api.polymarket.com/events?tag_slug=soccer&closed=false` (paged), keeping only the main result events (titles with "vs." and no " - " suffix), and parsing `outcomePrices`.

**Output (1 Oct 2026, 21:3x UTC, excerpt):**
- 153 open match-result events across 30 leagues: MLS, USL, Argentina, Brazil, Chile, Colombia, WSL, Finland, club friendlies and the UCL.
- Premier League Saturday 10 Oct is listed: `epl-ars-lee-2026-10-10` (Arsenal v Leeds, 11:30 UTC) and `epl-sun-bri-2026-10-10`.
- Example prices: `Arsenal FC vs. Lille OSC` → Arsenal 0.78 / Draw 0.14 / Lille 0.085; `Atlético de Madrid vs. Manchester United` → 0.435 / 0.25 / 0.32.
- Some low-liquidity markets show prices that don't add up (0.48 / 0.505 / 0.485).

**Verdict: PASS.** Polymarket's public API gives three-way prices for real fixtures, including the deadline-day Premier League games.
- The agent normalizes prices to probabilities (dividing by their sum) and refuses markets with liquidity under $2,000 or prices that don't add up to between 0.9 and 1.15.
- Reading prices is not geoblocked (trading is; see S4).
- A second odds source is not needed for the MVP; ESPN's scoreboard carries DraftKings odds and can be used as a cross-check.
