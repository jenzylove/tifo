# S6: Circle passkey wallets with sponsored gas on Arc

**Question:** Can a fan use a Circle Modular Wallet (passkey-owned Circle smart account) on Arc and pay no gas?

**Ran:** `scripts/spike-circle-gas.mts`. It creates a brand-new Circle smart account (`toCircleSmartAccount`) with an empty balance on Arc testnet through `https://modular-sdk.circle.com/v1/rpc/w3s/buidl/arcTestnet`, then sends a user operation with `paymaster: true`. A local key stands in for the passkey owner, since passkeys need a browser; the gas question doesn't.

**Output (1 Oct 2026):**
- Smart account `0xa380f21ad4e249ed656ca4ca2b511c1ff0f0aa8c`, holding 0 USDC
- User operation `0xf540393d…de0b` landed in tx `0x4c0832a314e8532c99c7828c46fcf6f1e80463b3e43e45b97e7354c68512576d`, status success

**Verdict: PASS.** Circle's paymaster sponsored gas on Arc testnet for an empty account.

The fan checkout is now: create a passkey (Face ID or fingerprint) → Circle smart account → one sponsored user operation that approves USDC and calls `buy` → the agent rebalances via `/api/after-sale`. MetaMask and Rabby users keep the permit-and-relay path as a fallback.

Open: mainnet sponsorship may need a Gas Station policy in the Circle Console. To be checked at the mainnet switch.
