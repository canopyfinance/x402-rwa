import { describe, expect, it, vi } from "vitest";

import type { ChainAdapter } from "./chain.js";
import type { RwaPaymentConfig } from "./config.js";
import { RwaConfigError, RwaError, RwaFundingLimitError, RwaWallError } from "./errors.js";
import { StubPrice } from "./price.js";
import { StubQuoter } from "./quoter.js";
import type { PaymentSettler } from "./settle.js";
import type { ApprovalStep, QuoteTx } from "./wall.js";
import { wrapFetchWithRwaPayment, type WrapRwaPaymentOptions } from "./wrap.js";

const CHAIN = 4663;
const OWNER = "0x1111111111111111111111111111111111111111";
const USDG_ADDR = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const NVDA_ADDR = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// 1 NVDA = 100 USDG (USDG has 6 decimals, NVDA 18).
const PRICE_PER_TOKEN = 100_000000n;

function config(): RwaPaymentConfig {
  return {
    chainId: CHAIN,
    router: ROUTER,
    permit2: PERMIT2,
    settleTokens: { USDG: { address: USDG_ADDR, decimals: 6 } },
    rwaTokens: { NVDA: { address: NVDA_ADDR, decimals: 18 } },
  };
}

function make402(requiredBaseUnits: bigint): Response {
  const body = {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        maxAmountRequired: requiredBaseUnits.toString(),
        resource: "https://api.example.com/data",
        description: "test",
        mimeType: "application/json",
        payTo: "0x2222222222222222222222222222222222222222",
        maxTimeoutSeconds: 60,
        asset: USDG_ADDR,
      },
    ],
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

class StubChain implements ChainAdapter {
  settleBalance: bigint;
  rwaBalance: bigint;
  allowance: bigint;
  settleGainOnSwap: bigint;
  swaps: QuoteTx[] = [];
  approvals: ApprovalStep[] = [];

  constructor(init: {
    settleBalance: bigint;
    rwaBalance: bigint;
    allowance?: bigint;
    settleGainOnSwap?: bigint;
  }) {
    this.settleBalance = init.settleBalance;
    this.rwaBalance = init.rwaBalance;
    this.allowance = init.allowance ?? 0n;
    this.settleGainOnSwap = init.settleGainOnSwap ?? 0n;
  }
  async ownerAddress() {
    return OWNER;
  }
  async getErc20Balance(token: string) {
    return token.toLowerCase() === USDG_ADDR.toLowerCase() ? this.settleBalance : this.rwaBalance;
  }
  async getErc20Allowance() {
    return this.allowance;
  }
  async sendApproval(step: ApprovalStep) {
    this.approvals.push(step);
    this.allowance = BigInt(step.amount);
    return "0xapprove";
  }
  async sendSwap(tx: QuoteTx) {
    this.swaps.push(tx);
    this.settleBalance += this.settleGainOnSwap;
    return "0xswap";
  }
  async waitForSuccess() {}
}

