import type { TokenInfo } from "./config.js";
import type { RawQuote } from "./wall.js";

/**
 * A funding swap request. The helper decides `amountIn` (how much RWA to sell) and
 * asks the injected Quoter to build the router calldata for an EXACT-INPUT swap of
 * that amount into the settlement token. The returned RawQuote is NEVER trusted —
 * it always passes the validation wall before signing.
 */
export interface QuoteRequest {
  tokenIn: TokenInfo; // RWA being sold
  tokenOut: TokenInfo; // settlement token
  amountIn: bigint; // base units the helper planned to sell
  recipient: string; // payer address (swap output goes here)
  slippagePct: number;
  deadlineSeconds: number; // absolute unix deadline for the swap
}

export interface Quoter {
  quote(request: QuoteRequest): Promise<RawQuote>;
}

/**
 * Deterministic, network-free Quoter for tests and examples. Given a fixed
 * price (settle base units produced per whole RWA token), it produces a
 * well-formed RawQuote. Pass `overrides` to inject malformed quotes for wall tests.
 */
export interface StubQuoterOptions {
  router: string;
  /** Settlement base units produced per ONE whole RWA token (10**rwaDecimals in). */
  pricePerToken: bigint;
  priceImpactPct?: number;
  /** quoter-reported slippage (intentionally tighter/looser than policy). */
  quoterSlippagePct?: number;
  permit2?: string;
  /** Force these fields onto every returned quote (for negative wall tests). */
  overrides?: Partial<RawQuote>;
  includeApproval?: boolean;
}

export class StubQuoter implements Quoter {
  constructor(private readonly opts: StubQuoterOptions) {}

  async quote(request: QuoteRequest): Promise<RawQuote> {
    const { tokenIn, tokenOut, amountIn } = request;
    const whole = 10n ** BigInt(tokenIn.decimals);
    const expectedOut = (amountIn * this.opts.pricePerToken) / whole;

    // The quoter's OWN (untrusted) min uses its own slippage, deliberately tighter
    // than policy so tests can prove the wall ignores it.
    const quoterBps = BigInt(Math.round((this.opts.quoterSlippagePct ?? 0.5) * 100));
    const quoterMinOut = (expectedOut * (10000n - quoterBps)) / 10000n;

    const base: RawQuote = {
      tx: { to: this.opts.router, value: "0", data: "0xstub" },
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountIn: amountIn.toString(),
      expectedAmountOut: expectedOut.toString(),
      minAmountOut: quoterMinOut.toString(),
      priceImpactPct: this.opts.priceImpactPct ?? 0.1,
      deadline: request.deadlineSeconds,
    };
    if (this.opts.includeApproval) {
      base.approval = {
        to: this.opts.permit2 ?? tokenIn.address,
        spender: this.opts.router,
        amount: amountIn.toString(),
      };
    }
    return { ...base, ...this.opts.overrides };
  }
}
