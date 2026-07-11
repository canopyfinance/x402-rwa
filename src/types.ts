import type { Signer, MultiNetworkSigner } from "x402/types";

/**
 * The wallet client used to sign x402 payments. This is x402's `Signer` (a viem
 * account/wallet client works directly). The package is NON-CUSTODIAL: it only ever
 * asks this client to sign — it never stores keys or funds.
 */
export type WalletClientLike = Signer | MultiNetworkSigner;