function stubSettler(): PaymentSettler & { calls: number } {
  const settler = {
    calls: 0,
    async settle() {
      settler.calls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  };
  return settler;
}

function baseOptions(
  chain: ChainAdapter,
  settler: PaymentSettler,
  over: Partial<WrapRwaPaymentOptions> = {},
): WrapRwaPaymentOptions {
  return {
    settleToken: "USDG",
    fundFrom: { symbols: ["NVDA"] },
    chainId: CHAIN,
    maxAutoSwapUsd: 100,
    slippagePct: 1,
    quoter: new StubQuoter({ router: ROUTER, pricePerToken: PRICE_PER_TOKEN, permit2: PERMIT2 }),
    priceSource: new StubPrice({ pricePerToken: PRICE_PER_TOKEN }),
    config: config(),
    chain,
    settler,
    now: () => 1_000_000_000, // fixed ms clock
    fetch: async () => make402(10_000000n),
    ...over,
  };
}

const WALLET = {} as never;

describe("criterion 3: sufficient settlement balance pays directly, NO swap", () => {
  it("pays without swapping when balance covers the invoice", async () => {
    const chain = new StubChain({ settleBalance: 20_000000n, rwaBalance: 1_000000000000000000n });
    const settler = stubSettler();
    const paidFetch = wrapFetchWithRwaPayment(WALLET, baseOptions(chain, settler));

    const res = await paidFetch("https://api.example.com/data");

    expect(res.status).toBe(200);
    expect(chain.swaps.length).toBe(0);
    expect(settler.calls).toBe(1);
  });

  it("passes through non-402 responses untouched", async () => {
    const chain = new StubChain({ settleBalance: 0n, rwaBalance: 0n });
    const settler = stubSettler();
    const paidFetch = wrapFetchWithRwaPayment(
      WALLET,
      baseOptions(chain, settler, {
        fetch: async () => new Response("hi", { status: 200 }),
      }),
    );
    const res = await paidFetch("https://api.example.com/data");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hi");
    expect(settler.calls).toBe(0);
  });
});

describe("criterion 4: short balance -> plan, wall, settle, then pay", () => {
  it("swaps just enough RWA, approves, then completes payment", async () => {
    const chain = new StubChain({
      settleBalance: 0n,
      rwaBalance: 1_000000000000000000n, // 1 NVDA
      allowance: 0n,
      settleGainOnSwap: 10_150000n, // swap yields ~10.15 USDG, covers 10 owed
    });
    const settler = stubSettler();
    const paidFetch = wrapFetchWithRwaPayment(
      WALLET,
      baseOptions(chain, settler, {
        quoter: new StubQuoter({
          router: ROUTER,
          pricePerToken: PRICE_PER_TOKEN,
          permit2: PERMIT2,
          includeApproval: true,
        }),
      }),
    );

    const res = await paidFetch("https://api.example.com/data");

    expect(res.status).toBe(200);
    expect(chain.swaps.length).toBe(1);
    expect(chain.approvals.length).toBe(1);
    expect(chain.swaps[0].to.toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(settler.calls).toBe(1);
  });

  it("aborts (no swap, no pay) when the quote fails the wall", async () => {
    const chain = new StubChain({
      settleBalance: 0n,
      rwaBalance: 1_000000000000000000n,
      settleGainOnSwap: 10_150000n,
    });
    const settler = stubSettler();
    const paidFetch = wrapFetchWithRwaPayment(
      WALLET,
      baseOptions(chain, settler, {
        quoter: new StubQuoter({
          router: ROUTER,
          pricePerToken: PRICE_PER_TOKEN,
          overrides: { tx: { to: "0xbad", value: "0", data: "0x" } },
        }),
      }),
    );

    await expect(paidFetch("https://api.example.com/data")).rejects.toBeInstanceOf(RwaWallError);
    expect(chain.swaps.length).toBe(0);
    expect(settler.calls).toBe(0);
  });
});

describe("criterion 7: maxAutoSwapUsd exceeded -> error, no swap, no payment", () => {
  it("throws RwaFundingLimitError and never swaps or pays", async () => {
    const chain = new StubChain({
      settleBalance: 0n,
      rwaBalance: 1_000000000000000000n,
      settleGainOnSwap: 10_150000n,
    });
    const settler = stubSettler();
    const paidFetch = wrapFetchWithRwaPayment(
      WALLET,
      baseOptions(chain, settler, { maxAutoSwapUsd: 5 }), // need ~$10.15, cap $5
    );

    await expect(paidFetch("https://api.example.com/data")).rejects.toBeInstanceOf(
      RwaFundingLimitError,
    );
    expect(chain.swaps.length).toBe(0);
    expect(settler.calls).toBe(0);
  });

  it("enforces the cumulative session cap", async () => {
    const chain = new StubChain({
      settleBalance: 0n,
      rwaBalance: 1_000000000000000000n,
      settleGainOnSwap: 10_150000n,
    });
    const settler = stubSettler();
    const paidFetch = wrapFetchWithRwaPayment(
      WALLET,
      baseOptions(chain, settler, { maxAutoSwapUsd: 100, maxSessionSwapUsd: 5 }),
    );
    await expect(paidFetch("https://api.example.com/data")).rejects.toBeInstanceOf(
      RwaFundingLimitError,
    );
    expect(chain.swaps.length).toBe(0);
  });
});

describe("criterion 9: confirm() returning false aborts before signing", () => {
  it("does not swap or pay when confirm rejects", async () => {
    const chain = new StubChain({
      settleBalance: 0n,
      rwaBalance: 1_000000000000000000n,
      settleGainOnSwap: 10_150000n,
    });
    const settler = stubSettler();
    const confirm = vi.fn(async () => false);
    const paidFetch = wrapFetchWithRwaPayment(WALLET, baseOptions(chain, settler, { confirm }));

    await expect(paidFetch("https://api.example.com/data")).rejects.toBeInstanceOf(RwaError);
    expect(confirm).toHaveBeenCalledOnce();
    expect(chain.swaps.length).toBe(0);
    expect(settler.calls).toBe(0);
  });

  it("proceeds when confirm approves", async () => {
    const chain = new StubChain({
      settleBalance: 0n,
      rwaBalance: 1_000000000000000000n,
      settleGainOnSwap: 10_150000n,
    });
    const settler = stubSettler();
    const confirm = vi.fn(async () => true);
    const paidFetch = wrapFetchWithRwaPayment(WALLET, baseOptions(chain, settler, { confirm }));

    const res = await paidFetch("https://api.example.com/data");
    expect(res.status).toBe(200);
    expect(chain.swaps.length).toBe(1);
    expect(settler.calls).toBe(1);
  });
});

describe("init-time guards", () => {
  it("throws RwaConfigError on chainId mismatch", () => {
    const chain = new StubChain({ settleBalance: 0n, rwaBalance: 0n });
    expect(() =>
      wrapFetchWithRwaPayment(WALLET, baseOptions(chain, stubSettler(), { chainId: 1 })),
    ).toThrow(RwaConfigError);
  });
  it("throws RwaConfigError when maxAutoSwapUsd is not positive", () => {
    const chain = new StubChain({ settleBalance: 0n, rwaBalance: 0n });
    expect(() =>
      wrapFetchWithRwaPayment(WALLET, baseOptions(chain, stubSettler(), { maxAutoSwapUsd: 0 })),
    ).toThrow(RwaConfigError);
  });
});
