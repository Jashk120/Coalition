import { NextResponse } from "next/server";
import { erc20Abi } from "viem";
import { RESALE_NETWORK, RESALE_USDC_ADDRESS } from "@/lib/constants";
import { arcPublicClient } from "@/lib/chain";
import { log } from "@/lib/logger";
import { orchestratorBaseUrl } from "@/lib/pool-state";
import {
  createBuyerAccount,
  createBuyerPayClient,
  legToTransferLeg,
  parseAutofundCapAtomic,
  parseFillPlan,
  payQuotaLeg,
  readBuyerEnv,
  topUpGateway,
  type TransferQuotaLeg,
  type TransferQuotaPayment,
} from "@/lib/resale";

export const dynamic = "force-dynamic";
// Gateway verify+settle plus facilitator checks run per leg: allow a long
// serverless window so a multi-leg plan never dies mid-flow.
export const maxDuration = 300;

// Capped one-shot Gateway auto-top-up (server-only
// CIRCLE_BUYER_AUTOFUND_MAX, decimal USDC e.g. "10.00"; absent/empty/invalid
// = OFF, buys fail exactly as before): when a leg fails ONLY with a
// facilitator /insufficient_balance/i error, the route deposits
// min(plan total + 1 USDC headroom, cap, wallet on-chain USDC) from the buyer
// wallet into its OWN Gateway balance once per buy and retries that leg
// once. No other error triggers it, never a second top-up per request.

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
  // Hard rule: at most one Gateway top-up per buy request (boolean, not a
  // counter) — a retried leg that still fails returns leg_failed, never
  // re-enters the top-up path.
  let gatewayToppedUp = false;
  const autofundCap = parseAutofundCapAtomic(
    process.env["CIRCLE_BUYER_AUTOFUND_MAX"],
  );
  const AUTOFUND_HEADROOM_ATOMIC = 1000000n;
  for (const leg of plan.sellers) {
    const transferLeg = legToTransferLeg(leg);
    const payArgs = {
      quotaUrl,
      seller: leg.wallet,
      mb: leg.mb,
      cu: transferLeg.cu,
      httpClient,
      preferredNetwork: RESALE_NETWORK,
    };
    let proof: { readonly amountAtomic: string; readonly settlementId: string };
    try {
      proof = await payQuotaLeg(payArgs);
    } catch (error) {
      const firstError = errorMessage(error);
      let recovered: {
        readonly amountAtomic: string;
        readonly settlementId: string;
      } | null = null;
      let finalError = firstError;
      if (
        !gatewayToppedUp &&
        autofundCap !== null &&
        /insufficient_balance/i.test(firstError)
      ) {
        gatewayToppedUp = true;
        let walletBalance: bigint | null = null;
        try {
          walletBalance = await arcPublicClient().readContract({
            address: RESALE_USDC_ADDRESS,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [env.buyerAddress],
          });
        } catch (readError) {
          log("warn", "resale.buy.autofund_balance_failed", {
            route: "POST /api/resale/buy",
            error: errorMessage(readError),
          });
        }
        const required = BigInt(plan.totalAtomic) + AUTOFUND_HEADROOM_ATOMIC;
        if (walletBalance !== null && walletBalance >= required) {
          const candidates = [required, autofundCap, walletBalance];
          let topUp = candidates[0] ?? 0n;
          for (const candidate of candidates) {
            if (candidate < topUp) topUp = candidate;
          }
          if (topUp > 0n) {
            const topped = await topUpGateway({
              apiKey: env.apiKey,
              entitySecret: env.entitySecret,
              buyerWalletId: env.buyerWalletId,
              amountAtomic: topUp.toString(),
            });
            if (!topped.ok) {
              log("warn", "resale.buy.autofund_failed", {
                route: "POST /api/resale/buy",
                seller: leg.wallet,
                error: topped.error,
              });
            } else {
              log("info", "resale.buy.autofunded", {
                route: "POST /api/resale/buy",
                seller: leg.wallet,
              });
              try {
                recovered = await payQuotaLeg(payArgs);
              } catch (retryError) {
                finalError = errorMessage(retryError);
              }
            }
          }
        }
      }
      if (recovered === null) {
        log("warn", "resale.buy.leg_failed", {
          route: "POST /api/resale/buy",
          seller: leg.wallet,
          legsPaid: payments.length,
          legsTotal: plan.sellers.length,
          paidLegs: JSON.stringify(payments),
          error: finalError,
        });
        return NextResponse.json(
          {
            ok: false,
            error: `leg ${legs.length + 1}/${String(plan.sellers.length)} (${leg.wallet}) unpaid: ${finalError}`,
            legsPaid: payments.length,
            paidLegs: payments,
          },
          { status: 502 },
        );
      }
      proof = recovered;
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
