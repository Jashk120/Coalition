import type { Address } from "viem";

/**
 * Sepolia ENSv2 beta deployments (see `plans/ensv2.md` §2).
 *
 * Everything here is beta: interfaces are not final and addresses rotate.
 * Re-fetch the Deployments table
 * (`docs.ens.domains/learn/deployments/#sepolia-ensv2-beta` +
 * `contracts/deployments/sepolia/*.json` in `ensdomains/contracts-v2`)
 * before Day 8 and again at demo time. Every address below is overridable
 * per call — never rely on a checked-in literal at demo time.
 *
 * The one stable value is the UniversalResolver proxy, which callers should
 * reach via the viem `sepolia` chain preset (not via this literal).
 */

/** Stable UniversalResolver proxy — prefer the viem `sepolia` preset over this literal. */
export const SEPOLIA_ENSV2_UNIVERSAL_RESOLVER: Address =
  "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe";

/** `.eth` registry on Sepolia beta (re-check before use). */
export const SEPOLIA_ENSV2_ETH_REGISTRY: Address =
  "0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2";

/** `.eth` registrar on Sepolia beta (re-check before use). */
export const SEPOLIA_ENSV2_ETH_REGISTRAR: Address =
  "0xa88553f454b77203b0d036a05c894d555eaaa2cc";

/** Root registry on Sepolia beta (re-check before use). */
export const SEPOLIA_ENSV2_ROOT_REGISTRY: Address =
  "0x8115186e8f2e0b0281e86ab91f0f48ba90364354";

/** Permissioned resolver implementation on Sepolia beta (re-check before use). */
export const SEPOLIA_ENSV2_PERMISSIONED_RESOLVER_IMPL: Address =
  "0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e";

/** User-registry implementation on Sepolia beta (re-check before use). */
export const SEPOLIA_ENSV2_USER_REGISTRY_IMPL: Address =
  "0x624a25d67b59d587752ebec8dded8827dae52050";

/**
 * No default is exported for `VerifiableFactory` (or `MockUSDC`) on purpose:
 * both already rotated once between the docs pin and repo HEAD. Pass the
 * factory explicitly from a fresh `contracts/deployments/sepolia/*.json`
 * read — a checked-in literal would silently point at a stale deployment.
 */
export {};

/**
 * ENSIP-9/11 multicoin type for Arc testnet: `0x80000000 | 5042002`.
 *
 * Equals `Number(toCoinType(5042002))` from `viem/ens` — asserted in
 * `test/ens.test.ts` so a viem upgrade that changes derivation fails loudly.
 * Same `0x` address bytes as EVM; the coin type disambiguates.
 */
export const ARC_COIN_TYPE = 2152525650 as const;

/** Parent name under which per-agent subnames live (e.g. `agent1.agentpool.eth`). */
export const DEFAULT_PARENT_NAME = "agentpool.eth" as const;
