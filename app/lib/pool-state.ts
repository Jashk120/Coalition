import { parseEventLogs } from "viem";
import type { Address } from "viem";
import {
  createGraphClient,
  getCommitted,
  getCurrentRoundId,
  getPoolFill,
  getPoolState,
  getRoundState,
  resourcePoolAbi,
} from "@jx-nexus/coalition";
import type { PoolState, RoundState } from "@jx-nexus/coalition";
import { ROUND_HISTORY_LIMIT, TARGET_ATOMIC } from "./constants";
import { POOL_ADDRESS, POOL_DEPLOY_BLOCK } from "./constants";
import { arcPublicClient } from "./chain";
import type { ActivityEvent, PoolStateView, RoundView } from "./types";

export type PoolReadout = {
  readonly view: PoolStateView;
  readonly source: "subgraph" | "chain" | "fallback";
  readonly note?: string;
};

export type RoundReadout = {
  readonly view: RoundView;
  readonly source: "chain" | "legacy" | "fallback";
  readonly note?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reject a read that hangs so the dashboard degrades instead of stalling. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(ms)}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

const ZERO_VIEW: PoolStateView = {
  target: TARGET_ATOMIC.toString(),
  totalCommitted: "0",
  settled: false,
  expired: false,
  participantCount: "0",
};

const ZERO_ROUND: RoundView = {
  roundId: "0",
  target: TARGET_ATOMIC.toString(),
  totalCommitted: "0",
  settled: false,
  expired: false,
  deadline: "0",
  participantCount: "0",
};

function toRoundView(roundId: bigint, state: RoundState): RoundView {
  return {
    roundId: roundId.toString(),
    target: state.target.toString(),
    totalCommitted: state.totalCommitted.toString(),
    settled: state.settled,
    expired: state.expired,
    deadline: state.deadline.toString(),
    participantCount: state.participantCount.toString(),
  };
}

/** Chain pool read with 1.5s/3s/6s backoff: five eth_calls at once trip the throttle. */
async function readChainState(): Promise<PoolState> {
  let attempt = 0;
  for (;;) {
    try {
      return await withTimeout(
        getPoolState({ publicClient: arcPublicClient(), pool: POOL_ADDRESS }),
        10_000,
        "chain getPoolState",
      );
    } catch (error) {
      if (!isRateLimit(error) || attempt >= 3) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 1500 * 2 ** attempt),
      );
      attempt += 1;
    }
  }
}

/**
 * Pool funding snapshot, subgraph-first with a chain fallback.
 * Studio can lag behind the head — when it errors or is unconfigured,
 * `getPoolState` on Arc is the source of truth; when both fail the
 * zeroed fallback keeps the dashboard renderable with an explanatory note.
 */
export async function readPoolState(): Promise<PoolReadout> {
  const notes: string[] = [];

  const endpoint = process.env["SUBGRAPH_ENDPOINT"];
  if (endpoint !== undefined && endpoint !== "") {
    try {
      const apiKey = process.env["SUBGRAPH_API_KEY"];
      const client = createGraphClient({
        endpoint,
        ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }),
      });
      const fill = await withTimeout(
        getPoolFill(client, POOL_ADDRESS),
        10_000,
        "subgraph getPoolFill",
      );
      let expired = false;
      try {
        const chain = await withTimeout(
          readChainState(),
          30_000,
          "chain getPoolState (expired flag)",
        );
        expired = chain.expired;
      } catch (error) {
        notes.push(`chain expired-flag read failed: ${errorMessage(error)}`);
      }
      return {
        view: {
          target: fill.target.toString(),
          totalCommitted: fill.totalCommitted.toString(),
          settled: fill.settled,
          expired,
          participantCount: fill.participantCount.toString(),
        },
        source: "subgraph",
        ...(notes.length === 0 ? {} : { note: notes.join("; ") }),
      };
    } catch (error) {
      notes.push(`subgraph read failed: ${errorMessage(error)}`);
    }
  }

  try {
    const state = await withTimeout(
      readChainState(),
      30_000,
      "chain getPoolState",
    );
    return {
      view: {
        target: state.target.toString(),
        totalCommitted: state.totalCommitted.toString(),
        settled: state.settled,
        expired: state.expired,
        participantCount: state.participantCount.toString(),
      },
      source: "chain",
      ...(notes.length === 0 ? {} : { note: notes.join("; ") }),
    };
  } catch (error) {
    notes.push(`chain read failed: ${errorMessage(error)}`);
  }

  return { view: ZERO_VIEW, source: "fallback", note: notes.join("; ") };
}

