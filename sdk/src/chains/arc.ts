import { arcTestnet } from "viem/chains";

/** Arc testnet chain id (see implementation plan §4). */
export const ARC_TESTNET_ID = 5042002 as const;

/**
 * Arc testnet HTTP RPC endpoint (docs-canonical).
 *
 * Current Arc docs (`docs.arc.io/arc/references/rpc-endpoints`) list
 * `rpc.testnet.arc.io`; the bundled viem preset still carries
 * `rpc.testnet.arc.network` variants as fallback.
 */
export const ARC_TESTNET_RPC_HTTP = "https://rpc.testnet.arc.io" as const;

/** Arc testnet WebSocket RPC endpoint (docs-canonical, see note above). */
export const ARC_TESTNET_RPC_WS = "wss://rpc.testnet.arc.io" as const;

/** Arc testnet block explorer. */
export const ARC_EXPLORER = "https://testnet.arcscan.app" as const;

/** Circle faucet for Arc testnet funds. */
export const ARC_FAUCET = "https://faucet.circle.com" as const;

/**
 * Arc testnet chain definition for viem clients.
 *
 * Re-exported from viem's built-in preset — per official Arc docs and the
 * Circle `use-arc` skill, a custom chain definition is never required.
 * Gas is paid in native USDC with 18 decimals; the ERC-20 view of the
 * same balance uses 6 decimals (see `usdc.ts`).
 */
export const ARC_TESTNET = arcTestnet;
