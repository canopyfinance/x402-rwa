import { describe, expect, it } from "vitest";

import { resolveConfig, resolveFundingTokens, resolveSettleToken, type RwaPaymentConfig } from "./config.js";
import { RwaConfigError } from "./errors.js";

const CHAIN = 4663;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";

function good(): RwaPaymentConfig {
  return {
    chainId: CHAIN,
    router: ROUTER,
    settleTokens: { USDG: { address: USDG, decimals: 6 } },
    rwaTokens: { NVDA: { address: NVDA, decimals: 18 } },
  };
}

describe("config validation (criterion 8: invalid/missing config throws at init)", () => {
  it("resolves and checksums a good config", () => {
    const c = resolveConfig(good(), CHAIN);
    expect(c.router).not.toBe(ROUTER.toLowerCase()); // got checksummed
    expect(c.settleTokens.USDG.address.toLowerCase()).toBe(USDG);
  });

  it("throws when config is missing", () => {
    expect(() => resolveConfig(undefined as unknown as RwaPaymentConfig, CHAIN)).toThrow(RwaConfigError);
  });

  it("throws on chainId mismatch", () => {
    expect(() => resolveConfig(good(), 1)).toThrow(RwaConfigError);
  });

  it("throws on invalid router address", () => {
    expect(() => resolveConfig({ ...good(), router: "0xnotanaddress" }, CHAIN)).toThrow(RwaConfigError);
  });

  it("throws on the zero address", () => {
    const bad = { ...good(), router: "0x0000000000000000000000000000000000000000" };
    expect(() => resolveConfig(bad, CHAIN)).toThrow(RwaConfigError);
  });

  it("throws on empty settleTokens", () => {
    expect(() => resolveConfig({ ...good(), settleTokens: {} }, CHAIN)).toThrow(RwaConfigError);
  });

  it("throws on invalid token decimals", () => {
    const bad = { ...good(), rwaTokens: { NVDA: { address: NVDA, decimals: -1 } } };
    expect(() => resolveConfig(bad, CHAIN)).toThrow(RwaConfigError);
  });

  it("throws when a token address is malformed", () => {
    const bad = { ...good(), rwaTokens: { NVDA: { address: "0x123", decimals: 18 } } };
    expect(() => resolveConfig(bad, CHAIN)).toThrow(RwaConfigError);
  });

  it("resolveSettleToken throws for an unknown symbol", () => {
    const c = resolveConfig(good(), CHAIN);
    expect(() => resolveSettleToken(c, "DAI")).toThrow(RwaConfigError);
  });

  it("resolveFundingTokens throws for an unknown symbol", () => {
    const c = resolveConfig(good(), CHAIN);
    expect(() => resolveFundingTokens(c, { symbols: ["TSLA"] })).toThrow(RwaConfigError);
  });

  it("resolveFundingTokens throws on empty symbols", () => {
    const c = resolveConfig(good(), CHAIN);
    expect(() => resolveFundingTokens(c, { symbols: [] })).toThrow(RwaConfigError);
  });
});
