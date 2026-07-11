import { getAddress, isAddress } from "viem";

import { RwaConfigError } from "./errors.js";

/**
 * Address book supplied by the OPERATOR. This package ships NO hardcoded mainnet
 * addresses. Everything here is validated and checksummed at init; anything
 * missing or malformed throws `RwaConfigError` immediately — fail closed.
 */

export interface TokenInfo {
  symbol: string;
  address: string; // checksummed after validation
  decimals: number;
}

export interface RwaPaymentConfig {
  chainId: number;
  /** Verified DEX router (e.g. a Uniswap Universal Router) funding swaps go through. */
  router: string;
  /** Optional verified Permit2 used for approvals. */
  permit2?: string;
  /** Settlement tokens keyed by symbol (e.g. { USDG: { address, decimals } }). */
  settleTokens: Record<string, Omit<TokenInfo, "symbol">>;
  /** RWA tokens that may be sold to fund payments, keyed by symbol. */
  rwaTokens: Record<string, Omit<TokenInfo, "symbol">>;
}

/** Which RWA holdings may be sold, in priority order (first with liquidity wins). */
export interface RwaFundingConfig {
  /** Ordered list of RWA token symbols (must exist in config.rwaTokens). */
  symbols: string[];
}

export interface ResolvedConfig {
  chainId: number;
  router: string;
  permit2?: string;
  settleTokens: Record<string, TokenInfo>;
  rwaTokens: Record<string, TokenInfo>;
}

function requireAddress(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RwaConfigError(`${label} is missing.`);
  }
  if (!isAddress(value)) {
    throw new RwaConfigError(`${label} (${value}) is not a valid EVM address.`);
  }
  const checksummed = getAddress(value);
  if (checksummed === "0x0000000000000000000000000000000000000000") {
    throw new RwaConfigError(`${label} is the zero address.`);
  }
  return checksummed;
}

function resolveTokenMap(
  label: string,
  raw: Record<string, Omit<TokenInfo, "symbol">> | undefined,
): Record<string, TokenInfo> {
  if (!raw || typeof raw !== "object") {
    throw new RwaConfigError(`${label} map is missing.`);
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) {
    throw new RwaConfigError(`${label} map is empty.`);
  }
  const out: Record<string, TokenInfo> = {};
  for (const [symbol, info] of entries) {
    if (!info || typeof info !== "object") {
      throw new RwaConfigError(`${label} entry "${symbol}" is malformed.`);
    }
    const decimals = (info as { decimals?: unknown }).decimals;
    if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      throw new RwaConfigError(`${label} entry "${symbol}" has invalid decimals.`);
    }
    out[symbol] = {
      symbol,
      address: requireAddress(`${label}."${symbol}".address`, (info as { address?: unknown }).address),
      decimals,
    };
  }
  return out;
}

/**
 * Validate and checksum the operator config. Throws `RwaConfigError` on any
 * problem. Also enforces that the config chainId matches the caller's chainId.
 */
export function resolveConfig(config: RwaPaymentConfig, chainId: number): ResolvedConfig {
  if (!config || typeof config !== "object") {
    throw new RwaConfigError("config object is required.");
  }
  if (typeof config.chainId !== "number" || !Number.isInteger(config.chainId)) {
    throw new RwaConfigError("config.chainId must be an integer.");
  }
  if (config.chainId !== chainId) {
    throw new RwaConfigError(
      `config.chainId (${config.chainId}) does not match the options chainId (${chainId}).`,
    );
  }

  const resolved: ResolvedConfig = {
    chainId: config.chainId,
    router: requireAddress("config.router", config.router),
    settleTokens: resolveTokenMap("config.settleTokens", config.settleTokens),
    rwaTokens: resolveTokenMap("config.rwaTokens", config.rwaTokens),
  };
  if (config.permit2 !== undefined) {
    resolved.permit2 = requireAddress("config.permit2", config.permit2);
  }
  return resolved;
}

export function resolveSettleToken(config: ResolvedConfig, symbol: string): TokenInfo {
  const token = config.settleTokens[symbol];
  if (!token) {
    throw new RwaConfigError(`settleToken "${symbol}" is not present in config.settleTokens.`);
  }
  return token;
}

export function resolveFundingTokens(
  config: ResolvedConfig,
  funding: RwaFundingConfig,
): TokenInfo[] {
  if (!funding || !Array.isArray(funding.symbols) || funding.symbols.length === 0) {
    throw new RwaConfigError("fundFrom.symbols must be a non-empty array.");
  }
  return funding.symbols.map((symbol) => {
    const token = config.rwaTokens[symbol];
    if (!token) {
      throw new RwaConfigError(`fundFrom symbol "${symbol}" is not present in config.rwaTokens.`);
    }
    return token;
  });
}
