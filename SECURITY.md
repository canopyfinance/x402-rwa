# Security Policy

`@canopy-finance/x402-rwa` moves value on behalf of agents and apps. We take its safety
seriously and design it to **fail closed**.

## Design guarantees

- **Non-custodial.** The package never holds funds or private keys. It signs only with the
  `walletClient` you pass and broadcasts only through the `ChainAdapter` you provide.
- **No hardcoded addresses.** No mainnet addresses ship in this package. Token/router/settlement
  addresses come from your validated, checksummed `config`; invalid config throws at init.
- **Validation wall on every swap.** Each funding swap and approval is checked before signing
  (router, tokens, amount, value, independently-recomputed `minOut` floor, price impact,
  quote-vs-independent-oracle deviation, price-feed state, deadline, bounded approval). A failing
  swap aborts the payment; it never force-pays with a bad swap.
- **Hard USD ceilings.** `maxAutoSwapUsd` (per payment) and the optional `maxSessionSwapUsd`
  (cumulative) throw before any swap or signature when exceeded.
- **Untrusted quoter.** The DEX quote is treated as adversarial input; the wall recomputes its own
  floor and ignores the quoter's slippage/`minOut`.

## Supported versions

| Version | Supported |
|---------|-----------|
| `0.x`   | ✅        |

## Reporting a vulnerability

Please **do not** open a public issue for security reports.

- Use GitHub's [private vulnerability reporting](https://github.com/canopyfinance/x402-rwa/security/advisories/new), or
- email **security@canopy.finance** with steps to reproduce and impact.

We aim to acknowledge within 72 hours and to coordinate a fix and disclosure timeline with you.

## Scope

In scope: the wall, swap planner, config validation, fund-or-pay flow, and settlement delegation.
Out of scope: vulnerabilities in your injected `Quoter` / `PriceSource` / `ChainAdapter`, the
underlying DEX/router contracts, RPC providers, or the `x402` protocol itself (report those
upstream).
