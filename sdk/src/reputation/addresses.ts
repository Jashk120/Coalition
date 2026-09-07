import type { Address } from "viem";

/**
 * ERC-8004 ReputationRegistry on Arc testnet.
 *
 * Universal testnet CREATE2 deployment (same address across testnets).
 * Source: erc-8004-contracts README "Arc Testnet" section.
 */
export const DEFAULT_REPUTATION_REGISTRY: Address =
  "0x8004B663056A597Dffe9eCcC1965A193B7388713";
