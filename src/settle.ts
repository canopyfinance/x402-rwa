import { createPaymentHeader } from "x402/client";
import type { PaymentRequirements } from "x402/types";

import { RwaError } from "./errors.js";
import type { WalletClientLike } from "./types.js";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface Parsed402 {
  x402Version: number;
  accepts: PaymentRequirements[];
}

/** Parse an x402 402 body without consuming the caller's response stream. */
export async function parse402(response: Response): Promise<Parsed402> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    throw new RwaError("UNSUPPORTED_402", "402 response body is not valid JSON.");
  }
  const obj = body as { x402Version?: unknown; accepts?: unknown };
  if (typeof obj?.x402Version !== "number" || !Array.isArray(obj?.accepts)) {
    throw new RwaError(
      "UNSUPPORTED_402",
      "402 response is not a valid x402 payload (missing x402Version/accepts).",
    );
  }
  return { x402Version: obj.x402Version, accepts: obj.accepts as PaymentRequirements[] };
}

/**
 * Pick the payment requirement denominated in our settlement token. Fail closed if
 * the resource does not accept our settlement asset — we never pay in a token the
 * helper was not configured for.
 */
export function selectRequirementForAsset(
  accepts: PaymentRequirements[],
  settleAsset: string,
): PaymentRequirements | undefined {
  const wanted = settleAsset.toLowerCase();
  return accepts.find((r) => typeof r.asset === "string" && r.asset.toLowerCase() === wanted);
}

export interface SettleContext {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
  requirement: PaymentRequirements;
  x402Version: number;
  walletClient: WalletClientLike;
}

/**
 * Completes the x402 payment. Injectable so the fund-or-pay flow can be tested with
 * a mocked handshake. The default delegates settlement to x402 client primitives —
 * it does NOT reimplement x402 settlement.
 */
export interface PaymentSettler {
  settle(ctx: SettleContext): Promise<Response>;
}

/**
 * Default settler: builds the X-PAYMENT header via x402's `createPaymentHeader`
 * (the canonical client primitive) and retries the request once with it.
 */
export function createX402Settler(fetchImpl: FetchLike): PaymentSettler {
  return {
    async settle(ctx: SettleContext): Promise<Response> {
      const header = await createPaymentHeader(
        // x402's Signer type; the caller-supplied wallet client fulfills it.
        ctx.walletClient as never,
        ctx.x402Version,
        ctx.requirement,
      );
      const headers = new Headers(ctx.init?.headers);
      headers.set("X-PAYMENT", header);
      headers.set("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");
      return fetchImpl(ctx.input, { ...ctx.init, headers });
    },
  };
}
