export { wrapFetchWithRwaPayment, type WrapRwaPaymentOptions } from "./wrap.js";

export {
  resolveConfig,
  resolveSettleToken,
  resolveFundingTokens,
  type RwaPaymentConfig,
  type RwaFundingConfig,
  type ResolvedConfig,
  type TokenInfo,
} from "./config.js";

export type { Quoter, QuoteRequest, StubQuoterOptions } from "./quoter.js";
export { StubQuoter } from "./quoter.js";

export type { PriceSource, PriceReading, PriceRequest, StubPriceOptions } from "./price.js";
export { StubPrice } from "./price.js";

export type { ChainAdapter } from "./chain.js";

export {
  validateQuote,
  validateApproval,
  type RawQuote,
  type QuoteTx,
  type ApprovalStep,
  type WallContext,
  type WallResult,
  type FeedState,
} from "./wall.js";

export {
  buildFundingPlan,
  computeShortfall,
  computeTargetOut,
  sizeAmountIn,
  ceilDiv,
  type FundingPlan,
  type BuildPlanParams,
} from "./planner.js";

export {
  parse402,
  selectRequirementForAsset,
  createX402Settler,
  type PaymentSettler,
  type SettleContext,
  type FetchLike,
  type Parsed402,
} from "./settle.js";

export type { WalletClientLike } from "./types.js";

export {
  RwaError,
  RwaConfigError,
  RwaWallError,
  RwaFundingLimitError,
  type RwaErrorCode,
} from "./errors.js";