/** Chain round-id read with 1.5s/3s/6s backoff, same style as readChainState. */
async function readChainRoundId(): Promise<bigint> {
  let attempt = 0;
  for (;;) {
    try {
      return await withTimeout(
        getCurrentRoundId({
          publicClient: arcPublicClient(),
          pool: POOL_ADDRESS,
        }),
        10_000,
        "chain getCurrentRoundId",
      );
    } catch (error) {
      if (!isRateLimit(error) || attempt >= 3) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 1500 * 2 ** attempt),
      );
      attempt += 1;
    }
  }
}

/** Chain per-round read with 1.5s/3s/6s backoff, same style as readChainState. */
async function readChainRoundState(roundId: bigint): Promise<RoundState> {
  let attempt = 0;
  for (;;) {
    try {
      return await withTimeout(
        getRoundState({
          publicClient: arcPublicClient(),
          pool: POOL_ADDRESS,
          roundId,
        }),
        10_000,
        "chain getRoundState",
      );
    } catch (error) {
      if (!isRateLimit(error) || attempt >= 3) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 1500 * 2 ** attempt),
      );
      attempt += 1;
    }
  }
}

/**
 * Live round snapshot, chain-first with a legacy fallback.
 * v2 pools expose currentRoundId/getRoundState; a v1 pool (like the settled
 * 0xC6f9… deployment) reverts those calls, so the legacy pool-state read is
 * mapped onto round 0 with a zero deadline instead of erroring. When both
 * fail the zeroed fallback keeps the dashboard renderable with a note.
 */
export async function readCurrentRound(): Promise<RoundReadout> {
  try {
    const roundId = await withTimeout(
      readChainRoundId(),
      30_000,
      "chain getCurrentRoundId",
    );
    const state = await withTimeout(
      readChainRoundState(roundId),
      30_000,
      "chain getRoundState",
    );
    return { view: toRoundView(roundId, state), source: "chain" };
  } catch (error) {
    const note = `round read failed: ${errorMessage(error)}`;
    try {
      const legacy = await readPoolState();
      return {
        view: {
          roundId: "0",
          target: legacy.view.target,
          totalCommitted: legacy.view.totalCommitted,
          settled: legacy.view.settled,
          expired: legacy.view.expired,
          deadline: "0",
          participantCount: legacy.view.participantCount,
        },
        source: "legacy",
        note: [note, legacy.note].filter((part) => part !== undefined).join("; "),
      };
    } catch (legacyError) {
      return {
        view: ZERO_ROUND,
        source: "fallback",
        note: `${note}; legacy read failed: ${errorMessage(legacyError)}`,
      };
    }
  }
}

/**
 * One wallet's committed amount in a round. Null when the chain read
 * fails — callers treat null as unknown and fund as before, so a
 * throttled RPC can never block funding, only skip the dedupe guard.
 */
export async function readCommitted(
  roundId: bigint,
  wallet: Address,
): Promise<bigint | null> {
  try {
    return await withTimeout(
      getCommitted({
        publicClient: arcPublicClient(),
        pool: POOL_ADDRESS,
        roundId,
        wallet,
      }),
      10_000,
      "chain getCommitted",
    );
  } catch {
    return null;
  }
}

/**
 * Round history walking back from the live round id, newest first.
 * Stops at genesis (round 0) and at `limit` entries; per-round gaps are
 * skipped so one unreadable round cannot hide the older ones. v1 pools
 * (no currentRoundId) yield an empty history — that is pool state, not
 * an error.
 */
export async function readRoundHistory(
  limit: number = ROUND_HISTORY_LIMIT,
): Promise<readonly RoundView[]> {
  let current: bigint;
  try {
    current = await withTimeout(
      readChainRoundId(),
      30_000,
      "chain getCurrentRoundId (history)",
    );
  } catch {
    return [];
  }
  const history: RoundView[] = [];
  for (
    let roundId = current;
    roundId > 0n && history.length < limit;
    roundId = roundId - 1n
  ) {
    try {
      const state = await withTimeout(
        readChainRoundState(roundId),
        15_000,
        `chain getRoundState(${roundId.toString()})`,
      );
      history.push(toRoundView(roundId, state));
    } catch {
      // Gap tolerance: an unreadable round is skipped so older rounds
      // still reach the history table.
      continue;
    }
  }
  return history;
}

/** Orchestrator base URL: server env wins, public env is the dev default. */
export function orchestratorBaseUrl(): string {
  const server = process.env["ORCHESTRATOR_URL"];
  if (server !== undefined && server !== "") return server;
  const pub = process.env["NEXT_PUBLIC_ORCHESTRATOR_URL"];
  if (pub !== undefined && pub !== "") return pub;
  return "http://localhost:8080";
}

