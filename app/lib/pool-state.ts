import { parseEventLogs } from "viem";
import {
  createGraphClient,
  getPoolFill,
  getPoolState,
  resourcePoolAbi,
} from "@jx-nexus/coalition";
import { TARGET_ATOMIC } from "./constants";
import { POOL_ADDRESS, POOL_DEPLOY_BLOCK } from "./constants";
import { arcPublicClient } from "./chain";
import type { ActivityEvent, PoolStateView } from "./types";

export type PoolReadout = {
  readonly view: PoolStateView;
  readonly source: "subgraph" | "chain" | "fallback";
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
          getPoolState({ publicClient: arcPublicClient(), pool: POOL_ADDRESS }),
          10_000,
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
      getPoolState({ publicClient: arcPublicClient(), pool: POOL_ADDRESS }),
      10_000,
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

/** Events the activity feed reads: one getLogs call matches either topic. */
const POOL_ACTIVITY_EVENTS = resourcePoolAbi.filter(
  (entry) =>
    entry.type === "event" &&
    (entry.name === "Committed" || entry.name === "Settled"),
);

function isRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /rate limit|exceeds defined limit|too many requests|429/i.test(
    message,
  );
}

type ActivityClient = ReturnType<typeof arcPublicClient>;

/**
 * One log chunk with a single retry: the public RPC throttles bursts (the
 * dashboard fires pool-state, resolution, and activity reads together), so
 * a throttled first attempt waits 1.5s and tries once more before failing.
 */
async function getActivityChunk(
  client: ActivityClient,
  from: bigint,
  to: bigint,
  retried = false,
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
    if (!retried && isRateLimit(error)) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return getActivityChunk(client, from, to, true);
    }
    throw error;
  }
}

/**
 * Pool funding events, newest first. `Committed` + `Settled` reads run in
 * 10k-block chunks from the pool deploy block because the public Arc RPC
 * rejects wider ranges. An empty array is a valid pre-fill state, not an
 * error — the UI renders "awaiting first commit".
 */
export async function readActivity(): Promise<readonly ActivityEvent[]> {
  const client = arcPublicClient();
  const latest = await withTimeout(
    client.getBlockNumber(),
    10_000,
    "chain getBlockNumber",
  );
  const events: ActivityEvent[] = [];
  for (
    let cursor = POOL_DEPLOY_BLOCK;
    cursor <= latest;
    cursor = cursor + LOG_CHUNK_BLOCKS + 1n
  ) {
    const end =
      cursor + LOG_CHUNK_BLOCKS > latest ? latest : cursor + LOG_CHUNK_BLOCKS;
    const parsed = await getActivityChunk(client, cursor, end);
    for (const log of parsed) {
      if (log.eventName === "Committed") {
        events.push({
          kind: "committed",
          agent: log.args.agent,
          amountAtomic: log.args.amount.toString(),
          blockNumber: log.blockNumber.toString(),
          txHash: log.transactionHash,
        });
      } else if (log.eventName === "Settled") {
        events.push({
          kind: "settled",
          totalAtomic: log.args.total.toString(),
          blockNumber: log.blockNumber.toString(),
          txHash: log.transactionHash,
        });
      }
    }
    if (end === latest) break;
  }
  return events.reverse();
}
