import { NextResponse } from "next/server";
import { fromAtomicUsdc } from "@jx-nexus/coalition";
import { POOL_ADDRESS, SEED_META, SHARE_ATOMIC } from "@/lib/constants";
import {
  USDC_ADDRESS,
  createCircleClient,
  executeContractAndWait,
  getWalletAddress,
  readCircleEnv,
} from "@/lib/circle-fund";
import { log } from "@/lib/logger";
import { orchestratorBaseUrl, readCurrentRound } from "@/lib/pool-state";
import type { FundResponse, FundStep } from "@/lib/types";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Server-side app key only — never a NEXT_PUBLIC_ value. */
function appKey(): string | undefined {
  const key =
    process.env["ORCHESTRATOR_APP_KEY"] ?? process.env["APP_KEY"];
  return key !== undefined && key !== "" ? key : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Allocate with patience: the orchestrator's round tracker can lag a fresh
 * round behind the chain, wrongly 409ing the first attempts. Three tries
 * ~8s apart ride out the lag; a settled round with real stake succeeds on
 * retry once the tracker catches up.
 */
async function allocateWithRetry(
  client: Parameters<typeof getWalletAddress>[0],
  walletId: string,
  index: number,
): Promise<{ readonly ok: boolean; readonly error?: string }> {
  const funderAddress = await getWalletAddress(client, walletId);
  const seed = SEED_META[index];
  const wallet = funderAddress ?? seed?.wallet ?? walletId;
  const cpu = seed?.cpu ?? 0.1;
  const memMB = seed?.memMB ?? 400;
  let last: { readonly ok: boolean; readonly error?: string } = {
    ok: false,
    error: "no attempts",
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(8_000);
    last = await allocateSlice(wallet, cpu, memMB);
    if (last.ok) return last;
  }
  return last;
}

/**
 * Provision one agent slice in the orchestrator. Never throws and never
 * surfaces the agent token: ok flag + error string only.
 */
async function allocateSlice(
  wallet: string,
  cpu: number,
  memMB: number,
): Promise<{ readonly ok: boolean; readonly error?: string }> {
  const key = appKey();
  try {
    const upstream = await fetch(`${orchestratorBaseUrl()}/allocate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key === undefined ? {} : { "x-app-key": key }),
      },
      body: JSON.stringify({ wallet, cpu, mem: memMB }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok) {
      let detail = "";
      try {
        const payload: unknown = await upstream.json();
        if (typeof payload === "object" && payload !== null) {
          if ("error" in payload && typeof payload.error === "string") {
            detail = `: ${payload.error}`;
          } else if ("message" in payload && typeof payload.message === "string") {
            detail = `: ${payload.message}`;
          }
        }
      } catch {
        detail = "";
      }
      return {
        ok: false,
        error: `orchestrator returned ${String(upstream.status)}${detail}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
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
          // Repair path: funding is done but the slice may be missing
          // (earlier 409s from round-tracker lag). Proven participants can
          // still allocate post-settle, so try before skipping.
          const allocation = await allocateWithRetry(client, walletId, index);
          const step: FundStep = {
            walletId,
            decision: "skipped",
            reason: `skip: round ${roundId} settled/expired`,
            roundId,
            approveTxHash: null,
            commitTxHash: null,
            allocateOk: allocation.ok,
            ...(allocation.error === undefined
              ? {}
              : { allocateError: allocation.error }),
          };
          steps.push(step);
          log("info", "agents.fund.step", {
            walletId,
            decision: step.decision,
            reason: step.reason,
            allocateOk: allocation.ok,
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
        // No per-wallet funded check: on-chain `committed` is cumulative
        // across runs while `amount` is this run's marginal slice, so
        // comparing them deadlocks partial fills (every wallet skips
        // while a remainder is still outstanding). Past commits are
        // already sunk into `remaining` via the live total above.
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

        // Provision the VPS slice right after the commit lands: one fund
        // click funds on-chain AND allocates compute. The slice goes to the
        // actual funder address (Circle wallet), not the display seed
        // wallet — post-settle the orchestrator only honors proven
        // participants. Retried: the tracker's round view can lag the commit
        // by seconds. A failed allocate never flips funded to failed —
        // the money moved, so it is only recorded on the step.
        const allocation = await allocateWithRetry(client, walletId, index);
        const step: FundStep = {
          walletId,
          decision: "funded",
          reason: `funded +${fromAtomicUsdc(amount)} USDC to round ${roundId}`,
          roundId,
          approveTxHash: approve.txHash,
          commitTxHash: commit.txHash,
          allocateOk: allocation.ok,
          ...(allocation.error === undefined
            ? {}
            : { allocateError: allocation.error }),
        };
        steps.push(step);
        fundedRoundId = roundId;
        log("info", "agents.fund.step", {
          walletId,
          decision: step.decision,
          reason: step.reason,
          approveTxHash: approve.txHash,
          commitTxHash: commit.txHash,
          allocateOk: allocation.ok,
          ...(allocation.error === undefined
            ? {}
            : { allocateError: allocation.error }),
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
