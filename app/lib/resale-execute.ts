import { erc20Abi } from "viem";
import { RESALE_USDC_ADDRESS } from "./constants";
import { arcPublicClient } from "./chain";
import { log } from "./logger";
import { orchestratorBaseUrl } from "./pool-state";
import { createCircleClient, executeContractAndWait } from "./circle-fund";
import {
  MULTICALL3_ADDRESS,
  buildSettlementCalls,
  readBuyerEnv,
  type FillPlanResponse,
  type FillPlanWant,
} from "./resale";

/**
 * Agent-5 atomic buyer execution, extracted verbatim from
 * POST /api/resale/buy: one USDC approve to Multicall3, one atomic
 * aggregate of transferFrom payouts, then orchestrator /commit-mint
 * against that settlement transaction, plus a best-effort provision.
 */

export type ResaleBuyResult = {
  readonly ok: true;
  readonly buyer: string;
  readonly legsPaid: number;
  readonly totalAtomic: string;
  readonly to: unknown;
  readonly toToken?: string;
};

/** Failure of one execution step; status mirrors the buy route's mapping. */
export class ResaleBuyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ResaleBuyError";
    this.status = status;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Operator app key for /commit-mint; server-only, never logged. */
export function readAppKey(): string | undefined {
  const key = process.env["ORCHESTRATOR_APP_KEY"] ?? process.env["APP_KEY"];
  return key !== undefined && key !== "" ? key : undefined;
}

/**
 * Execute a fill plan: approve → Multicall3 aggregate → /commit-mint →
 * optional provision. Returns the same success payload the buy route
 * sends; every failure path throws ResaleBuyError with the route's
 * original status and message.
 */
export async function executeResaleBuy(
  plan: FillPlanResponse,
  want: FillPlanWant,
): Promise<ResaleBuyResult> {
  const env = readBuyerEnv();
  if (!env.ok) {
    throw new ResaleBuyError(503, env.error);
  }
  const key = readAppKey();
  if (key === undefined) {
    throw new ResaleBuyError(
      503,
      "Missing ORCHESTRATOR_APP_KEY (server-only).",
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
      throw new ResaleBuyError(502, "buyer USDC balance below plan total");
    }
  } catch (readError) {
    if (readError instanceof ResaleBuyError) throw readError;
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
    throw new ResaleBuyError(502, `approve failed: ${approve.error}`);
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
    throw new ResaleBuyError(502, `settlement failed: ${aggregate.error}`);
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
    throw new ResaleBuyError(
      502,
      `commit-mint unreachable: ${errorMessage(error)}`,
    );
  }
  const payload = (await upstream.json().catch(() => null)) as unknown;
  if (!upstream.ok) {
    const detail =
      isRecord(payload) && typeof payload["message"] === "string"
        ? payload["message"]
        : `commit-mint returned ${String(upstream.status)}`;
    log("warn", "resale.buy.commit_failed", {
      route: "POST /api/resale/buy",
      status: upstream.status,
    });
    throw new ResaleBuyError(502, String(detail));
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
  return {
    ok: true,
    buyer: env.buyerAddress,
    legsPaid: plan.outputs.length,
    totalAtomic: plan.totalAtomic,
    to,
    ...(toToken === null ? {} : { toToken }),
  };
}
