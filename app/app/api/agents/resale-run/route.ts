import { NextResponse } from "next/server";
import { createGraphClient, getPoolHealth } from "@jx-nexus/coalition";
import { OUTSIDE_BUYER, POOL_ADDRESS } from "@/lib/constants";
import { log } from "@/lib/logger";
import { orchestratorBaseUrl } from "@/lib/pool-state";
import { parseFillPlan } from "@/lib/resale";
import { ResaleBuyError, executeResaleBuy } from "@/lib/resale-execute";
import {
  decideResaleBuy,
  type ResaleCapacityHeadroom,
  type ResaleHealthCounts,
} from "@/lib/resale-decision";

export const dynamic = "force-dynamic";
// A live buy runs the full approve → aggregate → commit-mint flow, each
// polled to a terminal state — same long window as POST /api/resale/buy.
export const maxDuration = 300;

const DEFAULT_MEM = 200;
const DEFAULT_CU = 0.05;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Gate key: RESALE_RUN_KEY, falling back to ORCHESTRATOR_APP_KEY. Never logged. */
function runKey(): string | undefined {
  const key =
    process.env["RESALE_RUN_KEY"] ?? process.env["ORCHESTRATOR_APP_KEY"];
  return key !== undefined && key !== "" ? key : undefined;
}

/** Length-leak-free comparison so the gate is not trivially timable. */
function keysEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isCapacityHeadroom(value: unknown): value is ResaleCapacityHeadroom {
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
 * POST /api/agents/resale-run {mem?, cu?, dryRun?} — autonomous agent-5
 * resale path. Gated by X-Resale-Run-Key, dry-run by default (no USDC
 * moves unless dryRun:false). Reasons over orchestrator remaining
 * capacity plus subgraph pool health, then optionally executes the
 * fill-plan → approve → aggregate → commit-mint buy headlessly.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const configured = runKey();
  const presented = request.headers.get("x-resale-run-key") ?? "";
  if (configured === undefined || !keysEqual(presented, configured)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = (await request.json()) as unknown;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const rawMem = body["mem"] ?? DEFAULT_MEM;
  const rawCu = body["cu"] ?? DEFAULT_CU;
  const rawDryRun = body["dryRun"] ?? true;
  if (
    typeof rawMem !== "number" ||
    !Number.isInteger(rawMem) ||
    rawMem < 0 ||
    typeof rawCu !== "number" ||
    !Number.isFinite(rawCu) ||
    rawCu < 0 ||
    typeof rawDryRun !== "boolean"
  ) {
    return NextResponse.json(
      { ok: false, error: "body needs {mem?: int >= 0, cu?: number >= 0, dryRun?: boolean}" },
      { status: 400 },
    );
  }
  const mem: number = rawMem;
  const cu: number = rawCu;
  const dryRun: boolean = rawDryRun;
  const cuMicro = Math.round(cu * 1e6);

  // Capacity is advisory: when the orchestrator has no /capacity yet the
  // run degrades and the subgraph health decides alone.
  let capacity: ResaleCapacityHeadroom | null = null;
  let capacityNote: string | null = null;
  try {
    const upstream = await fetch(`${orchestratorBaseUrl()}/capacity`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok) {
      throw new Error(`capacity returned ${String(upstream.status)}`);
    }
    const payload = (await upstream.json().catch(() => null)) as unknown;
    if (!isRecord(payload) || !isRecord(payload["headroom"])) {
      throw new Error("capacity shape malformed");
    }
    if (!isCapacityHeadroom(payload["headroom"])) {
      throw new Error("capacity headroom malformed");
    }
    capacity = {
      headroomMB: payload["headroom"]["headroomMB"],
      headroomCUMicro: payload["headroom"]["headroomCUMicro"],
    };
  } catch (error) {
    capacityNote = `capacity degraded: ${errorMessage(error)}`;
  }

  // Subgraph health is load-bearing: unset endpoint or a failed query
  // fails the decision closed to skip.
  let health: ResaleHealthCounts | null = null;
  let subgraphError: string | null = null;
  const endpoint = process.env["SUBGRAPH_ENDPOINT"];
  if (endpoint === undefined || endpoint === "") {
    subgraphError = "SUBGRAPH_ENDPOINT is not configured";
  } else {
    try {
      const apiKey = process.env["SUBGRAPH_API_KEY"];
      const client = createGraphClient({
        endpoint,
        ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }),
      });
      const pool = await getPoolHealth(client, POOL_ADDRESS);
      health = {
        settled: pool.settled,
        participantCount: Number(pool.participantCount),
        forfeitedTotalAtomic: pool.forfeitedTotal.toString(),
        dropoutCount: pool.dropoutCount,
      };
    } catch (error) {
      subgraphError = errorMessage(error);
    }
  }

  const decision = decideResaleBuy({
    want: { mem, cuMicro },
    capacity,
    health,
    subgraphError,
  });

  const baseLog = {
    route: "POST /api/agents/resale-run",
    action: decision.action,
    dryRun,
    mem,
    cuMicro,
    settled: health?.settled ?? null,
    participantCount: health?.participantCount ?? null,
    dropoutCount: health?.dropoutCount ?? null,
    headroomMB: capacity?.headroomMB ?? null,
    headroomCUMicro: capacity?.headroomCUMicro ?? null,
    capacityDegraded: capacityNote !== null,
    ...(capacityNote === null ? {} : { capacityNote }),
    ...(subgraphError === null ? {} : { subgraphError }),
  };
  if (dryRun || decision.action === "skip") {
    log("info", "agents.resale-run", baseLog);
    return NextResponse.json({
      ok: true,
      action: decision.action,
      reason: decision.reason,
      trace: decision.trace,
    });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${orchestratorBaseUrl()}/fill-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: OUTSIDE_BUYER.wallet, mem, cu }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    log("warn", "agents.resale-run.fill_unreachable", {
      ...baseLog,
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
      isRecord(payload) && typeof payload["error"] === "string"
        ? payload["error"]
        : `fill-plan returned ${String(upstream.status)}`;
    return NextResponse.json(
      { ok: false, error: String(detail) },
      { status: upstream.status === 400 ? 400 : 502 },
    );
  }
  let plan;
  try {
    plan = parseFillPlan(payload);
  } catch (error) {
    log("warn", "agents.resale-run.bad_plan", {
      ...baseLog,
      error: errorMessage(error),
    });
    return NextResponse.json(
      { ok: false, error: `fill-plan returned an unexpected shape: ${errorMessage(error)}` },
      { status: 502 },
    );
  }

  try {
    const buy = await executeResaleBuy(plan, { mem, cuMicro });
    log("info", "agents.resale-run", {
      ...baseLog,
      legsPaid: buy.legsPaid,
      totalAtomic: buy.totalAtomic,
    });
    return NextResponse.json({
      ok: true,
      action: decision.action,
      reason: decision.reason,
      trace: decision.trace,
      plan: { ...plan, want: { mem, cuMicro } },
      buy,
    });
  } catch (error) {
    if (error instanceof ResaleBuyError) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { ok: false, error: `buy failed: ${errorMessage(error)}` },
      { status: 502 },
    );
  }
}
