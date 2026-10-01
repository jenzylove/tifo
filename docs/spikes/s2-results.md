# S2: Fixtures and final results from two independent sources

**Question:** Can we get fixtures and final scores from two free, independent sources that agree?

**Ran:**
- ESPN: `GET https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=20260920` (no key). Note: a date range in this format returned a non-JSON response, so the agent queries one day at a time.
- TheSportsDB: `GET https://www.thesportsdb.com/api/v1/json/123/eventsround.php?id=4328&r=5&s=2026-2027` (free key "123").

**Output:** Premier League matchweek 5 (19–20 Sep 2026)
| Match | ESPN | TheSportsDB |
|---|---|---|
| Bournemouth v Liverpool | 0–1 FT | 0–1 FT |
| Leeds v Crystal Palace | 0–0 FT | 0–0 FT |
| Man City v Sunderland | 5–3 FT | 5–3 FT |
| Fulham v Man United | 1–1 FT | 1–1 FT |

ESPN NFL scoreboard also works (week 4, 16 games listed).

**Verdict: PASS.** Two independent free sources agree, and the agent settles only when both report full time with the same score. If they disagree or one is missing, it escalates instead of settling.
