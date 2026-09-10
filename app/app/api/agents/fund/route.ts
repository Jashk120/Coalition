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
 * round behind the chain, wrongly 409ing the first attempts. Poll about
 * every 750ms (up to ~12s total) and retry only round-lag 409s; a settled
 * round with real stake succeeds once the tracker catches up, usually in
 * ~1-3s. All other errors fail fast with no extra delay.
 */
function isRoundLagError(error: string | undefined): boolean {
  if (error === undefined) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes("409") || lower.includes("round") || lower.includes("settled")
  );
}

function isTerminalSettleDenial(error: string | undefined): boolean {
  if (error === undefined) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes("allocations are final") ||
    lower.includes("pool_settled") ||
    (lower.includes("pool settled") && lower.includes("final"))
  );
}

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
  const deadline = Date.now() + 12_000;
  let last: { readonly ok: boolean; readonly error?: string } = {
    ok: false,
    error: "no attempts",
  };
  for (;;) {
    last = await allocateSlice(wallet, cpu, memMB);
    if (last.ok) return last;
    if (isTerminalSettleDenial(last.error)) return last;
    if (!isRoundLagError(last.error)) return last;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return last;
    await sleep(Math.min(750, remaining));
  }
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

  try {
    const slots: { readonly index: number; readonly step: FundStep }[] = [];
    let fundedRoundId: string | undefined;
    // Phase 1 — sequential gating reads in seed order (order is the demo
    // run order and must never change). Amounts split one snapshot
    // remainder locally: identical math to per-iteration re-reads when
    // nothing else commits mid-run, and it can never overshoot the target.
    // No chain writes here.
    type FundJob = {
      readonly walletId: string;
      readonly index: number;
      readonly roundId: string;
      readonly amount: bigint;
      readonly shareAmount: string;
    };
    const jobs: FundJob[] = [];
    const opening = await readCurrentRound().catch((): null => null);
    log("info", "agents.fund.start", {
      route: "POST /api/agents/fund",
      wallets: env.walletIds.length,
      pool: POOL_ADDRESS,
      source: opening === null ? "unknown" : opening.source,
      ...(opening?.note === undefined ? {} : { note: opening.note }),
    });
    if (opening !== null && opening.view.roundId === "0") {
      log("warn", "agents.fund.round-fallback", {
        route: "POST /api/agents/fund",
        source: opening.source,
        ...(opening.note === undefined ? {} : { note: opening.note }),
      });
    }
    if (opening === null) {
      for (const [index, walletId] of env.walletIds.entries()) {
        slots.push({ index, step: {
          walletId,
          decision: "failed",
          reason: "failed: round read unavailable",
          approveTxHash: null,
          commitTxHash: null,
        } });
      }
    } else {
      const roundId = opening.view.roundId;
      const target: bigint = BigInt(opening.view.target);
      let remaining: bigint =
        BigInt(opening.view.totalCommitted) < target
          ? target - BigInt(opening.view.totalCommitted)
          : 0n;
      const closed = opening.view.settled || opening.view.expired;
      for (const [index, walletId] of env.walletIds.entries()) {
        if (closed) {
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
          slots.push({ index, step });
          log("info", "agents.fund.step", {
            walletId,
            decision: step.decision,
            reason: step.reason,
            allocateOk: allocation.ok,
          });
          continue;
        }

        // Dynamic fill: split whatever is left across the wallets still
        // to run, capped at the standard share.
        if (remaining <= 0n) {
          const step: FundStep = {
            walletId,
            decision: "skipped",
            reason: `skip: round ${roundId} already at ${fromAtomicUsdc(target)} target`,
            roundId,
            approveTxHash: null,
            commitTxHash: null,
          };
          slots.push({ index, step });
          log("info", "agents.fund.step", {
            walletId,
            decision: step.decision,
            reason: step.reason,
          });
          continue;
        }
        const walletsLeft = env.walletIds.length - index;
        let amount = SHARE_ATOMIC;
        const evenSplit = remaining / BigInt(walletsLeft);
        if (evenSplit < amount) amount = evenSplit > 0n ? evenSplit : remaining;
        // No per-wallet funded check: on-chain `committed` is cumulative
        // across runs while `amount` is this run's marginal slice, so
        // comparing them deadlocks partial fills (every wallet skips
        // while a remainder is still outstanding). Past commits are
        // already sunk into `remaining` via the snapshot above.
        remaining -= amount;
        jobs.push({
          walletId,
          index,
          roundId,
          amount,
          shareAmount: amount.toString(),
        });
      }
    }

    // Phase 2 — parallel approves. Independent USDC approvals with no
    // shared state between wallets; Promise.all preserves seed order.
    const approvals = await Promise.all(
      jobs.map(async (job) =>
        executeContractAndWait(client, {
          walletId: job.walletId,
          contractAddress: USDC_ADDRESS,
          abiFunctionSignature: "approve(address,uint256)",
          abiParameters: [POOL_ADDRESS, job.shareAmount],
        }),
      ),
    );

    // Phase 3 — sequential commits in seed order. Commits share the round
    // remainder and the last one auto-settles, so they must not race.
    for (const [jobAt, job] of jobs.entries()) {
      const { walletId, index, roundId, amount, shareAmount } = job;
      const approve = approvals[jobAt];
      if (approve === undefined || !approve.ok) {
        const step: FundStep = {
          walletId,
          decision: "failed",
          reason: `approve failed: ${approve === undefined ? "missing" : approve.error}`,
          roundId,
          approveTxHash: null,
          commitTxHash: null,
        };
        slots.push({ index, step });
        log("info", "agents.fund.step", {
          walletId,
          decision: step.decision,
          reason: step.reason,
        });
        continue;
      }
      try {

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
          slots.push({ index, step });
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
        slots.push({ index, step });
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
          walletId: job.walletId,
          decision: "failed",
          reason: `failed: ${errorMessage(error)}`,
          approveTxHash: null,
          commitTxHash: null,
        };
        slots.push({ index, step });
        log("info", "agents.fund.step", {
          walletId,
          decision: step.decision,
          reason: step.reason,
        });
      }
    }

    // Seed order is the demo run order: phases complete out of order
    // (parallel approves, retried allocates), so reassemble by slot.
    const steps: FundStep[] = slots
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.step);
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
