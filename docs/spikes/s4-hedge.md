# S4: Prediction-market hedge from the agent

**Question:** Can the agent's wallet buy and redeem a Polymarket position to cover any leftover imbalance?

**Ran:** `GET https://polymarket.com/api/geoblock` from the agent's server.

**Output:** `{"blocked":true,"ip":"160.79.106.22","country":"US","region":"IL"}`

**Verdict: FAIL. The hedge is cut.** Polymarket blocks trading from this server's region. Running the agent from another region to get around the block is not something we will do. Polymarket US needs KYC'd individual accounts, which an autonomous agent wallet can't satisfy for a hackathon build.

**Changed plan:** coverage comes only from the two-sided balance plus the capped reserve held in the promo contract. The worst case is still known and capped before kickoff. Polymarket stays a read-only odds source (S1). Listed under "cut" in the PRD.
