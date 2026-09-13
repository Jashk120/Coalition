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

function isCapacityHeadroom(value: unknown): value is {
  readonly headroomMB: number;
  readonly headroomCUMicro: number;
} {
  if (!isRecord(value)) return false;
  const mb = value["headroomMB"];
  const cu = value["headroomCUMicro"];
  return (
    typeof mb === "number" &&
    Number.isInteger(mb) &&
    mb >= 0 &&
    typeof cu === "number" &&
    Number.isInteger(cu) &&
    cu >= 0
  );
}

/**
 * Best-effort headroom read from orchestrator GET /capacity (public, no
 * app key). Null when the fetch fails or the shape is bad — callers omit
 * the capacity field instead of breaking the error response.
 */
async function readCapacityHeadroom(): Promise<{
  readonly headroomMB: number;
  readonly headroomCUMicro: number;
} | null> {
  try {
    const response = await fetch(`${orchestratorBaseUrl()}/capacity`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`capacity returned ${String(response.status)}`);
    }
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!isRecord(payload) || !isRecord(payload["headroom"])) {
      throw new Error("capacity shape malformed");
    }
    const headroom = payload["headroom"];
    if (!isCapacityHeadroom(headroom)) {
      throw new Error("capacity headroom malformed");
    }
    return {
      headroomMB: headroom.headroomMB,
      headroomCUMicro: headroom.headroomCUMicro,
    };
  } catch (error) {
    log("warn", "resale.plan.capacity_degraded", {
      route: "POST /api/resale/plan",
      error: errorMessage(error),
    });
    return null;
  }
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
    const status =
      upstream.status === 400 ? 400 : upstream.status === 409 ? 409 : 502;
    if (upstream.status === 409) {
      const capacity = await readCapacityHeadroom();
      return NextResponse.json(
        {
          ok: false,
          error: detail,
          ...(capacity === null ? {} : { capacity }),
          ...(want === null ? {} : { want }),
        },
        { status },
      );
    }
    return NextResponse.json({ ok: false, error: detail }, { status });
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
