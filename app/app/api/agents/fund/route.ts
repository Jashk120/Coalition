import { NextResponse } from "next/server";
import { fromAtomicUsdc, wouldExceedTarget } from "@jx-nexus/coalition";
import { POOL_ADDRESS, SHARE_ATOMIC } from "@/lib/constants";
import {
  USDC_ADDRESS,
  createCircleClient,
  executeContractAndWait,
  readCircleEnv,
} from "@/lib/circle-fund";
import { log } from "@/lib/logger";
import { readPoolState } from "@/lib/pool-state";
import type { FundResponse, FundStep } from "@/lib/types";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * POST /api/agents/fund — headless on-chain funding via Circle
 * Developer-Controlled Wallets. Each configured wallet runs SEQUENTIALLY:
 * live `readPoolState` gating (settled/expired/full skips) followed by a
 * USDC approve + pool commit through Circle, recording on-chain tx hashes.
 * Missing CIRCLE_* env yields 503 with a setup hint instead of crashing.
 */
export async function POST(): Promise<NextResponse<FundResponse>> {
  const env = readCircleEnv();
  if (!env.ok) {
    return NextResponse.json({ ok: false, error: env.error }, { status: 503 });
  }

  const started = Date.now();
  const client = createCircleClient(env.apiKey, env.entitySecret);
  const shareAmount = SHARE_ATOMIC.toString();
  log("info", "agents.fund.start", {
    route: "POST /api/agents/fund",
    wallets: env.walletIds.length,
    pool: POOL_ADDRESS,
  });

  try {
    const steps: FundStep[] = [];
    for (const walletId of env.walletIds) {
      try {
        const pool = await readPoolState();
        const target: bigint = BigInt(pool.view.target);
        const totalCommitted: bigint = BigInt(pool.view.totalCommitted);
        const settled = pool.view.settled;
        const expired = pool.view.expired;

        if (settled || expired) {
          const step: FundStep = {
            walletId,
            decision: "skipped",
            reason: "skip: pool settled/expired",
            approveTxHash: null,
            commitTxHash: null,
          };
          steps.push(step);
          log("info", "agents.fund.step", {
            walletId,
            decision: step.decision,
            reason: step.reason,
          });
          continue;
        }

        if (
          wouldExceedTarget(
            {
              target,
              totalCommitted,
              settled,
              expired,
              participantCount: BigInt(pool.view.participantCount),
            },
            SHARE_ATOMIC,
          )
        ) {
          const step: FundStep = {
            walletId,
            decision: "skipped",
            reason: `skip: would exceed ${fromAtomicUsdc(target)} target`,
            approveTxHash: null,
            commitTxHash: null,
          };
          steps.push(step);
          log("info", "agents.fund.step", {
            walletId,
            decision: step.decision,
            reason: step.reason,
          });
          continue;
        }

        const approve = await executeContractAndWait(client, {
          walletId,
          contractAddress: USDC_ADDRESS,
          abiFunctionSignature: "approve(address,uint256)",
          abiParameters: [POOL_ADDRESS, shareAmount],
        });
        if (!approve.ok) {
          const step: FundStep = {
            walletId,
            decision: "failed",
            reason: `approve failed: ${approve.error}`,
            approveTxHash: null,
            commitTxHash: null,
          };
          steps.push(step);
          log("info", "agents.fund.step", {
            walletId,
            decision: step.decision,
            reason: step.reason,
          });
          continue;
        }

        const commit = await executeContractAndWait(client, {
          walletId,
          contractAddress: POOL_ADDRESS,
          abiFunctionSignature: "commit(uint256)",
          abiParameters: [shareAmount],
        });
        if (!commit.ok) {
          const step: FundStep = {
            walletId,
            decision: "failed",
            reason: `commit failed: ${commit.error}`,
            approveTxHash: approve.txHash,
            commitTxHash: null,
          };
          steps.push(step);
          log("info", "agents.fund.step", {
            walletId,
            decision: step.decision,
            reason: step.reason,
            approveTxHash: approve.txHash,
          });
          continue;
        }

        const step: FundStep = {
          walletId,
          decision: "funded",
          reason: `funded +${fromAtomicUsdc(SHARE_ATOMIC)} USDC`,
          approveTxHash: approve.txHash,
          commitTxHash: commit.txHash,
        };
        steps.push(step);
        log("info", "agents.fund.step", {
          walletId,
          decision: step.decision,
          reason: step.reason,
          approveTxHash: approve.txHash,
          commitTxHash: commit.txHash,
        });
      } catch (error) {
        const step: FundStep = {
          walletId,
          decision: "failed",
          reason: `failed: ${errorMessage(error)}`,
          approveTxHash: null,
          commitTxHash: null,
        };
        steps.push(step);
        log("info", "agents.fund.step", {
          walletId,
          decision: step.decision,
          reason: step.reason,
        });
      }
    }

    const funded = steps.filter((step) => step.decision === "funded").length;
    log("info", "agents.fund.complete", {
      route: "POST /api/agents/fund",
      funded,
      skipped: steps.filter((step) => step.decision === "skipped").length,
      failed: steps.filter((step) => step.decision === "failed").length,
      durationMs: Date.now() - started,
    });

    return NextResponse.json({ ok: true, pool: POOL_ADDRESS, steps });
  } catch (error) {
    const body: FundResponse = { ok: false, error: errorMessage(error) };
    return NextResponse.json(body, { status: 500 });
  }
}
