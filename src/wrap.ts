import type { ChainAdapter } from "./chain.js";
import {
  resolveConfig,
  resolveFundingTokens,
  resolveSettleToken,
  type RwaFundingConfig,
  type RwaPaymentConfig,
  type TokenInfo,
} from "./config.js";
import { RwaConfigError, RwaError, RwaFundingLimitError } from "./errors.js";
import {
  buildFundingPlan,
  computeShortfall,
  computeTargetOut,
  sizeAmountIn,
  type BuildPlanParams,
  type FundingPlan,
} from "./planner.js";
import type { PriceSource } from "./price.js";
import type { Quoter } from "./quoter.js";
import {
  createX402Settler,
  parse402,
  selectRequirementForAsset,
  type FetchLike,
  type PaymentSettler,
} from "./settle.js";
import type { WalletClientLike } from "./types.js";

export interface WrapRwaPaymentOptions {
  /** Settlement token symbol; its address is resolved from `config.settleTokens`. */
  settleToken: string;
  /** Which RWA holdings may be sold to fund payments (priority order). */
  fundFrom: RwaFundingConfig;
  chainId: number;
  /** Absolute per-payment USD ceiling. Above this -> throw, never swap. */
  maxAutoSwapUsd: number;
  slippagePct: number;
  quoter: Quoter;
  priceSource: PriceSource;
  /** Operator-provided, validated address book. No addresses are hardcoded. */
  config: RwaPaymentConfig;
  /** Chain reads + (user-signed) swap execution. See `.../viem` for a reference. */
  chain: ChainAdapter;
  /** Optional human/agent approval hook, called with the plan before signing. */
  confirm?: (plan: FundingPlan) => Promise<boolean>;

  // --- advanced / optional knobs (sensible defaults) -----------------------
  /** Cumulative USD ceiling across the lifetime of this wrapped fetch. */
  maxSessionSwapUsd?: number;
  /** Max acceptable price impact (wall also caps impact at slippagePct). Default 3. */
  maxImpactPct?: number;
  /** Max quote-vs-priceSource deviation while LIVE. Default 2. */
  maxDeviationLivePct?: number;
  /** Max quote-vs-priceSource deviation off-hours. Default 5. */
  maxDeviationOffhoursPct?: number;
  /** Allow execution while the price source reports CLOSED. Default false. */
  executeOffhours?: boolean;
  /** Extra headroom (bps) bought on top of slippage when sizing the swap. Default 50. */
  fundingBufferBps?: number;
  /** Swap deadline window (seconds from now). Default 600. */
  swapDeadlineSeconds?: number;
  /** Max acceptable swap deadline window for the wall (seconds). Default 3600. */
  maxDeadlineWindowSeconds?: number;
  /** Override the payment settler (defaults to x402 createPaymentHeader). */
  settler?: PaymentSettler;
  /** Override the underlying fetch (defaults to globalThis.fetch). */
  fetch?: FetchLike;
  /** Clock injection (ms epoch). Defaults to Date.now. */
  now?: () => number;
}

function assertPositiveNumber(label: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RwaConfigError(`${label} must be a positive finite number.`);
  }
  return value;
}

/**
 * Wrap a fetch so that, on an HTTP 402, the payer pays out of a settlement
 * stablecoin — swapping just enough tokenized RWA to cover any shortfall behind the
 * validation wall. Buyer-side only, non-custodial.
 */
