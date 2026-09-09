/** Live state of one resource pool. All amounts are bigint atomic units. */
export type PoolState = {
  readonly target: bigint;
  readonly totalCommitted: bigint;
  readonly settled: boolean;
  readonly expired: boolean;
  readonly participantCount: bigint;
};

/** Live state of one funding round. All amounts are bigint atomic units. */
export type RoundState = PoolState & {
  readonly roundId: bigint;
  readonly deadline: bigint;
};
