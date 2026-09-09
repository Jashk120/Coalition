import type { Address } from "viem";

/**
 * Pool discovery — the read-only search surface over available pools.
 *
 * Today `POOL_ADDRESS` is a singleton env var; this module keeps that as the
 * default while making multi-pool additive: callers pass an explicit list
 * (future on-chain registry / `POOL_ADDRESSES` env), an optional subgraph
 * scan, and an ENS namespace hint, and always get back a JSON-safe list that
 * works with 1 pool now and N pools later without breaking callers.
 *
 * Candidate sources, in priority order (dedupe keeps the first occurrence):
 *
 * 1. `extraPools` — explicit addresses (registry output, comma-separated
 *    `POOL_ADDRESSES` env parsed via {@link parsePoolAddressList}). The
 *    future on-chain registry plugs in here; no caller changes needed.
 * 2. `graphClient` scan — `listSubgraphPools` mirrors the existing
 *    `getPoolFill` query shape (`graph/queries.ts`) against the subgraph's
 *    `pools` entity. Unconfigured endpoint or query failure degrades to "no
 *    subgraph candidates", never an exception.
 * 3. `fallbackPool` — today's singleton (`POOL_ADDRESS`). Always included
 *    when nothing else produced candidates, so single-pool deployments keep
 *    working with zero configuration.
 *
 * The ENS namespace (`ensParentName`, e.g. `agentpool.eth`) is advisory
 * today: outputs are tagged with it, and when `ensProbe` (a Sepolia client
 * plus one seed name) is supplied the namespace is liveness-checked with the
 * existing `resolveArcWallet` primitive — best-effort, never fatal. There is
 * no on-chain ENS → pool mapping yet; when one lands (e.g. pool addresses in
 * text records) it becomes a fourth candidate source behind this same
 * return type.
 *
 * Enrichment per pool is read-only and reuses existing primitives:
 * subgraph-first `getPoolFill` when a graph client is present, otherwise
 * chain `getPoolState` + `getPoolMetadata`; `getCurrentRoundId`
 * best-effort with `"0"` for v1 pools (same legacy rule as
 * `app/lib/pool-state.ts`). One unreadable pool is skipped so it cannot hide
 * the healthy ones — discovery never throws for per-pool failures.
 */

/** Where one discovered pool address came from. Singleton is the default. */
export type PoolDiscoverySource = "explicit" | "subgraph" | "singleton";

/**
 * One discovered pool. All money is an atomic-unit decimal string and
 * `roundId` is a decimal string (JSON cannot carry bigint) — safe to return
 * from an API route unchanged.
 */
export type DiscoveredPool = {
  /** Pool contract address. */
  readonly pool: Address;
  /** Chain the pool lives on (e.g. Arc testnet 5042002). */
  readonly chainId: number;
  /** On-chain resource terms (see `getPoolMetadata`). */
  readonly resourceURI: string;
  /** Funding target in atomic units, decimal string. */
  readonly target: string;
  /** Committed total in atomic units, decimal string. */
  readonly totalCommitted: string;
  /** True once the pool settled atomically to the provider. */
  readonly settled: boolean;
  /** Live round id, decimal string; `"0"` on v1 pools without rounds. */
  readonly roundId: string;
  /** Which candidate source produced this address. */
  readonly source: PoolDiscoverySource;
  /** ENS namespace the search ran under (e.g. `agentpool.eth`). */
  readonly ensParent: string;
};

/** Thrown only for caller misconfiguration, before any network call. */
export class PoolDiscoveryError extends Error {
  readonly name = "PoolDiscoveryError";
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
  }
}
