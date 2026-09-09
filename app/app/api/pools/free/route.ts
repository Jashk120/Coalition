import { NextResponse } from "next/server";
import { log } from "@/lib/logger";
import { orchestratorBaseUrl } from "@/lib/pool-state";
import type { FreePoolResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Server-side app key only — never a NEXT_PUBLIC_ value. */
function appKey(): string | undefined {
  const key =
    process.env["ORCHESTRATOR_APP_KEY"] ?? process.env["APP_KEY"];
  return key !== undefined && key !== "" ? key : undefined;
}

function extractFreed(payload: unknown): unknown {
  if (typeof payload === "object" && payload !== null && "freed" in payload) {
    return payload.freed;
  }
  return payload;
}

function upstreamDetail(payload: unknown): string {
  if (typeof payload === "object" && payload !== null) {
    if ("error" in payload && typeof payload.error === "string") {
      return `: ${payload.error}`;
    }
    if ("message" in payload && typeof payload.message === "string") {
      return `: ${payload.message}`;
    }
  }
  return "";
}

/**
 * POST /api/pools/free — relay to orchestrator POST /free-pool so judges can
 * reset containers and reuse the same pool for the next test.
 * Defensive about the upstream shape: any 2xx returns { ok: true, freed };
 * anything else (including 404 while the backend endpoint is still being
 * aligned) surfaces the status so the mismatch is visible, never silent.
 */
export async function POST(): Promise<NextResponse<FreePoolResponse>> {
  const base = orchestratorBaseUrl();
  const key = appKey();

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/free-pool`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key === undefined
          ? {}
          : { authorization: `Bearer ${key}`, "x-app-key": key }),
      },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    log("warn", "pools.free.unreachable", {
      route: "POST /api/pools/free",
      error: errorMessage(error),
    });
    return NextResponse.json(
      {
        ok: false,
        error: `orchestrator unreachable at ${base}: ${errorMessage(error)}`,
      },
      { status: 502 },
    );
  }

  let payload: unknown = null;
  try {
    payload = (await upstream.json()) as unknown;
  } catch {
    payload = null;
  }

  if (!upstream.ok) {
    log("warn", "pools.free.bad_upstream", {
      route: "POST /api/pools/free",
      status: upstream.status,
    });
    return NextResponse.json(
      {
        ok: false,
        error:
          `orchestrator POST /free-pool returned ${String(upstream.status)}` +
          `${upstreamDetail(payload)} — backend task must align the endpoint shape`,
      },
      { status: 502 },
    );
  }

  const freed = extractFreed(payload);
  log("info", "pools.free.complete", { route: "POST /api/pools/free" });
  return NextResponse.json({ ok: true, freed });
}
