import { NextResponse } from "next/server";
import type { Address } from "viem";
import {
  DEMO_SEED_AGENTS,
  resolveSeedAgents,
} from "@jx-nexus/coalition";
import { arcPublicClient, sepoliaPublicClient } from "@/lib/chain";
import { CHAIN_ID, OUTSIDE_BUYER, POOL_ADDRESS, SEED_META } from "@/lib/constants";
import { readPoolState } from "@/lib/pool-state";
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
  try {
    const live = await withTimeout(
      resolveSeedAgents({
        sepoliaClient: sepoliaPublicClient(),
        arcClient: arcPublicClient(),
        seeds: DEMO_SEED_AGENTS,
        reviewers,
      }),
      25_000,
      "resolveSeedAgents",
    );
    resolutions = live.map((entry): ResolutionView => {
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
        status: "skipped",
        reason: entry.reason,
        fallbackWallet: entry.fallbackWallet,
      };
    });
  } catch (error) {
    const reason = `live resolution unavailable (${errorMessage(error)}); showing seed fallbacks`;
    resolutions = SEED_META.map(
      (seed): ResolutionView => ({
        seedId: seed.id,
        status: "skipped",
        reason,
        fallbackWallet: seed.wallet,
      }),
    );
  }

  const pool = await readPoolState();

  return NextResponse.json({
    ok: true,
    pool: POOL_ADDRESS,
    chainId: CHAIN_ID,
    resolutions,
    poolState: pool.view,
    poolStateSource: pool.source,
    buyer: { wallet: OUTSIDE_BUYER.wallet, ensName: OUTSIDE_BUYER.ensName },
    ...(pool.note === undefined ? {} : { note: pool.note }),
  });
}
