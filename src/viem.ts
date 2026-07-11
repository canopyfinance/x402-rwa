import {
  erc20Abi,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

import type { ChainAdapter } from "./chain.js";
import type { ApprovalStep, QuoteTx } from "./wall.js";

/**
 * Reference viem `ChainAdapter`. Optional export — `viem` is a peer dependency, not
 * a hard one. NON-CUSTODIAL: it signs with the wallet client you pass and holds no
 * keys or funds.
 */
export interface ViemChainAdapterOptions {
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** Defaults to walletClient.account.address. */
  account?: Account | Address;
}

function resolveAccount(opts: ViemChainAdapterOptions): Address {
  const acct = opts.account ?? opts.walletClient.account;
  if (!acct) {
    throw new Error("createViemChainAdapter: no account on walletClient; pass options.account.");
  }
  return (typeof acct === "string" ? acct : acct.address) as Address;
}

export function createViemChainAdapter(opts: ViemChainAdapterOptions): ChainAdapter {
  const { publicClient, walletClient } = opts;
  const owner = resolveAccount(opts);

  return {
    async ownerAddress(): Promise<string> {
      return owner;
    },

    async getErc20Balance(token: string, ownerAddr: string): Promise<bigint> {
      return publicClient.readContract({
        address: token as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [ownerAddr as Address],
      });
    },

    async getErc20Allowance(token: string, ownerAddr: string, spender: string): Promise<bigint> {
      return publicClient.readContract({
        address: token as Address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [ownerAddr as Address, spender as Address],
      });
    },

    async sendApproval(step: ApprovalStep): Promise<string> {
      const account = walletClient.account ?? (owner as Address);
      const hash = await walletClient.writeContract({
        address: step.to as Address,
        abi: erc20Abi,
        functionName: "approve",
        args: [step.spender as Address, BigInt(step.amount)],
        account: account as Account | Address,
        chain: walletClient.chain,
      });
      return hash;
    },

    async sendSwap(tx: QuoteTx): Promise<string> {
      const account = walletClient.account ?? (owner as Address);
      const hash = await walletClient.sendTransaction({
        to: tx.to as Address,
        data: tx.data as Hex,
        value: BigInt(tx.value),
        account: account as Account | Address,
        chain: walletClient.chain,
      });
      return hash;
    },

    async waitForSuccess(hash: string): Promise<void> {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: hash as Hex });
      if (receipt.status !== "success") {
        throw new Error(`Transaction ${hash} reverted.`);
      }
    },
  };
}
