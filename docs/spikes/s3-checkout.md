# S3: Gasless checkout on Arc

**Question:** Can a fan pay USDC on Arc with one signature and no gas token?

**Ran (Arc testnet, live app at https://tifo.vercel.app, 1 Oct 2026):**
- Arc USDC (`0x3600…0000`) supports EIP-2612 permit: `name()` = "USDC", `version()` = "2", `DOMAIN_SEPARATOR()` and `nonces()` respond on mainnet and testnet.
- Three test fans signed a permit in their wallet (no transaction, no gas). The live `/api/relay` submitted `buyWithPermit`; the agent wallet paid the gas.

**Output:**
- Promo `0x1d5b6d812f6868e36015d74ad7761914bfe2a837` (Seattle Sounders v Sporting KC, MLS, 2 Oct 01:30 UTC), created by the seller wallet `0xEAef…b3Eb` in tx `0x8b81ab6a…de67`
- Fan buys: `0x149713b5…9067`, `0x345a2b6c…3bbc`, `0x0a5fbc41…86b8`, `0xbfb433a9…e850`
- After the fourth sale, the agent rebalanced on its own and wrote the reason on chain: `0x9cae42b5…79b9`

**Verdict: PASS.** One signature, no gas for the fan. Circle passkey wallets (Modular Wallets) will be the main wallet once the Circle Console client key is set; they produce the same permit signature, so the relayer path is unchanged.
