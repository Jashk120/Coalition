import { NextResponse } from "next/server";
import type { Address } from "viem";
import {
  DEMO_SEED_AGENTS,
  resolveSeedAgents,
} from "@jx-nexus/coalition";
import { arcPublicClient, sepoliaPublicClient } from "@/lib/chain";
import { CHAIN_ID, IDENTITY_REGISTRY_FROM_BLOCK, OUTSIDE_BUYER, POOL_ADDRESS, ROUND_HISTORY_LIMIT, SEED_META } from "@/lib/constants";
import { log, logTimed } from "@/lib/logger";
import { readCurrentRound, readPoolState, readRoundHistory } from "@/lib/pool-state";
import type { AgentsResponse, ResolutionView } from "@/lib/types";

export const dynamic = "force-dynamic";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/** Seed identity changes rarely: cache briefly so reload bursts don't throttle the public RPC. */
const RESOLUTION_CACHE_TTL_MS = 300_000;
let resolutionCache: {
  readonly at: number;
  readonly resolutions: readonly ResolutionView[];
} | null = null;

function isRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /rate limit|exceeds defined limit|too many requests|429/i.test(message);
}

/** First-line-only failure reason: raw viem blobs would flood the UI. */
function shortReason(error: unknown): string {
  const first = errorMessage(error).split("\n")[0] ?? "unknown error";
  return first.length > 160 ? `${first.slice(0, 157)}...` : first;
}

/** Live resolution with backoff: a throttled attempt waits 1.5s/3s/6s before retrying. */
async function resolveWithRetry(
  reviewers: readonly Address[],
): Promise<readonly ResolutionView[]> {
  let attempt = 0;
  for (;;) {
    try {
      const live = await logTimed(
        "agents.resolve",
        { route: "GET /api/agents", agents: DEMO_SEED_AGENTS.length },
        () =>
          withTimeout(
            resolveSeedAgents({
              sepoliaClient: sepoliaPublicClient(),
              arcClient: arcPublicClient(),
              seeds: DEMO_SEED_AGENTS,
              reviewers,
              fromBlock: IDENTITY_REGISTRY_FROM_BLOCK,
            }),
            45_000,
            "resolveSeedAgents",
          ),
      );
      return live.map((entry): ResolutionView => {
        if (entry.status === "resolved") {
          return {
            seedId: entry.seed.id,
            status: "resolved",
            arcWallet: entry.arcWallet,
            agentCount: entry.agents.length,
          };
        }
        return {
          seedId: entry.seed.id,
          status: "unresolved",
          reason: entry.reason,
        };
      });
    } catch (error) {
      if (!isRateLimit(error) || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** attempt));
      attempt += 1;
    }
  }
}

/**
 * GET /api/agents — live seed resolution plus pool funding state.
 * ENS-first `resolveSeedAgents` in seed order; any network failure degrades
 * to per-seed `skipped` entries with reasons (never an exception to the UI).
 * Pool state is subgraph-first with a chain fallback (see lib/pool-state.ts).
 */
export async function GET(): Promise<NextResponse<AgentsResponse>> {
  const provider = process.env["PROVIDER_ADDRESS"];
  const seedWallets = DEMO_SEED_AGENTS.map((seed) => seed.wallet);
  const reviewers: readonly Address[] =
    provider !== undefined && ADDRESS_PATTERN.test(provider)
      ? [provider as Address, ...seedWallets]
      : [...seedWallets];

  let resolutions: readonly ResolutionView[];
  const servedCached =
    resolutionCache !== null &&
    Date.now() - resolutionCache.at < RESOLUTION_CACHE_TTL_MS;
  if (servedCached && resolutionCache !== null) {
    resolutions = resolutionCache.resolutions;
  } else {
    try {
      resolutions = await resolveWithRetry(reviewers);
      resolutionCache = { at: Date.now(), resolutions };
    } catch (error) {
      const reason = `live ENS resolution unavailable (${shortReason(error)}); agents cannot join or fund until it recovers`;
      log("warn", "agents.resolve.unavailable", {
        route: "GET /api/agents",
        reason,
      });
      resolutions = SEED_META.map(
        (seed): ResolutionView => ({
          seedId: seed.id,
          status: "unresolved",
          reason,
        }),
      );
    }
  }

  const pool = await readPoolState();
  const round = await readCurrentRound();
  const history = await readRoundHistory(ROUND_HISTORY_LIMIT);
  const resolved = resolutions.filter((r) => r.status === "resolved").length;
  log("info", "agents.read", {
    route: "GET /api/agents",
    resolved,
    skipped: resolutions.length - resolved,
    cached: servedCached,
    poolSource: pool.source,
    roundId: round.view.roundId,
    roundSource: round.source,
    history: history.length,
    ...(pool.note === undefined ? {} : { note: pool.note }),
    ...(round.note === undefined ? {} : { roundNote: round.note }),
  });

  return NextResponse.json({
    ok: true,
    pool: POOL_ADDRESS,
    chainId: CHAIN_ID,
    resolutions,
    poolState: pool.view,
    poolStateSource: pool.source,
    buyer: { wallet: OUTSIDE_BUYER.wallet, ensName: OUTSIDE_BUYER.ensName },
    round: round.view,
    roundId: round.view.roundId,
    deadline: round.view.deadline,
    history,
    ...(pool.note === undefined ? {} : { note: pool.note }),
  });
}
