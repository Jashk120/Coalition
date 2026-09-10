import { NextResponse } from "next/server";
import { RESALE_NETWORK } from "@/lib/constants";
import { log } from "@/lib/logger";
import { orchestratorBaseUrl } from "@/lib/pool-state";
import {
  createBuyerAccount,
  createBuyerPayClient,
  legToTransferLeg,
  parseFillPlan,
  payQuotaLeg,
  readBuyerEnv,
  type TransferQuotaLeg,
  type TransferQuotaPayment,
} from "@/lib/resale";

export const dynamic = "force-dynamic";
// Gateway verify+settle plus facilitator checks run per leg: allow a long
// serverless window so a multi-leg plan never dies mid-flow.
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
 * POST /api/resale/buy {plan} — agent-5 Gateway buyer flow. Takes a fill
 * plan (previewed via /api/resale/plan), pays each leg sequentially through
 * the per-seller 402 route from the buyer's own Circle wallet (BatchEvmScheme
 * over the Circle EIP-1193 signer — no local key anywhere), collects
 * [{seller, amountAtomic, settlementId}] proofs, then POSTs the orchestrator
 * /transfer-quota with the server-side app key. Returns the buyer slice plus
 * a hasToken flag — the token itself stays server-side in spirit: it is
 * returned once for the buyer to run with and never logged.
 *
 * Quota commit is atomic; funds settle per-leg inline and can strand on
 * later-leg failure — see manifest. Every partial-pay failure below returns
 * the paid-legs manifest [{seller, amountAtomic, settlementId}] so stranded
 * funds stay reconcilable.
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

  const account = createBuyerAccount({
    apiKey: env.apiKey,
    entitySecret: env.entitySecret,
    buyerAddress: env.buyerAddress,
  });
  const { httpClient } = createBuyerPayClient(account);
  const quotaUrl = `${new URL(request.url).origin}/api/resale/quota`;

  // Sequential legs: each payment signature commits a fresh nonce + validity
  // window, and a failed leg aborts before later money moves.
  const legs: TransferQuotaLeg[] = [];
  const payments: TransferQuotaPayment[] = [];
  for (const leg of plan.sellers) {
    const transferLeg = legToTransferLeg(leg);
    let proof: { readonly amountAtomic: string; readonly settlementId: string };
    try {
      proof = await payQuotaLeg({
        quotaUrl,
        seller: leg.wallet,
        mb: leg.mb,
        cu: transferLeg.cu,
        httpClient,
        preferredNetwork: RESALE_NETWORK,
      });
    } catch (error) {
      log("warn", "resale.buy.leg_failed", {
        route: "POST /api/resale/buy",
        seller: leg.wallet,
        legsPaid: payments.length,
        legsTotal: plan.sellers.length,
        paidLegs: JSON.stringify(payments),
        error: errorMessage(error),
      });
      return NextResponse.json(
        {
          ok: false,
          error: `leg ${legs.length + 1}/${String(plan.sellers.length)} (${leg.wallet}) unpaid: ${errorMessage(error)}`,
          legsPaid: payments.length,
          paidLegs: payments,
        },
        { status: 502 },
      );
    }
    // Source of truth is what the 402 route actually settled, not the
    // previewed plan: a quote that moved between plan and pay reprices the
    // leg, and the Go side checks paid >= cost at transfer time.
    if (proof.amountAtomic !== leg.amountAtomic) {
      log("info", "resale.buy.repriced", {
        route: "POST /api/resale/buy",
        seller: leg.wallet,
        planned: leg.amountAtomic,
        paid: proof.amountAtomic,
      });
    }
    legs.push(transferLeg);
    payments.push({
      seller: leg.wallet,
      amountAtomic: proof.amountAtomic,
      settlementId: proof.settlementId,
    });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${orchestratorBaseUrl()}/transfer-quota`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-app-key": key,
      },
      body: JSON.stringify({ to: env.buyerAddress, legs, payments }),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    log("warn", "resale.buy.unreachable", {
      route: "POST /api/resale/buy",
      error: errorMessage(error),
    });
    return NextResponse.json(
      { ok: false, error: `transfer-quota unreachable: ${errorMessage(error)}` },
      { status: 502 },
    );
  }
  const payload = (await upstream.json().catch(() => null)) as unknown;
  if (!upstream.ok) {
    const detail =
      isRecord(payload) && typeof payload["error"] === "string"
        ? payload["error"]
        : `transfer-quota returned ${String(upstream.status)}`;
    log("warn", "resale.buy.transfer_failed", {
      route: "POST /api/resale/buy",
      status: upstream.status,
      legsPaid: payments.length,
      paidLegs: JSON.stringify(payments),
    });
    return NextResponse.json(
      { ok: false, error: String(detail), legsPaid: payments.length, paidLegs: payments },
      { status: 502 },
    );
  }
  const toToken =
    isRecord(payload) && typeof payload["toToken"] === "string"
      ? payload["toToken"]
      : null;
  const to = isRecord(payload) ? payload["to"] : null;
  log("info", "resale.buy.complete", {
    route: "POST /api/resale/buy",
    legs: legs.length,
    hasToken: toToken !== null,
  });
  return NextResponse.json({
    ok: true,
    buyer: env.buyerAddress,
    legsPaid: payments.length,
    totalAtomic: plan.totalAtomic,
    to,
    ...(toToken === null ? {} : { toToken }),
  });
}
