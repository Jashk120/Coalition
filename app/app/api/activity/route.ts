import { NextResponse } from "next/server";

import { POOL_ADDRESS } from "@/lib/constants";
import { log } from "@/lib/logger";
import { readActivity } from "@/lib/pool-state";
import type { ActivityEvent, ActivityResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Short-lived cache: funding events change only when commits land. */
const CACHE_TTL_MS = 60_000;
let cache: { readonly at: number; readonly events: readonly ActivityEvent[] } | null =
  null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * GET /api/activity — pool funding events (Committed + Settled), newest
 * first. Empty before the first commit — that is pool state, not an error.
 */
export async function GET(): Promise<NextResponse<ActivityResponse>> {
  const startedCached = cache !== null && Date.now() - cache.at < CACHE_TTL_MS;
  try {
    if (cache === null || Date.now() - cache.at >= CACHE_TTL_MS) {
      const loaded = await readActivity();
      cache = { at: Date.now(), events: loaded };
    }
    const events = cache.events;
    log("info", "activity.read", {
      route: "GET /api/activity",
      events: events.length,
      cached: startedCached,
    });
    return NextResponse.json({ ok: true, pool: POOL_ADDRESS, events });
  } catch (error) {
    const message = errorMessage(error);
    if (cache !== null) {
      log("warn", "activity.unavailable", {
        route: "GET /api/activity",
        error: message,
        cached: true,
      });
      return NextResponse.json({
        ok: true,
        pool: POOL_ADDRESS,
        events: cache.events,
        note: "stale: activity unavailable",
      });
    }
    log("warn", "activity.unavailable", {
      route: "GET /api/activity",
      error: message,
    });
    return NextResponse.json(
      { ok: false, error: "activity unavailable" },
      { status: 502 },
    );
  }
}
