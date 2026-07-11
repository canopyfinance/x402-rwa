import type { TokenInfo } from "./config.js";
import type { FeedState } from "./wall.js";

/**
 * Independent price oracle used by the validation wall to (a) size the funding swap
 * and (b) check the quoter's expected output for deviation. It MUST be sourced
 * independently of the Quoter/DEX (e.g. a Chainlink/Pyth feed) — that independence
 * is what makes the deviation check meaningful.
 */
export interface PriceReading {
  /** Independent implied output (base units of tokenOut) for the given input. */
  amountOut: bigint;
  state: FeedState;
}

export interface PriceRequest {
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: bigint;
}

export interface PriceSource {
  impliedAmountOut(request: PriceRequest): Promise<PriceReading>;
}

/**
 * Deterministic, network-free PriceSource for tests and examples. Linear price
 * (no impact), so it doubles as a swap-sizing oracle.
 */
export interface StubPriceOptions {
  /** Settlement base units per ONE whole RWA token (10**rwaDecimals in). */
  pricePerToken: bigint;
  state?: FeedState;
}

export class StubPrice implements PriceSource {
  constructor(private readonly opts: StubPriceOptions) {}

  async impliedAmountOut(request: PriceRequest): Promise<PriceReading> {
    const whole = 10n ** BigInt(request.tokenIn.decimals);
    return {
      amountOut: (request.amountIn * this.opts.pricePerToken) / whole,
      state: this.opts.state ?? "LIVE",
    };
  }
}
