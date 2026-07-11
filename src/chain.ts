import type { ApprovalStep, QuoteTx } from "./wall.js";

/**
 * Chain access needed to fund a payment: read the payer's balances/allowances and
 * broadcast the (user/agent-signed) approval + swap transactions. Injected so the
 * core is testable with stubs and unbound to any single RPC. A viem-based reference
 * adapter is available from `@canopy-finance/x402-rwa/viem`.
 *
 * NON-CUSTODIAL: the adapter signs with the wallet the caller supplied and holds no
 * keys or funds of its own.
 */
export interface ChainAdapter {
  /** Address whose balances are checked and that signs the swaps (the payer). */
  ownerAddress(): Promise<string>;
  getErc20Balance(token: string, owner: string): Promise<bigint>;
  getErc20Allowance(token: string, owner: string, spender: string): Promise<bigint>;
  /** Sign & broadcast an ERC-20 approval; resolve to the tx hash. */
  sendApproval(step: ApprovalStep): Promise<string>;
  /** Sign & broadcast the swap tx; resolve to the tx hash. */
  sendSwap(tx: QuoteTx): Promise<string>;
  /** Wait for a tx to confirm; MUST reject if it reverted. */
  waitForSuccess(hash: string): Promise<void>;
}
