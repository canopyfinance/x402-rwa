/**
 * Typed errors. Every failure path in this package throws one of these so callers
 * can branch on `err.code` instead of string-matching messages. The wrapper NEVER
 * silently pays with a bad swap — it throws.
 */

export type RwaErrorCode =
  | "CONFIG_INVALID"
  | "UNSUPPORTED_402"
  | "NO_FUNDING_ROUTE"
  | "WALL_REJECTED"
  | "LIMIT_EXCEEDED"
  | "SESSION_LIMIT_EXCEEDED"
  | "CONFIRM_DECLINED"
  | "SWAP_FAILED"
  | "INSUFFICIENT_AFTER_SWAP"
  | "PRICE_UNAVAILABLE";

export class RwaError extends Error {
  readonly code: RwaErrorCode;
  constructor(code: RwaErrorCode, message: string) {
    super(message);
    this.name = "RwaError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown at init when the operator-supplied address config is missing/invalid. */
export class RwaConfigError extends RwaError {
  constructor(message: string) {
    super("CONFIG_INVALID", message);
    this.name = "RwaConfigError";
  }
}

/** The validation wall rejected a funding swap. Carries the specific reasons. */
export class RwaWallError extends RwaError {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super("WALL_REJECTED", `Funding swap rejected by the validation wall: ${reasons.join("; ")}`);
    this.name = "RwaWallError";
    this.reasons = reasons;
  }
}

/**
 * Funding a payment would exceed a hard USD ceiling. NO swap is attempted and NO
 * payment is made. `limitUsd` is the ceiling that was hit; `requestedUsd` is what
 * the swap would have cost.
 */
export class RwaFundingLimitError extends RwaError {
  readonly limitUsd: number;
  readonly requestedUsd: number;
  readonly scope: "payment" | "session";
  constructor(scope: "payment" | "session", requestedUsd: number, limitUsd: number) {
    super(
      scope === "payment" ? "LIMIT_EXCEEDED" : "SESSION_LIMIT_EXCEEDED",
      `Funding swap of ~$${requestedUsd.toFixed(2)} exceeds the ${scope} cap of $${limitUsd.toFixed(2)}. No swap, no payment.`,
    );
    this.name = "RwaFundingLimitError";
    this.scope = scope;
    this.limitUsd = limitUsd;
    this.requestedUsd = requestedUsd;
  }
}
