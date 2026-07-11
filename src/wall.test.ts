import { describe, expect, it } from "vitest";

import {
  validateApproval,
  validateQuote,
  type ApprovalStep,
  type RawQuote,
  type WallContext,
} from "./wall.js";

/**
 * The validation wall is PORTED, not weakened. It inspects
 * to/token/amount/value/minOut/impact/deviation/deadline and NEVER trusts the
 * quoter's slippage — it recomputes its own floor from an independent price.
 */

const ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const TOKEN_IN = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec"; // RWA (NVDA)
const TOKEN_OUT = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"; // USDG
const NOW = 1_000_000;
const AMOUNT_IN = "1000000000000000000";
const EXPECTED = "100000000";
const POLICY_FLOOR = ((100000000n * (10000n - 100n)) / 10000n).toString(); // slippage 1%
// The quoter reports a TIGHTER min than policy (0.5%). The wall must ignore it.
const QUOTER_MIN = ((100000000n * (10000n - 50n)) / 10000n).toString();
const CALLDATA = "0x3593564c00";

function quote(over: Partial<RawQuote> = {}): RawQuote {
  return {
    tx: { to: ROUTER, value: "0", data: CALLDATA },
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountIn: AMOUNT_IN,
    expectedAmountOut: EXPECTED,
    minAmountOut: QUOTER_MIN, // quoter's — NOT trusted
    priceImpactPct: 0.5,
    deadline: NOW + 600,
    ...over,
  };
}

function ctx(over: Partial<WallContext> = {}): WallContext {
  return {
    verifiedRouter: ROUTER,
    verifiedPermit2: PERMIT2,
    intendedTokenIn: TOKEN_IN,
    intendedTokenOut: TOKEN_OUT,
    plannedAmountIn: AMOUNT_IN,
    isErc20In: true,
    feedImpliedAmountOut: EXPECTED,
    slippagePct: 1,
    maxImpactPct: 3,
    feedState: "LIVE",
    maxDeviationLivePct: 2,
    maxDeviationOffhoursPct: 5,
    executeOffhours: false,
    nowSeconds: NOW,
    maxDeadlineWindowSeconds: 3600,
    ...over,
  };
}

describe("validation wall: every failure mode rejects (criterion 5)", () => {
  it("passes a well-formed quote", () => {
    expect(validateQuote(quote(), ctx()).ok).toBe(true);
  });
  it("wrong tx.to (not the verified router) -> reject", () => {
    expect(
      validateQuote(quote({ tx: { to: "0xdead", value: "0", data: CALLDATA } }), ctx()).ok,
    ).toBe(false);
  });
  it("tokenIn mismatch -> reject", () => {
    expect(validateQuote(quote({ tokenIn: `0x${"c".repeat(40)}` }), ctx()).ok).toBe(false);
  });
  it("tokenOut mismatch -> reject", () => {
    expect(validateQuote(quote({ tokenOut: `0x${"c".repeat(40)}` }), ctx()).ok).toBe(false);
  });
  it("amountIn != planned -> reject", () => {
    expect(validateQuote(quote({ amountIn: "999" }), ctx()).ok).toBe(false);
  });
  it("nonzero value on ERC-20-in -> reject", () => {
    expect(
      validateQuote(quote({ tx: { to: ROUTER, value: "1", data: CALLDATA } }), ctx()).ok,
    ).toBe(false);
  });
  it("minOut below the recomputed floor -> reject", () => {
    expect(
      validateQuote(quote({ minAmountOut: (BigInt(POLICY_FLOOR) - 1n).toString() }), ctx()).ok,
    ).toBe(false);
  });
  it("price impact over policy slippage -> reject", () => {
    expect(validateQuote(quote({ priceImpactPct: 2 }), ctx()).ok).toBe(false);
  });
  it("quote-vs-priceSource deviation over threshold -> reject", () => {
    const r = validateQuote(quote(), ctx({ feedImpliedAmountOut: "90000000" })); // ~11%
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => /deviat/i.test(x))).toBe(true);
  });
  it("bad/expired deadline -> reject", () => {
    expect(validateQuote(quote({ deadline: NOW - 1 }), ctx()).ok).toBe(false);
  });
  it("deadline unreasonably far in the future -> reject", () => {
    expect(validateQuote(quote({ deadline: NOW + 10 * 3600 }), ctx()).ok).toBe(false);
  });
});

describe("minOut floor is recomputed from policy, not taken from the quoter (criterion 6)", () => {
  it("floor is the POLICY floor and provably != quoter's min", () => {
    const r = validateQuote(quote(), ctx());
    expect(r.ok).toBe(true);
    expect(r.minOutFloor).toBe(POLICY_FLOOR);
    expect(r.minOutFloor).not.toBe(QUOTER_MIN);
  });
  it("recomputes the same floor regardless of the quoter-provided minAmountOut", () => {
    const higher = validateQuote(quote({ minAmountOut: EXPECTED }), ctx());
    expect(higher.minOutFloor).toBe(POLICY_FLOOR);
  });
});

describe("approval / Permit2 validation", () => {
  const approvalCtx = {
    verifiedRouter: ROUTER,
    verifiedPermit2: PERMIT2,
    intendedTokenIn: TOKEN_IN,
    plannedAmountIn: AMOUNT_IN,
  };
  it("accepts approval to Permit2 with spender = verified router", () => {
    const a: ApprovalStep = { to: PERMIT2, spender: ROUTER, amount: AMOUNT_IN };
    expect(validateApproval(a, approvalCtx).ok).toBe(true);
  });
  it("accepts an ERC-20 approval to the token with spender = verified router", () => {
    const a: ApprovalStep = { to: TOKEN_IN, spender: ROUTER, amount: AMOUNT_IN };
    expect(validateApproval(a, approvalCtx).ok).toBe(true);
  });
  it("rejects a spender that is not the verified router", () => {
    const a: ApprovalStep = { to: PERMIT2, spender: `0x${"9".repeat(40)}`, amount: AMOUNT_IN };
    expect(validateApproval(a, approvalCtx).ok).toBe(false);
  });
  it("rejects an unbounded (max-uint) approval", () => {
    const a: ApprovalStep = { to: PERMIT2, spender: ROUTER, amount: ((1n << 256n) - 1n).toString() };
    expect(validateApproval(a, approvalCtx).ok).toBe(false);
  });
});

describe("price-source state gates execution (criterion 5)", () => {
  it("PAUSED (corporate action) blocks even with executeOffhours", () => {
    const r = validateQuote(quote(), ctx({ feedState: "PAUSED", executeOffhours: true }));
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => /corporate action/i.test(x))).toBe(true);
  });
  it("STALE_ERROR blocks", () => {
    expect(validateQuote(quote(), ctx({ feedState: "STALE_ERROR" })).ok).toBe(false);
  });
});
