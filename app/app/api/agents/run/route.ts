import { NextResponse } from "next/server";
import {
  DEMO_SEED_AGENTS,
  fromAtomicUsdc,
  wouldExceedTarget,
} from "@jx-nexus/coalition";
import { SHARE_ATOMIC } from "@/lib/constants";
import { log } from "@/lib/logger";
import { readCurrentRound, readPoolState } from "@/lib/pool-state";
import type { AgentDecision, RunResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * POST /api/agents/run — sequential dry-run of the 4-agent demo loop.
 * Mirrors plans/agent-loop.md §§2–4: seeds run in order, each decision gated
 * by `wouldExceedTarget` against a running total plus the settled/expired
 * flags. No chain writes, no wallet commands — hashes are always null.
 */
export async function POST(): Promise<NextResponse<RunResponse>> {
  const started = Date.now();
  const pool = await readPoolState();
  log("info", "agents.run.start", {
    route: "POST /api/agents/run",
    agents: DEMO_SEED_AGENTS.length,
    poolSource: pool.source,
    totalCommitted: pool.view.totalCommitted,
    target: pool.view.target,
  });

  try {
    let running: bigint = BigInt(pool.view.totalCommitted);
    const decisions: AgentDecision[] = [];
    for (const seed of DEMO_SEED_AGENTS) {
      const round = await readCurrentRound();
      const roundId = round.view.roundId;
      const target: bigint = BigInt(round.view.target);
      const liveTotal: bigint = BigInt(round.view.totalCommitted);
      if (liveTotal > running) running = liveTotal;
      const before = running;
      const state = {
        target,
        totalCommitted: before,
        settled: round.view.settled,
        expired: round.view.expired,
        participantCount: BigInt(round.view.participantCount),
      };
      if (round.view.settled || round.view.expired) {
        decisions.push({
          agent: seed.id,
          decision: "skip",
          reason: `skip: round ${roundId} settled/expired`,
          amountAtomic: "0",
          poolFillBefore: before.toString(),
          poolFillAfter: before.toString(),
          roundId,
          approveHash: null,
          commitHash: null,
        });
        continue;
      }
      if (wouldExceedTarget(state, SHARE_ATOMIC)) {
        decisions.push({
          agent: seed.id,
          decision: "skip",
          reason: `skip: would exceed ${fromAtomicUsdc(target)} target`,
          amountAtomic: "0",
          poolFillBefore: before.toString(),
          poolFillAfter: before.toString(),
          roundId,
          approveHash: null,
          commitHash: null,
        });
        continue;
      }
      const after = before + SHARE_ATOMIC;
      running = after;
      decisions.push({
        agent: seed.id,
        decision: "join",
        reason:
          `fill ${fromAtomicUsdc(before)}/${fromAtomicUsdc(target)} allows ` +
          `+${fromAtomicUsdc(SHARE_ATOMIC)}; no dropout tag`,
        amountAtomic: SHARE_ATOMIC.toString(),
        poolFillBefore: before.toString(),
        poolFillAfter: after.toString(),
        roundId,
        approveHash: null,
        commitHash: null,
      });
    }

    for (const d of decisions) {
      log("debug", "agents.run.decision", {
        agent: d.agent,
        decision: d.decision,
        reason: d.reason,
        amountAtomic: d.amountAtomic,
        poolFillBefore: d.poolFillBefore,
        poolFillAfter: d.poolFillAfter,
      });
    }

    const now = new Date();
    const stamp = now.toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "").replace("T", "-");

    const joins = decisions.filter((d) => d.decision === "join").length;
    const first = decisions[0];
    log("info", "agents.run.complete", {
      route: "POST /api/agents/run",
      runId: `demo-${stamp}-001`,
      joins,
      skips: decisions.length - joins,
      durationMs: Date.now() - started,
      ...(first?.roundId === undefined ? {} : { roundId: first.roundId }),
    });

    return NextResponse.json({
      ok: true,
      runId: `demo-${stamp}-001`,
      agents: DEMO_SEED_AGENTS.length,
      mode: "sequential",
      dryRun: true,
      ...(first?.roundId === undefined ? {} : { roundId: first.roundId }),
      decisions,
    });
  } catch (error) {
    const message: string = errorMessage(error);
    const body: RunResponse = { ok: false, error: message };
    return NextResponse.json(body, { status: 500 });
  }
}
