import { NextResponse } from "next/server";

import { POOL_ADDRESS } from "@/lib/constants";
import { log } from "@/lib/logger";
import { readRoster } from "@/lib/pool-state";
import type { CommitmentView, DropoutView, RosterResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Short-lived cache: roster changes only when commits/dropouts land. */
const CACHE_TTL_MS = 60_000;
let cache: {
  readonly at: number;
  readonly commitments: readonly CommitmentView[];
  readonly dropouts: readonly DropoutView[];
} | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * GET /api/roster — live pool roster (commitments + dropouts), newest
 * source of truth for the demo share-of-pool table. Subgraph-or-bust:
 * no chain fallback for this data, so an unconfigured endpoint or a
 * failed query surfaces as an explicit error showing the Graph
 * dependency instead of silently degrading.
 */
export async function GET(): Promise<NextResponse<RosterResponse>> {
  const startedCached = cache !== null && Date.now() - cache.at < CACHE_TTL_MS;
  try {
    if (cache === null || Date.now() - cache.at >= CACHE_TTL_MS) {
      const loaded = await readRoster();
      cache = {
        at: Date.now(),
        commitments: loaded.commitments,
        dropouts: loaded.dropouts,
      };
    }
    const { commitments, dropouts } = cache;
    log("info", "roster.read", {
      route: "GET /api/roster",
      commitments: commitments.length,
      dropouts: dropouts.length,
      cached: startedCached,
    });
    return NextResponse.json({
      ok: true,
      pool: POOL_ADDRESS,
      source: "subgraph",
      commitments,
      dropouts,
    });
  } catch (error) {
    const message = errorMessage(error);
    log("warn", "roster.unavailable", {
      route: "GET /api/roster",
      error: message,
    });
    return NextResponse.json(
      { ok: false, error: `roster unavailable: ${message}` },
      { status: 502 },
    );
  }
}
