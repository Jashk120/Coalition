import { NextResponse } from "next/server";
import type { Address } from "viem";
import { fromAtomicUsdc, wouldExceedTarget } from "@jx-nexus/coalition";
import { POOL_ADDRESS, SHARE_ATOMIC } from "@/lib/constants";
import {
  USDC_ADDRESS,
  createCircleClient,
  executeContractAndWait,
  getWalletAddress,
  readCircleEnv,
} from "@/lib/circle-fund";
import { log } from "@/lib/logger";
import { readCommitted, readCurrentRound } from "@/lib/pool-state";
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
    let fundedRoundId: string | undefined;
    for (const walletId of env.walletIds) {
      try {
        const round = await readCurrentRound();
        const roundId = round.view.roundId;
        const target: bigint = BigInt(round.view.target);
        const totalCommitted: bigint = BigInt(round.view.totalCommitted);
        const settled = round.view.settled;
        const expired = round.view.expired;

        if (settled || expired) {
          const step: FundStep = {
            walletId,
            decision: "skipped",
            reason: `skip: round ${roundId} settled/expired`,
            roundId,
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
              participantCount: BigInt(round.view.participantCount),
            },
            SHARE_ATOMIC,
          )
        ) {
          const step: FundStep = {
            walletId,
            decision: "skipped",
            reason: `skip: would exceed ${fromAtomicUsdc(target)} target`,
            roundId,
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

        const walletAddress = await getWalletAddress(client, walletId);
        if (walletAddress !== null) {
          const committed = await readCommitted(
            BigInt(roundId),
            walletAddress as Address,
          );
          if (committed !== null && committed > 0n) {
            const step: FundStep = {
              walletId,
              decision: "skipped",
              reason: `skip: already funded ${fromAtomicUsdc(committed)} USDC in round ${roundId}`,
              roundId,
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
            roundId,
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

        const commit =
          roundId === "0"
            ? await executeContractAndWait(client, {
                walletId,
                contractAddress: POOL_ADDRESS,
                abiFunctionSignature: "commit(uint256)",
                abiParameters: [shareAmount],
              })
            : await executeContractAndWait(client, {
                walletId,
                contractAddress: POOL_ADDRESS,
                abiFunctionSignature: "commit(uint256,uint256)",
                abiParameters: [roundId, shareAmount],
              });
        if (!commit.ok) {
          const step: FundStep = {
            walletId,
            decision: "failed",
            reason: `commit failed: ${commit.error}`,
            roundId,
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
          reason: `funded +${fromAtomicUsdc(SHARE_ATOMIC)} USDC to round ${roundId}`,
          roundId,
          approveTxHash: approve.txHash,
          commitTxHash: commit.txHash,
        };
        steps.push(step);
        fundedRoundId = roundId;
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
      ...(fundedRoundId === undefined ? {} : { roundId: fundedRoundId }),
    });

    return NextResponse.json({
      ok: true,
      pool: POOL_ADDRESS,
      ...(fundedRoundId === undefined ? {} : { roundId: fundedRoundId }),
      steps,
    });
  } catch (error) {
    const body: FundResponse = { ok: false, error: errorMessage(error) };
    return NextResponse.json(body, { status: 500 });
  }
}
