import type { Account, Address, Hash, PublicClient, WalletClient } from "viem";

import type { AgentId } from "../identity/index.js";
import { resourcePoolAbi } from "./abi.js";
import type { PoolState } from "./types.js";

export type PoolWriteParams = {
  readonly walletClient: WalletClient;
  readonly account: Account;
  /** Pool address — always explicit, never defaulted (see addresses.ts). */
  readonly pool: Address;
};

export type CommitToPoolParams = PoolWriteParams & {
  /** Commitment in atomic units — convert with toAtomicUsdc first. */
  readonly amount: bigint;
};

/** Commit funds to the pool. Cap-checked off-chain with wouldExceedTarget. */
export async function commitToPool(
  params: CommitToPoolParams,
): Promise<{ readonly hash: Hash }> {
  const hash = await params.walletClient.writeContract({
    address: params.pool,
    abi: resourcePoolAbi,
    functionName: "commit",
    args: [params.amount],
    account: params.account,
    chain: params.walletClient.chain,
  });
  return { hash };
}

export type DropOutParams = PoolWriteParams & {
  readonly agentId: AgentId;
};

/**
 * Drop out after committing. Collateral is forfeited to the remaining
 * participants per pool rules — this call is economically destructive.
 */
export async function dropOut(
  params: DropOutParams,
): Promise<{ readonly hash: Hash }> {
  const hash = await params.walletClient.writeContract({
    address: params.pool,
    abi: resourcePoolAbi,
    functionName: "dropOut",
    args: [params.agentId],
    account: params.account,
    chain: params.walletClient.chain,
  });
  return { hash };
}

/**
 * Close an expired, unfilled pool. This only snapshots refund accounting —
 * no funds move here. Each remaining participant then pulls their share
 * (own stake plus pro-rata forfeiture) with claimRefund.
 */
export async function finalizeExpired(
  params: PoolWriteParams,
): Promise<{ readonly hash: Hash }> {
  const hash = await params.walletClient.writeContract({
    address: params.pool,
    abi: resourcePoolAbi,
    functionName: "finalizeExpired",
    account: params.account,
    chain: params.walletClient.chain,
  });
  return { hash };
}

/**
 * Pull the caller's snapshotted refund after finalizeExpired. One caller
 * per call — each claim is O(1) and independent, so a participant that
 * never claims cannot grief anyone else's refund.
 */
export async function claimRefund(
  params: PoolWriteParams,
): Promise<{ readonly hash: Hash }> {
  const hash = await params.walletClient.writeContract({
    address: params.pool,
    abi: resourcePoolAbi,
    functionName: "claimRefund",
    account: params.account,
    chain: params.walletClient.chain,
  });
  return { hash };
}

/** Settle a filled pool atomically to the provider. O(1) — no feedback written here. */
export async function settlePool(
  params: PoolWriteParams,
): Promise<{ readonly hash: Hash }> {
  const hash = await params.walletClient.writeContract({
    address: params.pool,
    abi: resourcePoolAbi,
    functionName: "settle",
    account: params.account,
    chain: params.walletClient.chain,
  });
  return { hash };
}

export type RecordCompletionsParams = PoolWriteParams & {
  /** Max participants to process from the cursor this call — repeat until drained. */
  readonly maxRecords: bigint;
};

/**
 * Write completion feedback for up to maxRecords participants from the
 * settle cursor. Repeat until the cursor is drained (see feedbackCursor
 * via getPoolState follow-ups) — each participant is recorded at most once.
 */
export async function recordCompletions(
  params: RecordCompletionsParams,
): Promise<{ readonly hash: Hash }> {
  const hash = await params.walletClient.writeContract({
    address: params.pool,
    abi: resourcePoolAbi,
    functionName: "recordCompletions",
    args: [params.maxRecords],
    account: params.account,
    chain: params.walletClient.chain,
  });
  return { hash };
}

export type GetPoolStateParams = {
  readonly publicClient: PublicClient;
  readonly pool: Address;
};

/** Read the pool's funding progress and terminal flags in one round trip. */
export async function getPoolState(
  params: GetPoolStateParams,
): Promise<PoolState> {
  const [target, totalCommitted, settled, expired, participantCount] =
    await Promise.all([
      params.publicClient.readContract({
        address: params.pool,
        abi: resourcePoolAbi,
        functionName: "target",
      }),
      params.publicClient.readContract({
        address: params.pool,
        abi: resourcePoolAbi,
        functionName: "totalCommitted",
      }),
      params.publicClient.readContract({
        address: params.pool,
        abi: resourcePoolAbi,
        functionName: "settled",
      }),
      params.publicClient.readContract({
        address: params.pool,
        abi: resourcePoolAbi,
        functionName: "expired",
      }),
      params.publicClient.readContract({
        address: params.pool,
        abi: resourcePoolAbi,
        functionName: "participantCount",
      }),
    ]);
  return { target, totalCommitted, settled, expired, participantCount };
}

/**
 * True when committing `amount` on top of `state` would pass the target.
 * Check before commitToPool — the contract caps over-commit at targetAmount.
 */
export function wouldExceedTarget(state: PoolState, amount: bigint): boolean {
  return state.totalCommitted + amount > state.target;
}

/** Deploy-time pool metadata: resource terms, committer cap, feedback progress. */
export type PoolMetadata = {
  readonly resourceURI: string;
  readonly maxParticipants: bigint;
  readonly feedbackCursor: bigint;
};

/** Read the pool's resource terms, committer cap, and feedback cursor in one round trip. */
export async function getPoolMetadata(
  params: GetPoolStateParams,
): Promise<PoolMetadata> {
  const [resourceURI, maxParticipants, feedbackCursor] = await Promise.all([
    params.publicClient.readContract({
      address: params.pool,
      abi: resourcePoolAbi,
      functionName: "resourceURI",
    }),
    params.publicClient.readContract({
      address: params.pool,
      abi: resourcePoolAbi,
      functionName: "maxParticipants",
    }),
    params.publicClient.readContract({
      address: params.pool,
      abi: resourcePoolAbi,
      functionName: "feedbackCursor",
    }),
  ]);
  return { resourceURI, maxParticipants, feedbackCursor };
}
