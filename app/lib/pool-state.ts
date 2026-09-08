import {
  createGraphClient,
  getPoolFill,
  getPoolState,
} from "@jx-nexus/coalition";
import { TARGET_ATOMIC } from "./constants";
import { POOL_ADDRESS } from "./constants";
import { arcPublicClient } from "./chain";
import type { PoolStateView } from "./types";

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
