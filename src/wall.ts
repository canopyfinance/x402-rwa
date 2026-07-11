/**
 * VALIDATION WALL — PURE, heavily tested. Ported from the Canopy on-chain trading
 * wall and NOT weakened. Every funding swap is run through this before the wallet
 * is ever asked to sign. No network, no viem, no wagmi.
 *
 * It NEVER trusts the quoter's slippage/minOut — it recomputes an INDEPENDENT floor
 * from an independently-sourced expected output and rejects anything below it.
 */

export type FeedState = "LIVE" | "PAUSED" | "CLOSED" | "STALE_ERROR";

const MAX_UINT256 = (1n << 256n) - 1n;

export interface QuoteTx {
  to: string;
  value: string; // decimal string of wei
  data: string;
}

export interface ApprovalStep {
  to: string; // token contract or the verified Permit2
  spender: string; // must be the verified router
  amount: string; // base units
}

export interface RawQuote {
  tx: QuoteTx;
  tokenIn: string;
  tokenOut: string;
  amountIn: string; // base units
  expectedAmountOut: string; // base units (quoter-reported)
  minAmountOut: string; // base units (quoter-reported — NOT trusted)
  priceImpactPct: number;
  deadline: number; // unix seconds
  approval?: ApprovalStep;
}

export interface WallContext {
  verifiedRouter: string;
  verifiedPermit2?: string;
  intendedTokenIn: string;
  intendedTokenOut: string;
  plannedAmountIn: string; // base units the helper decided to sell
  isErc20In: boolean; // when true, tx.value must be 0
  /** Expected out independently derived from the injected PriceSource. */
  feedImpliedAmountOut: string; // base units
  slippagePct: number; // policy
  maxImpactPct: number; // config
  /** PriceSource session state — drives the deviation threshold + gating. */
  feedState: FeedState;
  maxDeviationLivePct: number;
  maxDeviationOffhoursPct: number;
  /** When false, a CLOSED feed blocks execution. */
  executeOffhours: boolean;
  nowSeconds: number;
  maxDeadlineWindowSeconds: number;
}

export interface WallResult {
  ok: boolean;
  reasons: string[];
  /** Independently recomputed minimum-out floor (base units), when computable. */
  minOutFloor?: string;
}

function eqAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function toBigInt(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** basis-point-safe |a-b|/b * 100. */
function deviationPct(actual: bigint, reference: bigint): number {
  if (reference <= 0n) return Number.POSITIVE_INFINITY;
  const diff = actual > reference ? actual - reference : reference - actual;
  return Number((diff * 10000n) / reference) / 100;
}

export function validateQuote(quote: RawQuote, ctx: WallContext): WallResult {
  const reasons: string[] = [];

  // 1. tx.to must be the verified router.
  if (!eqAddr(quote.tx.to, ctx.verifiedRouter)) {
    reasons.push(`tx.to (${quote.tx.to}) is not the verified router.`);
  }

  // 2. token in/out must match the intended verified addresses.
  if (!eqAddr(quote.tokenIn, ctx.intendedTokenIn)) {
    reasons.push("tokenIn does not match the intended funding token.");
  }
  if (!eqAddr(quote.tokenOut, ctx.intendedTokenOut)) {
    reasons.push("tokenOut does not match the settlement token.");
  }

  // 3. amountIn must equal the amount the helper deterministically planned to sell.
  const amountIn = toBigInt(quote.amountIn);
  const planned = toBigInt(ctx.plannedAmountIn);
  if (amountIn === null || planned === null || amountIn !== planned) {
    reasons.push("amountIn does not equal the planned amount.");
  }

  // 4. value must be 0 for an ERC-20-in swap (no stray native value).
  if (ctx.isErc20In) {
    const value = toBigInt(quote.tx.value);
    if (value === null || value !== 0n) {
      reasons.push("tx.value is non-zero for an ERC-20-in swap.");
    }
  }

  // 5. minOut must be >= an INDEPENDENTLY recomputed floor (never trust the quoter).
  const expected = toBigInt(quote.expectedAmountOut);
  const minOut = toBigInt(quote.minAmountOut);
  let minOutFloor: string | undefined;
  if (expected === null || minOut === null) {
    reasons.push("expectedAmountOut/minAmountOut is not a valid integer.");
  } else {
    const slippageBps = BigInt(Math.round(Math.max(0, ctx.slippagePct) * 100));
    const floor = (expected * (10000n - slippageBps)) / 10000n;
    minOutFloor = floor.toString();
    if (minOut < floor) {
      reasons.push(`minAmountOut (${minOut}) is below the recomputed floor (${floor}).`);
    }
  }

  // 6. price impact must be within policy AND configured max.
  if (!(quote.priceImpactPct <= ctx.slippagePct)) {
    reasons.push(
      `priceImpact ${quote.priceImpactPct}% exceeds the policy slippage ${ctx.slippagePct}%.`,
    );
  }
  if (!(quote.priceImpactPct <= ctx.maxImpactPct)) {
    reasons.push(`priceImpact ${quote.priceImpactPct}% exceeds the max ${ctx.maxImpactPct}%.`);
  }

  // 7. SESSION-AWARE price state + quote-vs-PriceSource deviation.
  if (ctx.feedState === "PAUSED") {
    reasons.push("corporate action — price temporarily unavailable");
  } else if (ctx.feedState === "STALE_ERROR") {
    reasons.push("Price source is stale/errored; execution requires a LIVE price.");
  } else if (ctx.feedState === "CLOSED" && !ctx.executeOffhours) {
    reasons.push("Market is closed; off-hours execution is disabled.");
  } else {
    const maxDeviation =
      ctx.feedState === "LIVE" ? ctx.maxDeviationLivePct : ctx.maxDeviationOffhoursPct;
    const feedOut = toBigInt(ctx.feedImpliedAmountOut);
    if (expected !== null && feedOut !== null) {
      const dev = deviationPct(expected, feedOut);
      if (dev > maxDeviation) {
        reasons.push(
          `Quote deviates ${dev.toFixed(2)}% from the independent price source (max ${maxDeviation}% while ${ctx.feedState}).`,
        );
      }
    } else {
      reasons.push("Missing price-source amount for the deviation check.");
    }
  }

  // 8. deadline present and within a sane window.
  if (!Number.isFinite(quote.deadline) || quote.deadline <= ctx.nowSeconds) {
    reasons.push("Quote deadline is missing or already passed.");
  } else if (quote.deadline > ctx.nowSeconds + ctx.maxDeadlineWindowSeconds) {
    reasons.push("Quote deadline is unreasonably far in the future.");
  }

  return { ok: reasons.length === 0, reasons, minOutFloor };
}

/**
 * Validate an approval/permit step: target must be the token itself or the verified
 * Permit2; spender must be the verified router; amount must be bounded (>= planned
 * amount and not an unbounded max-uint approval).
 */
export function validateApproval(
  approval: ApprovalStep,
  ctx: {
    verifiedRouter: string;
    verifiedPermit2?: string;
    intendedTokenIn: string;
    plannedAmountIn: string;
  },
): WallResult {
  const reasons: string[] = [];

  const targetOk =
    eqAddr(approval.to, ctx.intendedTokenIn) ||
    (ctx.verifiedPermit2 !== undefined && eqAddr(approval.to, ctx.verifiedPermit2));
  if (!targetOk) {
    reasons.push("Approval target is neither the token nor the verified Permit2.");
  }
  if (!eqAddr(approval.spender, ctx.verifiedRouter)) {
    reasons.push("Approval spender is not the verified router.");
  }

  const amount = toBigInt(approval.amount);
  const planned = toBigInt(ctx.plannedAmountIn);
  if (amount === null || planned === null) {
    reasons.push("Approval amount is invalid.");
  } else if (amount < planned) {
    reasons.push("Approval amount is below the planned amount.");
  } else if (amount >= MAX_UINT256) {
    reasons.push("Refusing an unbounded (max-uint) approval.");
  }

  return { ok: reasons.length === 0, reasons };
}
