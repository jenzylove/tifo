# Security

## Reporting a problem

Please use **Report a vulnerability** on this repository's Security tab, which opens a private advisory. Do not open a public issue for anything that could move money. You should hear back within two days.

## Who can do what

Every rule below is enforced by the contracts in [`contracts/src`](contracts/src), not by the app.

| Role | Can | Cannot |
|---|---|---|
| Seller (owner of a `TifoAccount`) | Set the weekly rule and the payout wallet, open drops, approve or decline the agent's proposals, withdraw from their account | Change a drop's offer after a buyer paid, or touch money held for refunds |
| Buyer | Pay for a drop, confirm or dispute a delivery | Pay twice with the same order reference |
| Agent key (server only) | Open drops inside a seller's rule, propose above it, write journal notes, propose a result, finalize after the 15 minute window, push refunds and remainders, release delivery holds after their windows, send a seller's balance to their payout wallet, release naira float money for a confirmed payment | Raise a seller's limit, choose where any money goes, pay a refund to anyone but the ordering wallet, or release float money twice for one payment |
| Operator key | Correct a proposed result inside the 15 minute window, settle a disputed delivery | Move money anywhere else |
| Deployer | Deploy a new factory | Anything in a deployed factory: factories have no owner |
| Float owner | Withdraw from the naira float, change its ceilings or its releaser | Release float money as if a payment had arrived |

## What the contracts guarantee

- Each drop keeps the worst case refund bill from every sale and forwards only the rest. This is checked by an invariant test over random orders and results.
- A refund goes only to the wallet that placed the order, and each order reference is charged once.
- A seller's money leaves their account only to the payout wallet the seller set.
- Payment for a shipped product stays in the drop until the buyer confirms it, the window after "sent" passes, or the operator settles a dispute. An order never marked sent goes back to the buyer.
- The naira float pays each confirmed payment once, within a ceiling per payment and per day, so a stolen releaser key can only drain a small, known amount.

## Results

The agent proposes a result only when two of ESPN, TheSportsDB and Polymarket agree. The proposal waits 15 minutes before it is final, and the operator can correct it inside that window. If the sources disagree, the agent proposes nothing and the drop waits.

## Keys and data

- The agent, operator and API keys live only in the host's server settings. They are never in this repository or sent to the browser.
- Passkeys stay on the person's device; Circle's Modular Wallets never hold them.
- Naira payments are released only after the server asks Bachs directly whether that checkout is paid. A webhook alone never releases money, and webhook signatures are checked against the raw body.
- A sandbox payment key only works on the practice site and a live key only on the real site, so test money and real money never meet.
