import type { Address } from "viem";

/**
 * Fill snapshot for one pool. All money is bigint atomic units; amounts
 * cross the wire as decimal strings (JSON cannot carry bigint).
 */
export type PoolFill = {
  readonly pool: Address;
  readonly target: bigint;
  readonly totalCommitted: bigint;
  readonly settled: boolean;
  readonly participantCount: bigint;
};

/** One wallet's commitment to a pool. Amount is bigint atomic units. */
export type Commitment = {
  readonly wallet: Address;
  readonly amount: bigint;
  readonly blockNumber: bigint;
};

/** One wallet's forfeited stake after dropping out. */
export type Dropout = {
  readonly wallet: Address;
  readonly forfeited: bigint;
};

/** Thrown when the subgraph cannot be queried or parsed. */
export class GraphError extends Error {
  readonly name = "GraphError";
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
  }
}
