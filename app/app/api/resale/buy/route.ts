import { NextResponse } from "next/server";
import { readAppKey, ResaleBuyError, executeResaleBuy } from "@/lib/resale-execute";
import {
  parseFillPlan,
  parsePlanWant,
  readBuyerEnv,
} from "@/lib/resale";

export const dynamic = "force-dynamic";
// One approve plus one aggregate execution, each polled to a terminal state:
// allow a long serverless window so settlement never dies mid-flow.
export const maxDuration = 300;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * POST /api/resale/buy {plan} — agent-5 atomic buyer flow. Takes a fill
 * plan (previewed via /api/resale/plan, outputs shape with the echoed want),
 * approves the plan total once for Multicall3 from the buyer's own Circle
 * wallet, executes a single aggregate of USDC transferFrom calls paying each
 * agent its exact fill-plan share, then commits buyer quota via the
 * orchestrator /commit-mint against that one settlement transaction.
 *
 * The aggregate is EVM-atomic: either every agent is paid or none is, so
 * partial-payment states are unrepresentable and there is no paid-legs
 * manifest. The execution txHash is the single settlement proof.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const env = readBuyerEnv();
  if (!env.ok) {
    return NextResponse.json({ ok: false, error: env.error }, { status: 503 });
  }
  const key = readAppKey();
  if (key === undefined) {
    return NextResponse.json(
      { ok: false, error: "Missing ORCHESTRATOR_APP_KEY (server-only)." },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = (await request.json()) as unknown;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  if (!isRecord(body) || !("plan" in body)) {
    return NextResponse.json(
      { ok: false, error: "body needs {plan} from POST /api/resale/plan" },
      { status: 400 },
    );
  }
  let plan;
  try {
    plan = parseFillPlan(body["plan"]);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: `malformed plan: ${errorMessage(error)}` },
      { status: 400 },
    );
  }
  let want;
  try {
    want = parsePlanWant(
      isRecord(body["plan"]) ? body["plan"]["want"] : undefined,
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: `plan carries no usable want: ${errorMessage(error)}` },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await executeResaleBuy(plan, want));
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
