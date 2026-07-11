# @canopy-finance/x402-rwa

**Pay [x402](https://x402.org) invoices out of tokenized RWA instead of a pre-funded stablecoin balance.**

When a paid endpoint returns `HTTP 402`, this helper checks your settlement‑stablecoin
(e.g. USDG) balance. If you're short, it swaps *just enough* tokenized RWA into the
stablecoin — through a **validation wall** — then completes the x402 payment. If you
already have enough stablecoin, it pays directly and **never swaps**.

Buyer‑side only. **Non‑custodial** — it never holds your funds or keys; it only asks
the wallet client *you* pass to sign.

```bash
npm install @canopy-finance/x402-rwa viem
```

---

## Quickstart

One function wraps `fetch`:

```ts
import { wrapFetchWithRwaPayment } from "@canopy-finance/x402-rwa";
import { createViemChainAdapter } from "@canopy-finance/x402-rwa/viem";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({ account, chain: myChain, transport: http() });
const publicClient = createPublicClient({ chain: myChain, transport: http() });

const fetchWithRwa = wrapFetchWithRwaPayment(walletClient, {
  settleToken: "USDG",                 // settlement asset symbol (address from config)
  fundFrom: { symbols: ["NVDA", "TSLA"] }, // RWA holdings sellable, in priority order
  chainId: 4663,
  maxAutoSwapUsd: 50,                   // hard per-payment ceiling; above -> throw, never swap
  slippagePct: 1,

  quoter: myQuoter,                     // YOU provide (DEX/aggregator) — see interfaces
  priceSource: myPriceSource,           // YOU provide (independent oracle) — feeds the wall
  chain: createViemChainAdapter({ publicClient, walletClient }),

  // ⬇️ operator-provided, validated, checksummed address book (NO addresses ship in this pkg)
  config: {
    chainId: 4663,
    router: "0x…",                      // verified DEX router funding swaps go through
    permit2: "0x…",                     // optional
    settleTokens: { USDG: { address: "0x…", decimals: 6 } },
    rwaTokens:    { NVDA: { address: "0x…", decimals: 18 }, TSLA: { address: "0x…", decimals: 18 } },
  },

  confirm: async (plan) => {            // optional human/agent approval hook
    return plan.estimatedUsd <= 25;
  },
});

// Use it exactly like fetch. 402s are handled transparently.
const res = await fetchWithRwa("https://api.example.com/premium");
const data = await res.json();
```

Run the fully‑offline demo (stubs only, no RPC/DEX/funds):

```bash
node example/basic.mjs
```

---

## The flow on a 402

1. Parse the x402 `402` response (reuses x402 client primitives for the actual
   payment step — settlement is **not** reimplemented here).
2. Read the payer's settlement‑token balance. **If it covers the invoice, pay
   directly — no swap.**
3. If short by Δ: size an RWA→stablecoin swap for Δ (+ a small buffer), build it with
   your injected `Quoter`, run it through the **validation wall**, execute it
   (user/agent‑signed), wait for it to settle, then complete the x402 payment.

## The validation wall (ported, not weakened)

Every funding swap is checked **before the wallet is asked to sign**:

| Check | Rule |
|---|---|
| Router | `tx.to` **==** the verified router from your config |
| Tokens | `tokenIn` / `tokenOut` match the intended verified addresses |
| Amount | `amountIn` **==** the amount the helper planned to sell |
| Value | `tx.value == 0` for an ERC‑20‑in swap (no stray native value) |
| **minOut** | **>= an INDEPENDENTLY recomputed floor** — the quoter's slippage/minOut is *never* trusted |
| Impact | `priceImpact <= slippagePct` (and a configured max) |
| Deviation | quote's expected out vs. **independent** `priceSource` <= threshold |
| Price state | LIVE/CLOSED/PAUSED/STALE gating (a paused/stale feed blocks execution) |
| Deadline | present and within a sane window |
| Approval | target is the token or verified Permit2; spender is the verified router; amount bounded (no max‑uint) |

A failing swap **aborts the payment** (`RwaWallError`). The helper never force‑pays
with a bad swap.

## Hard limits (fail closed)

- `maxAutoSwapUsd` is an **absolute per‑payment ceiling**. If funding a payment would
  exceed it, the helper throws `RwaFundingLimitError` — **no swap, no payment**.
- `maxSessionSwapUsd` (optional) caps cumulative funding across the lifetime of the
  wrapped fetch.
- Any ambiguity (unknown token, unavailable price, floor that can't cover the
  shortfall, insufficient RWA) → throw, never guess.

## You provide verified config

This package ships **no hardcoded mainnet addresses**. Token / router / settlement
addresses come from the `config` object you pass. It is validated and **checksummed**
at init; anything missing or malformed throws `RwaConfigError` immediately.

## Everything is injected

`Quoter`, `PriceSource`, `walletClient`, and the `ChainAdapter` are all injected, so
the core is testable with stubs and unbound to any single RPC/DEX. `StubQuoter` and
`StubPrice` ship for tests/examples; a viem `ChainAdapter` is available from
`@canopy-finance/x402-rwa/viem` (viem is a **peer** dependency, not a hard one).

### Interfaces (summary)

```ts
interface Quoter {
  quote(req: {
    tokenIn: TokenInfo; tokenOut: TokenInfo; amountIn: bigint;
    recipient: string; slippagePct: number; deadlineSeconds: number;
  }): Promise<RawQuote>; // { tx, tokenIn, tokenOut, amountIn, expectedAmountOut, minAmountOut, priceImpactPct, deadline, approval? }
}

interface PriceSource { // MUST be independent of the quoter/DEX
  impliedAmountOut(req: { tokenIn: TokenInfo; tokenOut: TokenInfo; amountIn: bigint })
    : Promise<{ amountOut: bigint; state: "LIVE" | "PAUSED" | "CLOSED" | "STALE_ERROR" }>;
}

interface ChainAdapter { // reads balances/allowances + broadcasts user-signed txs
  ownerAddress(): Promise<string>;
  getErc20Balance(token: string, owner: string): Promise<bigint>;
  getErc20Allowance(token: string, owner: string, spender: string): Promise<bigint>;
  sendApproval(step: ApprovalStep): Promise<string>;
  sendSwap(tx: QuoteTx): Promise<string>;
  waitForSuccess(hash: string): Promise<void>;
}
```

## Errors

| Error | When |
|---|---|
| `RwaConfigError` | invalid/missing config or options (thrown at init) |
| `RwaWallError` | a funding swap failed the validation wall (carries `.reasons`) |
| `RwaFundingLimitError` | swap would exceed `maxAutoSwapUsd` / `maxSessionSwapUsd` (carries `.scope`, `.requestedUsd`, `.limitUsd`) |
| `RwaError` | other failures — `UNSUPPORTED_402`, `NO_FUNDING_ROUTE`, `SWAP_FAILED`, `INSUFFICIENT_AFTER_SWAP`, `CONFIRM_DECLINED`, … (see `.code`) |

## Limitations (v1, honest)

- **Settlement token assumption.** USD sizing assumes the settlement token is a
  USD‑pegged stablecoin (~$1). `maxAutoSwapUsd` and `estimatedUsd` are computed from
  the settlement amount, not an independent USD oracle on the stablecoin itself.
- **Per‑payment scope.** Caps and swaps are evaluated per payment. The session cap is
  in‑memory for the lifetime of the wrapped fetch (not persisted).
- **Exact‑input funding.** Funding uses an exact‑input swap sized from the independent
  oracle plus a buffer, so you may acquire slightly more settlement token than strictly
  owed (the remainder stays in your wallet). The wall's recomputed floor must still
  cover the shortfall or the payment aborts.
- **Buyer‑side only.** No seller/middleware is included.
- **One initial request per call.** Non‑402 responses pass through untouched; a 402
  triggers the fund‑or‑pay path and a single settlement retry.

## License

MIT
