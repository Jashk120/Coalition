import type { Address } from "viem";

/**
 * ERC-8004 IdentityRegistry on Arc testnet.
 *
 * Universal testnet CREATE2 deployment (same address across testnets).
 * Source: erc-8004-contracts README "Arc Testnet" section.
 */
export const DEFAULT_IDENTITY_REGISTRY: Address =
  "0x8004A818BFB912233c491871b3d84c89A494BD9e";
