// Runnable, fully-offline example. No RPC, no DEX, no real funds.
//
//   node example/basic.mjs
//
// It stubs the 402 handshake, the quoter, the price source, the chain adapter and
// the x402 settler so you can watch the fund-or-pay flow end to end.
//
// In production you would instead pass:
//   - a real viem wallet client as the first arg,
//   - a real Quoter (your DEX/aggregator),
//   - a real PriceSource (an independent oracle, e.g. Chainlink/Pyth),
//   - the viem ChainAdapter from "@canopy-finance/x402-rwa/viem",
//   - and let the default x402 settler complete the payment.

import {
  wrapFetchWithRwaPayment,
  StubQuoter,
  StubPrice,
} from "../dist/index.js";

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const OWNER = "0x1111111111111111111111111111111111111111";
const PRICE_PER_TOKEN = 100_000000n; // 1 NVDA -> 100 USDG (6 decimals)

// --- stub the 402 handshake -------------------------------------------------
function make402(requiredBaseUnits) {
  return new Response(
    JSON.stringify({
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: requiredBaseUnits.toString(),
          resource: "https://api.example.com/premium",
          description: "Premium data",
          mimeType: "application/json",
          payTo: "0x2222222222222222222222222222222222222222",
          maxTimeoutSeconds: 60,
          asset: USDG,
        },
      ],
    }),
    { status: 402, headers: { "content-type": "application/json" } },
  );
}

// --- stub chain adapter (in-memory balances) --------------------------------
function makeStubChain(init) {
  let settleBalance = init.settleBalance;
  let rwaBalance = init.rwaBalance;
  let allowance = 0n;
  return {
    async ownerAddress() {
      return OWNER;
    },
    async getErc20Balance(token) {
      return token.toLowerCase() === USDG.toLowerCase() ? settleBalance : rwaBalance;
    },
    async getErc20Allowance() {
      return allowance;
    },
    async sendApproval(step) {
      allowance = BigInt(step.amount);
      console.log(`  approve: spender=${step.spender} amount=${step.amount}`);
      return "0xapprove";
    },
    async sendSwap(tx) {
      settleBalance += init.settleGainOnSwap;
      rwaBalance -= 0n; // (stub) real adapter would decrement on-chain
      console.log(`  swap:    to=${tx.to} value=${tx.value}`);
      return "0xswap";
    },
    async waitForSuccess() {},
  };
}

// --- stub x402 settler (skips real signing/settlement) ----------------------
const stubSettler = {
  async settle({ requirement }) {
    console.log(`  pay:     ${requirement.maxAmountRequired} ${requirement.asset} -> ${requirement.payTo}`);
    return new Response(JSON.stringify({ data: "premium payload" }), { status: 200 });
  },
};

function buildFetch(chain) {
  return wrapFetchWithRwaPayment(/* walletClient */ {}, {
    settleToken: "USDG",
    fundFrom: { symbols: ["NVDA"] },
    chainId: 4663,
    maxAutoSwapUsd: 100,
    slippagePct: 1,
    quoter: new StubQuoter({
      router: ROUTER,
      pricePerToken: PRICE_PER_TOKEN,
      permit2: PERMIT2,
      includeApproval: true,
    }),
    priceSource: new StubPrice({ pricePerToken: PRICE_PER_TOKEN }),
    config: {
      chainId: 4663,
      router: ROUTER,
      permit2: PERMIT2,
      settleTokens: { USDG: { address: USDG, decimals: 6 } },
      rwaTokens: { NVDA: { address: NVDA, decimals: 18 } },
    },
    chain,
    settler: stubSettler,
    fetch: async () => make402(10_000000n), // invoice: 10 USDG
    confirm: async (plan) => {
      console.log(
        `  confirm: sell ~${plan.amountIn} ${plan.fundingToken.symbol} for ~$${plan.estimatedUsd.toFixed(2)} (floor ${plan.minOutFloor})`,
      );
      return true;
    },
  });
}

console.log("Scenario A: sufficient USDG -> pays directly, NO swap");
{
  const chain = makeStubChain({ settleBalance: 20_000000n, rwaBalance: 1_000000000000000000n, settleGainOnSwap: 0n });
  const res = await buildFetch(chain)("https://api.example.com/premium");
  console.log("  result:", res.status, await res.json());
}

console.log("\nScenario B: short USDG -> swap just enough NVDA, then pay");
{
  const chain = makeStubChain({
    settleBalance: 0n,
    rwaBalance: 1_000000000000000000n,
    settleGainOnSwap: 10_150000n,
  });
  const res = await buildFetch(chain)("https://api.example.com/premium");
  console.log("  result:", res.status, await res.json());
}
