import { NextResponse } from "next/server";
import { erc20Abi } from "viem";
import { RESALE_USDC_ADDRESS } from "@/lib/constants";
import { arcPublicClient } from "@/lib/chain";
import { log } from "@/lib/logger";
import { orchestratorBaseUrl } from "@/lib/pool-state";
import { createCircleClient, executeContractAndWait } from "@/lib/circle-fund";
import {
  MULTICALL3_ADDRESS,
  buildSettlementCalls,
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

function appKey(): string | undefined {
  const key = process.env["ORCHESTRATOR_APP_KEY"] ?? process.env["APP_KEY"];
  return key !== undefined && key !== "" ? key : undefined;
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
  const key = appKey();
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

  const total = BigInt(plan.totalAtomic);
  try {
    const balance = await arcPublicClient().readContract({
      address: RESALE_USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [env.buyerAddress],
    });
    if (balance < total) {
      return NextResponse.json(
        { ok: false, error: "buyer USDC balance below plan total" },
        { status: 502 },
      );
    }
  } catch (readError) {
    log("warn", "resale.buy.balance_failed", {
      route: "POST /api/resale/buy",
      error: errorMessage(readError),
    });
  }

  const client = createCircleClient(env.apiKey, env.entitySecret);
  const approve = await executeContractAndWait(client, {
    walletId: env.buyerWalletId,
    contractAddress: RESALE_USDC_ADDRESS,
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters: [MULTICALL3_ADDRESS, plan.totalAtomic],
  });
  if (!approve.ok) {
    log("warn", "resale.buy.approve_failed", {
      route: "POST /api/resale/buy",
      error: approve.error,
    });
    return NextResponse.json(
      { ok: false, error: `approve failed: ${approve.error}` },
      { status: 502 },
    );
  }

  const calls = buildSettlementCalls({
    buyer: env.buyerAddress,
    outputs: plan.outputs,
  });
  // Circle's abiParameters entry is untyped at runtime, so the tuple array
  // encodes against "aggregate((address,bytes)[])" as one nested parameter.
  const aggregate = await executeContractAndWait(client, {
    walletId: env.buyerWalletId,
    contractAddress: MULTICALL3_ADDRESS,
    abiFunctionSignature: "aggregate((address,bytes)[])",
    abiParameters: [[...calls.map(([target, callData]) => [target, callData])]] as unknown as readonly string[],
  });
  if (!aggregate.ok) {
    log("warn", "resale.buy.settle_failed", {
      route: "POST /api/resale/buy",
      error: aggregate.error,
    });
    return NextResponse.json(
      { ok: false, error: `settlement failed: ${aggregate.error}` },
      { status: 502 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${orchestratorBaseUrl()}/commit-mint`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-app-key": key,
      },
      body: JSON.stringify({
        to: env.buyerAddress,
        mb: want.mem,
        cuMicro: want.cuMicro,
        settlementTxHash: aggregate.txHash,
        nonce: plan.nonce,
        roundId: plan.roundId,
        outputs: plan.outputs.map((output) => ({
          account: output.account,
          amountAtomic: output.amountAtomic,
        })),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    log("warn", "resale.buy.unreachable", {
      route: "POST /api/resale/buy",
      error: errorMessage(error),
    });
    return NextResponse.json(
      { ok: false, error: `commit-mint unreachable: ${errorMessage(error)}` },
      { status: 502 },
    );
  }
  const payload = (await upstream.json().catch(() => null)) as unknown;
  if (!upstream.ok) {
    const detail =
      isRecord(payload) && typeof payload["error"] === "string"
        ? payload["error"]
        : `commit-mint returned ${String(upstream.status)}`;
    log("warn", "resale.buy.commit_failed", {
      route: "POST /api/resale/buy",
      status: upstream.status,
    });
    return NextResponse.json(
      { ok: false, error: String(detail) },
      { status: 502 },
    );
  }
  const toToken =
    isRecord(payload) && typeof payload["toToken"] === "string"
      ? payload["toToken"]
      : null;
  const to = isRecord(payload) ? payload["to"] : null;
  if (toToken !== null) {
    try {
      const provision = await fetch(`${orchestratorBaseUrl()}/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${toToken}`,
        },
        body: JSON.stringify({ wallet: env.buyerAddress, cmd: ["echo", "hi"] }),
        cache: "no-store",
        signal: AbortSignal.timeout(60_000),
      });
      if (!provision.ok) {
        const detail = await provision.text().catch(() => "");
        const firstLine = detail.split("\n")[0];
        log("warn", "resale.buy.provision", {
          route: "POST /api/resale/buy",
          ok: false,
          error:
            firstLine !== undefined && firstLine !== ""
              ? firstLine
              : `provision returned ${String(provision.status)}`,
        });
      }
    } catch (error) {
      const firstLine = errorMessage(error).split("\n")[0];
      log("warn", "resale.buy.provision", {
        route: "POST /api/resale/buy",
        ok: false,
        error: firstLine ?? "provision failed",
      });
    }
  }
  log("info", "resale.buy.complete", {
    route: "POST /api/resale/buy",
    outputs: plan.outputs.length,
    hasToken: toToken !== null,
  });
  return NextResponse.json({
    ok: true,
    buyer: env.buyerAddress,
    legsPaid: plan.outputs.length,
    totalAtomic: plan.totalAtomic,
    to,
    ...(toToken === null ? {} : { toToken }),
  });
}