/** Range cap of the public Arc RPC: log scans run in chunks this size. */
const LOG_CHUNK_BLOCKS = 10_000n;

/** Pause between log chunks so the burst stays under the public RPC throttle. */
const LOG_CHUNK_SPACING_MS = 400;

/** Events the activity feed reads: one getLogs call matches any topic. */
const POOL_ACTIVITY_EVENTS = resourcePoolAbi.filter(
  (entry) =>
    entry.type === "event" &&
    (entry.name === "Committed" ||
      entry.name === "Settled" ||
      entry.name === "RoundStarted"),
);

function isRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /rate limit|exceeds defined limit|too many requests|429/i.test(
    message,
  );
}

type ActivityClient = ReturnType<typeof arcPublicClient>;

/**
 * One log chunk with exponential-backoff retries: the public RPC throttles
 * bursts (the dashboard fires pool-state, resolution, and activity reads
 * together), so a throttled attempt waits 1.5s / 3s / 6s before retrying.
 */
async function getActivityChunk(
  client: ActivityClient,
  from: bigint,
  to: bigint,
  attempt = 0,
) {
  try {
    const logs = await withTimeout(
      client.getLogs({
        address: POOL_ADDRESS,
        events: POOL_ACTIVITY_EVENTS,
        fromBlock: from,
        toBlock: to,
      }),
      15_000,
      "chain getLogs (activity)",
    );
    return parseEventLogs({ abi: resourcePoolAbi, logs });
  } catch (error) {
    if (isRateLimit(error) && attempt < 3) {
      await new Promise((resolve) =>
        setTimeout(resolve, 1500 * 2 ** attempt),
      );
      return getActivityChunk(client, from, to, attempt + 1);
    }
    throw error;
  }
}

/**
 * Pool funding events, newest first. `Committed` + `Settled` + `RoundStarted`
 * reads run in 10k-block chunks from the pool deploy block because the public
 * Arc RPC rejects wider ranges. v2 overloads carry an indexed roundId which
 * is tagged onto each event; v1 legs omit it. An empty array is a valid
 * pre-fill state, not an error — the UI renders "awaiting first commit".
 */
export async function readActivity(): Promise<readonly ActivityEvent[]> {
  const client = arcPublicClient();
  const latest = await withTimeout(
    client.getBlockNumber(),
    10_000,
    "chain getBlockNumber",
  );
  const events: ActivityEvent[] = [];
  let firstChunk = true;
  for (
    let cursor = POOL_DEPLOY_BLOCK;
    cursor <= latest;
    cursor = cursor + LOG_CHUNK_BLOCKS + 1n
  ) {
    if (!firstChunk) {
      await new Promise((resolve) => setTimeout(resolve, LOG_CHUNK_SPACING_MS));
    }
    firstChunk = false;
    const end =
      cursor + LOG_CHUNK_BLOCKS > latest ? latest : cursor + LOG_CHUNK_BLOCKS;
    const parsed = await getActivityChunk(client, cursor, end);
    for (const log of parsed) {
      if (log.eventName === "Committed") {
        const roundId =
          "roundId" in log.args ? log.args.roundId.toString() : undefined;
        events.push({
          kind: "committed",
          agent: log.args.agent,
          amountAtomic: log.args.amount.toString(),
          ...(roundId === undefined ? {} : { roundId }),
          blockNumber: log.blockNumber.toString(),
          txHash: log.transactionHash,
        });
      } else if (log.eventName === "Settled") {
        const roundId =
          "roundId" in log.args ? log.args.roundId.toString() : undefined;
        events.push({
          kind: "settled",
          totalAtomic: log.args.total.toString(),
          ...(roundId === undefined ? {} : { roundId }),
          blockNumber: log.blockNumber.toString(),
          txHash: log.transactionHash,
        });
      } else if (log.eventName === "RoundStarted") {
        events.push({
          kind: "round-started",
          roundId: log.args.roundId.toString(),
          targetAtomic: log.args.target.toString(),
          deadline: log.args.deadline.toString(),
          blockNumber: log.blockNumber.toString(),
          txHash: log.transactionHash,
        });
      }
    }
    if (end === latest) break;
  }
  const byTx = new Map<string, ActivityEvent>();
  for (const event of events) {
    const key = `${event.blockNumber}-${event.txHash}-${event.kind}`;
    const prev = byTx.get(key);
    if (prev === undefined || (prev.roundId === undefined && event.roundId !== undefined)) {
      byTx.set(key, event);
    }
  }
  return [...byTx.values()].reverse();
}