export function wrapFetchWithRwaPayment(
  walletClient: WalletClientLike,
  options: WrapRwaPaymentOptions,
): FetchLike {
  if (!walletClient) {
    throw new RwaConfigError("walletClient is required.");
  }
  if (!options || typeof options !== "object") {
    throw new RwaConfigError("options are required.");
  }
  if (!options.quoter) throw new RwaConfigError("options.quoter is required.");
  if (!options.priceSource) throw new RwaConfigError("options.priceSource is required.");
  if (!options.chain) throw new RwaConfigError("options.chain is required.");

  const config = resolveConfig(options.config, options.chainId);
  const settleToken = resolveSettleToken(config, options.settleToken);
  const fundingTokens = resolveFundingTokens(config, options.fundFrom as RwaFundingConfig);

  const maxAutoSwapUsd = assertPositiveNumber("options.maxAutoSwapUsd", options.maxAutoSwapUsd);
  const slippagePct = options.slippagePct;
  if (typeof slippagePct !== "number" || slippagePct < 0 || slippagePct >= 100) {
    throw new RwaConfigError("options.slippagePct must be in [0, 100).");
  }
  if (options.maxSessionSwapUsd !== undefined) {
    assertPositiveNumber("options.maxSessionSwapUsd", options.maxSessionSwapUsd);
  }

  const maxImpactPct = options.maxImpactPct ?? 3;
  const maxDeviationLivePct = options.maxDeviationLivePct ?? 2;
  const maxDeviationOffhoursPct = options.maxDeviationOffhoursPct ?? 5;
  const executeOffhours = options.executeOffhours ?? false;
  const fundingBufferBps = options.fundingBufferBps ?? 50;
  const swapDeadlineSeconds = options.swapDeadlineSeconds ?? 600;
  const maxDeadlineWindowSeconds = options.maxDeadlineWindowSeconds ?? 3600;
  const now = options.now ?? (() => Date.now());

  const chain = options.chain;
  const quoter = options.quoter;
  const priceSource = options.priceSource;
  const baseFetch = options.fetch ?? (globalThis.fetch?.bind(globalThis) as FetchLike);
  if (typeof baseFetch !== "function") {
    throw new RwaConfigError("No fetch available; pass options.fetch.");
  }
  const settler = options.settler ?? createX402Settler(baseFetch);

  let sessionUsd = 0;

  async function planFunding(
    owner: string,
    required: bigint,
    balance: bigint,
    shortfall: bigint,
    nowSeconds: number,
  ): Promise<FundingPlan> {
    const targetOut = computeTargetOut(shortfall, slippagePct, fundingBufferBps);
    const whole = (t: TokenInfo) => 10n ** BigInt(t.decimals);
    const deadlineSeconds = nowSeconds + swapDeadlineSeconds;

    let lastError: unknown;
    for (const fundingToken of fundingTokens) {
      // 1. Independent oracle rate for ONE whole RWA token (for sizing).
      let probe;
      try {
        probe = await priceSource.impliedAmountOut({
          tokenIn: fundingToken,
          tokenOut: settleToken,
          amountIn: whole(fundingToken),
        });
      } catch (err) {
        lastError = err;
        continue;
      }
      if (probe.amountOut <= 0n) continue;

      const amountIn = sizeAmountIn(targetOut, fundingToken.decimals, probe.amountOut);

      // 2. Must actually hold enough of this RWA; otherwise try the next one.
      const rwaBalance = await chain.getErc20Balance(fundingToken.address, owner);
      if (rwaBalance < amountIn) {
        lastError = new RwaError(
          "NO_FUNDING_ROUTE",
          `insufficient ${fundingToken.symbol}: need ${amountIn}, have ${rwaBalance}.`,
        );
        continue;
      }

      // 3. Build the (untrusted) quote and the wall's independent price at the
      //    ACTUAL amountIn, then run the wall. A wall rejection here ABORTS.
      const quote = await quoter.quote({
        tokenIn: fundingToken,
        tokenOut: settleToken,
        amountIn,
        recipient: owner,
        slippagePct,
        deadlineSeconds,
      });
      const price = await priceSource.impliedAmountOut({
        tokenIn: fundingToken,
        tokenOut: settleToken,
        amountIn,
      });

      const planParams: BuildPlanParams = {
        settleToken,
        fundingToken,
        required,
        balance,
        shortfall,
        amountIn,
        quote,
        price,
        slippagePct,
        maxImpactPct,
        maxDeviationLivePct,
        maxDeviationOffhoursPct,
        executeOffhours,
        nowSeconds,
        maxDeadlineWindowSeconds,
        verifiedRouter: config.router,
      };
      if (config.permit2 !== undefined) {
        planParams.verifiedPermit2 = config.permit2;
      }
      return buildFundingPlan(planParams);
    }

    if (lastError instanceof RwaError) throw lastError;
    throw new RwaError(
      "NO_FUNDING_ROUTE",
      "No configured RWA holding can fund this payment.",
    );
  }

  return async function rwaFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const response = await baseFetch(input, init);
    if (response.status !== 402) return response;

    const { x402Version, accepts } = await parse402(response);
    const requirement = selectRequirementForAsset(accepts, settleToken.address);
    if (!requirement) {
      throw new RwaError(
        "UNSUPPORTED_402",
        `Resource does not accept the settlement token ${settleToken.symbol} (${settleToken.address}).`,
      );
    }

    const required = BigInt(requirement.maxAmountRequired);
    const owner = await chain.ownerAddress();
    const balance = await chain.getErc20Balance(settleToken.address, owner);

    // Sufficient settlement balance -> pay directly, NO swap.
    if (balance >= required) {
      return settler.settle({ input, init, requirement, x402Version, walletClient });
    }

    const shortfall = computeShortfall(required, balance);
    const nowSeconds = Math.floor(now() / 1000);
    const plan = await planFunding(owner, required, balance, shortfall, nowSeconds);

    // HARD LIMITS — checked BEFORE any swap or signature.
    if (plan.estimatedUsd > maxAutoSwapUsd) {
      throw new RwaFundingLimitError("payment", plan.estimatedUsd, maxAutoSwapUsd);
    }
    if (
      options.maxSessionSwapUsd !== undefined &&
      sessionUsd + plan.estimatedUsd > options.maxSessionSwapUsd
    ) {
      throw new RwaFundingLimitError("session", sessionUsd + plan.estimatedUsd, options.maxSessionSwapUsd);
    }

    // Optional approval hook — aborts BEFORE signing.
    if (options.confirm) {
      const approved = await options.confirm(plan);
      if (!approved) {
        throw new RwaError("CONFIRM_DECLINED", "Funding swap declined by confirm() hook.");
      }
    }

    // Execute the user/agent-signed approval (if any) then the swap.
    if (plan.quote.approval) {
      const allowance = await chain.getErc20Allowance(
        plan.fundingToken.address,
        owner,
        plan.quote.approval.spender,
      );
      if (allowance < plan.amountIn) {
        const approvalHash = await chain.sendApproval(plan.quote.approval);
        await chain.waitForSuccess(approvalHash);
      }
    }

    let swapHash: string;
    try {
      swapHash = await chain.sendSwap(plan.quote.tx);
      await chain.waitForSuccess(swapHash);
    } catch (err) {
      throw new RwaError("SWAP_FAILED", `Funding swap failed: ${(err as Error).message}`);
    }

    // Confirm the swap actually covered the shortfall before paying.
    const newBalance = await chain.getErc20Balance(settleToken.address, owner);
    if (newBalance < required) {
      throw new RwaError(
        "INSUFFICIENT_AFTER_SWAP",
        `Balance after swap (${newBalance}) still below required (${required}).`,
      );
    }

    sessionUsd += plan.estimatedUsd;
    return settler.settle({ input, init, requirement, x402Version, walletClient });
  };
}
