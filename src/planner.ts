import { formatUnits } from "viem";

import type { TokenInfo } from "./config.js";
import { RwaWallError } from "./errors.js";
import type { PriceReading } from "./price.js";
import {
  validateApproval,
  validateQuote,
  type FeedState,
  type RawQuote,
  type WallContext,
} from "./wall.js";

/** Pure math + wall orchestration. NO network, NO viem clients — fully unit-tested. */

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("ceilDiv: divisor must be positive");
  return (a + b - 1n) / b;
}

/** How much settlement token the payer is short (0 when already covered). */
export function computeShortfall(required: bigint, balance: bigint): bigint {
  return required > balance ? required - balance : 0n;
}

/**
 * The settlement output the funding swap should target. We buy a little more than
 * the raw shortfall so that, after slippage, the independently recomputed floor
 * still covers what we owe. `bufferBps` is added on top of the slippage headroom.
 */
export function computeTargetOut(
  shortfall: bigint,
  slippagePct: number,
  bufferBps: number,
): bigint {
  const slippageBps = BigInt(Math.round(Math.max(0, slippagePct) * 100));
  const extra = BigInt(Math.max(0, Math.round(bufferBps)));
  const headroom = slippageBps + extra; // basis points above the raw shortfall
  return ceilDiv(shortfall * (10000n + headroom), 10000n);
}

/**
 * RWA base units to sell to obtain `targetOut` at the INDEPENDENT oracle price.
 * `oracleOutPerWhole` = settlement base units the price source implies for ONE
 * whole RWA token.
 */
export function sizeAmountIn(
  targetOut: bigint,
  rwaDecimals: number,
  oracleOutPerWhole: bigint,
): bigint {
  if (oracleOutPerWhole <= 0n) {
    throw new Error("sizeAmountIn: oracle price must be positive");
  }
  const whole = 10n ** BigInt(rwaDecimals);
  return ceilDiv(targetOut * whole, oracleOutPerWhole);
}

export interface FundingPlan {
  settleToken: TokenInfo;
  fundingToken: TokenInfo;
  required: bigint;
  balance: bigint;
  shortfall: bigint;
  /** RWA base units to be sold. */
  amountIn: bigint;
  quote: RawQuote;
  /** Independently recomputed minimum-out floor (never the quoter's). */
  minOutFloor: bigint;
  expectedAmountOut: bigint;
  /** Swap value in USD (settlement token assumed ~ $1). */
  estimatedUsd: number;
}

export interface BuildPlanParams {
  settleToken: TokenInfo;
  fundingToken: TokenInfo;
  required: bigint;
  balance: bigint;
  shortfall: bigint;
  amountIn: bigint;
  quote: RawQuote;
  price: PriceReading;
  slippagePct: number;
  maxImpactPct: number;
  maxDeviationLivePct: number;
  maxDeviationOffhoursPct: number;
  executeOffhours: boolean;
  nowSeconds: number;
  maxDeadlineWindowSeconds: number;
  verifiedRouter: string;
  verifiedPermit2?: string;
}

/**
 * Run the funding quote through the validation wall (approval + quote) and, on
 * success, assert the independently recomputed floor actually covers the shortfall.
 * Throws `RwaWallError` on any rejection — it NEVER returns a plan that would let a
 * bad swap through.
 */
export function buildFundingPlan(params: BuildPlanParams): FundingPlan {
  const { quote, fundingToken, settleToken } = params;

  const wallCtx: WallContext = {
    verifiedRouter: params.verifiedRouter,
    intendedTokenIn: fundingToken.address,
    intendedTokenOut: settleToken.address,
    plannedAmountIn: params.amountIn.toString(),
    isErc20In: true,
    feedImpliedAmountOut: params.price.amountOut.toString(),
    slippagePct: params.slippagePct,
    maxImpactPct: params.maxImpactPct,
    feedState: params.price.state as FeedState,
    maxDeviationLivePct: params.maxDeviationLivePct,
    maxDeviationOffhoursPct: params.maxDeviationOffhoursPct,
    executeOffhours: params.executeOffhours,
    nowSeconds: params.nowSeconds,
    maxDeadlineWindowSeconds: params.maxDeadlineWindowSeconds,
  };
  if (params.verifiedPermit2 !== undefined) {
    wallCtx.verifiedPermit2 = params.verifiedPermit2;
  }

  if (quote.approval) {
    const approvalCtx: {
      verifiedRouter: string;
      verifiedPermit2?: string;
      intendedTokenIn: string;
      plannedAmountIn: string;
    } = {
      verifiedRouter: params.verifiedRouter,
      intendedTokenIn: fundingToken.address,
      plannedAmountIn: params.amountIn.toString(),
    };
    if (params.verifiedPermit2 !== undefined) {
      approvalCtx.verifiedPermit2 = params.verifiedPermit2;
    }
    const approvalResult = validateApproval(quote.approval, approvalCtx);
    if (!approvalResult.ok) {
      throw new RwaWallError(approvalResult.reasons);
    }
  }

  const result = validateQuote(quote, wallCtx);
  if (!result.ok || result.minOutFloor === undefined) {
    throw new RwaWallError(result.reasons.length ? result.reasons : ["floor not computable"]);
  }

  const minOutFloor = BigInt(result.minOutFloor);
  if (minOutFloor < params.shortfall) {
    // The wall passed, but the guaranteed output would NOT cover what we owe.
    throw new RwaWallError([
      `recomputed floor (${minOutFloor}) does not cover the shortfall (${params.shortfall}).`,
    ]);
  }

  const expectedAmountOut = BigInt(quote.expectedAmountOut);
  const estimatedUsd = Number(formatUnits(expectedAmountOut, settleToken.decimals));

  return {
    settleToken,
    fundingToken,
    required: params.required,
    balance: params.balance,
    shortfall: params.shortfall,
    amountIn: params.amountIn,
    quote,
    minOutFloor,
    expectedAmountOut,
    estimatedUsd,
  };
}
