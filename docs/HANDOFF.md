# Handoff (written 1 Oct 2026, 22:50 UTC)

Read this first in the next session, then `docs/PRD.md`, `docs/PLAN.md` and `docs/BUILD_LOG.md`.

## Live
- App: https://tifo.vercel.app (currently on **Arc testnet**; a badge says so)
- Factory (testnet): `0x9cda0b646353dAc380156dAedc30892323876CEE`, deploy block 65012576
- First real promo (testnet): `0x1d5b6d812f6868e36015d74ad7761914bfe2a837`, Seattle v Sporting KC, kickoff 2 Oct 01:30 UTC. 4 fan buys, 1 agent rebalance. **Check that the scheduler settled it** (result proposed, then refunds) and record the tx hashes in BUILD_LOG.
- Scheduler: GitHub Actions `tick.yml`, every 10 minutes, calls `/api/tick` (secrets `TIFO_URL` and `TICK_SECRET` are set). The first manual run succeeded.

## Keys and config (never commit)
- `/home/user/tifo/.env`: deployer, agent and operator keys, RPCs, `TICK_SECRET`, Circle test client key. **This container is temporary. Recreate it from Vercel env vars and the user if it's lost.** The agent key lives in Vercel as `AGENT_PRIVATE_KEY`. The deployer and operator keys exist only in this `.env`. If they're lost, deploy a new factory with new keys (the testnet promo is disposable).
- `/home/user/tifo-launch/testnet-wallets.env`: seller and fan test wallets
- Vercel project `tifo` (team jenzyloves-projects): env `NEXT_PUBLIC_NETWORK=testnet`, `NEXT_PUBLIC_FACTORY`, `NEXT_PUBLIC_FACTORY_BLOCK`, `AGENT_PRIVATE_KEY`, `TICK_SECRET`, `ANTHROPIC_API_KEY`, `NEXT_PUBLIC_CIRCLE_CLIENT_KEY`
- Deploying: Vercel blocks git-linked CLI deploys, so deploy from a clean copy: `git archive HEAD | tar -x -C /tmp/tifo-deploy && cp -r .vercel /tmp/tifo-deploy && cd /tmp/tifo-deploy && npx vercel deploy --prod --yes --token $VERCEL_TOKEN`
- Circle Console (testnet): client key created; passkey domain set to `tifo.vercel.app`

## Done
Spikes S1 odds, S2 results, S3 gasless permit checkout, S5 share-link posting, and S6 Circle passkey wallet with paymaster all pass. S4 (Polymarket hedge) is cut. Contracts plus invariant tests, core math plus replay tests, seller chat (Claude, verified live), promo page with Circle wallet checkout, `/proof`, three-source settlement, CI.

## Next (in order)
1. Confirm the Seattle v SKC settlement and refunds from the scheduler.
2. User test: create a Circle wallet on a phone with a fresh testnet promo. Open one on an upcoming match (`scripts/e2e-testnet.mts` with a new SLUG).
3. **Design pass** (agreed direction): the promo page as a matchday "drop". Seller's product photo (add an image URL to the chat and metadata); split banner in team colours; a tifo mosaic where each buyer is a tile; win reveal with refunds; matchday board on home. Plus OG share cards before and after the result. Screenshots to the user before going further.
4. Mainnet switch, which needs from the user: about 5 USDC on Arc mainnet for deployer `0xd802BF4429925f3a7bE5987B66468F91a0Ae8dE0`, plus a **Mainnet** Circle client key with the passkey domain set. Then deploy the factory, set Vercel env to mainnet, fund the agent, and check Gas Station sponsorship on mainnet.
5. Real sellers and promos: Premier League MW6 on Sat 10 Oct (Arsenal v Leeds 11:30 UTC, Man United v Tottenham 16:30 UTC, and others) settles before the deadline (11 Oct 03:59 UTC).
6. Release readiness audit, README, demo video, submission form.
