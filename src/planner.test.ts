import { describe, expect, it } from "vitest";

import type { TokenInfo } from "./config.js";
import { RwaWallError } from "./errors.js";
import {
  buildFundingPlan,
  ceilDiv,
  computeShortfall,
  computeTargetOut,
  sizeAmountIn,
  type BuildPlanParams,
} from "./planner.js";
import type { PriceReading } from "./price.js";
import type { RawQuote } from "./wall.js";

const ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
const RWA: TokenInfo = { symbol: "NVDA", address: `0x${"a".repeat(40)}`, decimals: 18 };
const USDG: TokenInfo = { symbol: "USDG", address: `0x${"b".repeat(40)}`, decimals: 6 };
const NOW = 1_000_000;

describe("pure sizing math", () => {
  it("ceilDiv rounds up", () => {
    expect(ceilDiv(10n, 3n)).toBe(4n);
    expect(ceilDiv(9n, 3n)).toBe(3n);
  });
  it("computeShortfall clamps at zero", () => {
    expect(computeShortfall(100n, 40n)).toBe(60n);
    expect(computeShortfall(40n, 100n)).toBe(0n);
  });
  it("computeTargetOut buys headroom above the shortfall", () => {
    // 1% slippage + 50bps buffer = 150bps over the shortfall.
    expect(computeTargetOut(100_000000n, 1, 50)).toBe(101_500000n);
  });
  it("sizeAmountIn inverts the oracle rate", () => {
    // oracle: 1 whole RWA -> 100 USDG (100e6). Want 101.5 USDG out.
    const amountIn = sizeAmountIn(101_500000n, 18, 100_000000n);
    expect(amountIn).toBe(1_015000000000000000n); // 1.015 RWA
  });
});

function goodQuote(amountIn: bigint, over: Partial<RawQuote> = {}): RawQuote {
  const expectedOut = (amountIn * 100_000000n) / 10n ** 18n; // 100 USDG per RWA
  return {
    tx: { to: ROUTER, value: "0", data: "0xabc" },
    tokenIn: RWA.address,
    tokenOut: USDG.address,
    amountIn: amountIn.toString(),
    expectedAmountOut: expectedOut.toString(),
    minAmountOut: ((expectedOut * (10000n - 50n)) / 10000n).toString(), // quoter's 0.5%
    priceImpactPct: 0.1,
    deadline: NOW + 600,
    ...over,
  };
}

function baseParams(amountIn: bigint, quote: RawQuote): BuildPlanParams {
  const price: PriceReading = { amountOut: (amountIn * 100_000000n) / 10n ** 18n, state: "LIVE" };
  return {
    settleToken: USDG,
    fundingToken: RWA,
    required: 100_000000n,
    balance: 0n,
    shortfall: 100_000000n,
    amountIn,
    quote,
    price,
    slippagePct: 1,
    maxImpactPct: 3,
    maxDeviationLivePct: 2,
    maxDeviationOffhoursPct: 5,
    executeOffhours: false,
    nowSeconds: NOW,
    maxDeadlineWindowSeconds: 3600,
    verifiedRouter: ROUTER,
  };
}

describe("buildFundingPlan (criterion 6: independent floor)", () => {
  it("passes the wall and recomputes a floor that covers the shortfall", () => {
    const amountIn = 1_015000000000000000n;
    const quote = goodQuote(amountIn);
    const plan = buildFundingPlan(baseParams(amountIn, quote));
    expect(plan.minOutFloor >= plan.shortfall).toBe(true);
    // The plan's floor is independently recomputed and NOT the quoter's min.
    expect(plan.minOutFloor.toString()).not.toBe(quote.minAmountOut);
  });

  it("throws RwaWallError when the recomputed floor cannot cover the shortfall", () => {
    // Size only exactly the shortfall: after 1% slippage the floor falls short.
    const amountIn = 1_000000000000000000n;
    const quote = goodQuote(amountIn);
    expect(() => buildFundingPlan(baseParams(amountIn, quote))).toThrow(RwaWallError);
  });

  it("throws RwaWallError on a wall rejection (tampered router)", () => {
    const amountIn = 1_015000000000000000n;
    const quote = goodQuote(amountIn, { tx: { to: "0xbad", value: "0", data: "0x" } });
    expect(() => buildFundingPlan(baseParams(amountIn, quote))).toThrow(RwaWallError);
  });
});
