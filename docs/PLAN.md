# Tifo Plan

Rewritten Sat 10 Oct 2026 after the relock. The first plan's phases 0 to 3 are done (see `BUILD_LOG.md`).

Deadlines: Arc Microgrants Wed 14 Oct 11:59 PM ET. Tameion Sat 17 Oct 11:59 PM ET.

## Phases (each ends with a check that proves it is done)

### Phase A: Cut to the deal link
- Remove storefront pages, shop registry, catalog editor and shop branding.
- One seller screen: product, photo, price, profit per sale, budget. Output: link, QR, ready post.
- Deal page: product first, spots meter, checkout, digital delivery.
- **Check:** acceptance tests 8 and 11 on testnet.

### Phase B: The money rules
- Deal contract: draw thank you (reserve covers the largest of three bills), floor offer after spots fill.
- Seller account contract: weekly share, per deal limit, agent funds reserves inside them, proposals above.
- Core math and invariant tests for three outcomes.
- **Check:** acceptance tests 1, 2, 3 and 4.

### Phase C: The agent that decides
- Budget sizing from real sales and profit per sale; offer shape; refusal; live pause and top up; scorecard; next deal changed by the last.
- Every call logged on chain with its reason.
- **Check:** acceptance tests 5, 6 and 10.

### Phase D: Mainnet (before Wed 14 Oct)
- Deploy to Arc mainnet, mainnet Circle key, Paymaster check, cross chain pay in spike.
- First mainnet deal from the user's own shop on a real match, settled with no human touch.
- Submit the Arc Microgrant.
- **Check:** acceptance tests 7 and 9; microgrant form sent.

### Phase E: Real deals (Wed 14 to Sat 17 Oct)
- Outside sellers run deals on that week's matches. `TRACTION.md` kept from chain data.
- Release readiness audit, README, demo video, Tameion form.
- **Check:** acceptance test 12; form submitted before the deadline.

## Needed from the user
- About 5 USDC on Arc mainnet for deployer `0xd802BF4429925f3a7bE5987B66468F91a0Ae8dE0`.
- A mainnet Circle client key with the passkey domain set to `tifo.vercel.app`.
- The keys and env from the old cloud session (Vercel env pull works, see `HANDOFF.md`).
- Two or three sellers to run deals in Phase E.
