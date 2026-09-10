import { NextResponse } from "next/server";
import { log } from "@/lib/logger";
import { orchestratorBaseUrl } from "@/lib/pool-state";
import { parseFillPlan } from "@/lib/resale";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * POST /api/resale/plan {wallet, cu, mem} — relay to the orchestrator
 * POST /fill-plan and validate the atomic-settlement shape
 * {outputs:[{account,amountAtomic}], totalAtomic, nonce, roundId,
 * headroomMB, headroomCUMicro}. No auth, no payment — planning is free.
 * The response echoes the requested mint dimensions as plan.want so
 * POST /api/resale/buy can commit the exact slice that was previewed.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = (await request.json()) as unknown;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  let want: { readonly mem: number; readonly cuMicro: number } | null = null;
  if (isRecord(body)) {
    const mem = body["mem"];
    const cu = body["cu"];
    if (
      typeof mem === "number" &&
      Number.isInteger(mem) &&
      mem >= 0 &&
      typeof cu === "number" &&
      Number.isFinite(cu) &&
      cu >= 0 &&
      (mem > 0 || cu > 0)
    ) {
      want = { mem, cuMicro: Math.round(cu * 1e6) };
    }
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${orchestratorBaseUrl()}/fill-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    log("warn", "resale.plan.unreachable", {
      route: "POST /api/resale/plan",
      error: errorMessage(error),
    });
    return NextResponse.json(
      { ok: false, error: `fill-plan unreachable: ${errorMessage(error)}` },
      { status: 502 },
    );
  }
  const payload = (await upstream.json().catch(() => null)) as unknown;
  if (!upstream.ok) {
    const detail =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `fill-plan returned ${String(upstream.status)}`;
    return NextResponse.json(
      { ok: false, error: detail },
      { status: upstream.status === 400 ? 400 : 502 },
    );
  }
  try {
    const plan = parseFillPlan(payload);
    return NextResponse.json({
      ok: true,
      plan: want === null ? plan : { ...plan, want },
    });
  } catch (error) {
    log("warn", "resale.plan.bad_shape", {
      route: "POST /api/resale/plan",
      error: errorMessage(error),
    });
    return NextResponse.json(
      { ok: false, error: `fill-plan returned an unexpected shape: ${errorMessage(error)}` },
      { status: 502 },
    );
  }
}
