import { NextResponse } from "next/server";
import type { Address } from "viem";
import { fromAtomicUsdc } from "@jx-nexus/coalition";
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
    log("error", "agents.fund.missing_env", {
      route: "POST /api/agents/fund",
      error: env.error,
    });
    return NextResponse.json({ ok: false, error: env.error }, { status: 503 });
  }

  const started = Date.now();
  const client = createCircleClient(env.apiKey, env.entitySecret);
  log("info", "agents.fund.start", {
    route: "POST /api/agents/fund",
    wallets: env.walletIds.length,
    pool: POOL_ADDRESS,
  });

  try {
    const steps: FundStep[] = [];
    let fundedRoundId: string | undefined;
    for (const [index, walletId] of env.walletIds.entries()) {
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

        // Dynamic fill: split whatever is left across the wallets still
        // to run, capped at the standard share. A fixed 20 USDC share
        // against a 10 USDC round used to skip every wallet — now the
        // remainder is divided up (e.g. 5 USDC left across 4 wallets puts
        // in ~1.25 USDC each). The live total is re-read each iteration
        // so later wallets split the new remainder.
        const walletsLeft = env.walletIds.length - index;
        const remaining = target > totalCommitted ? target - totalCommitted : 0n;
        if (remaining <= 0n) {
          const step: FundStep = {
            walletId,
            decision: "skipped",
            reason: `skip: round ${roundId} already at ${fromAtomicUsdc(target)} target`,
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
        let amount = SHARE_ATOMIC;
        const evenSplit = remaining / BigInt(walletsLeft);
        if (evenSplit < amount) amount = evenSplit > 0n ? evenSplit : remaining;

        // Check what this wallet has already committed in this round and
        // fund only the delta so re-running fund is idempotent and partial
        // commits (from a previous interrupted run) are topped up correctly.
        const walletAddress = await getWalletAddress(client, walletId);
        if (walletAddress !== null) {
          const committed = await readCommitted(
            BigInt(roundId),
            walletAddress as Address,
          );
          if (committed !== null && committed > 0n) {
            const topUp = amount > committed ? amount - committed : 0n;
            if (topUp <= 0n) {
              // Wallet has already covered its share — nothing more to send.
              const step: FundStep = {
                walletId,
                decision: "skipped",
                reason: `skip: already funded ${fromAtomicUsdc(committed)} USDC in round ${roundId} (share fully covered)`,
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
            // Partially committed — fund just the remaining delta.
            amount = topUp;
            log("info", "agents.fund.top_up", {
              walletId,
              alreadyCommitted: fromAtomicUsdc(committed),
              topUp: fromAtomicUsdc(topUp),
              roundId,
            });
          }
        }
        const shareAmount = amount.toString();

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
          reason: `funded +${fromAtomicUsdc(amount)} USDC to round ${roundId}`,
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
    const message = errorMessage(error);
    log("error", "agents.fund.error", {
      route: "POST /api/agents/fund",
      error: message,
    });
    const body: FundResponse = { ok: false, error: message };
    return NextResponse.json(body, { status: 500 });
  }
}
