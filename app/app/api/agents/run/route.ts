import { NextResponse } from "next/server";
import {
  DEMO_SEED_AGENTS,
  fromAtomicUsdc,
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
 * Mirrors plans/agent-loop.md §§2–4: seeds run in order, each decision
 * taking a dynamic slice of the remainder (standard share capped at
 * what's-left / agents-left). No chain writes, no wallet commands —
 * hashes are always null.
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
    for (const [index, seed] of DEMO_SEED_AGENTS.entries()) {
      const round = await readCurrentRound();
      const roundId = round.view.roundId;
      const target: bigint = BigInt(round.view.target);
      const liveTotal: bigint = BigInt(round.view.totalCommitted);
      if (liveTotal > running) running = liveTotal;
      const before = running;
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
      // Same dynamic fill as POST /api/agents/fund: split the remainder
      // across the agents still to run, capped at the standard share.
      const agentsLeft = DEMO_SEED_AGENTS.length - index;
      const remaining = target > before ? target - before : 0n;
      if (remaining <= 0n) {
        decisions.push({
          agent: seed.id,
          decision: "skip",
          reason: `skip: round ${roundId} already at ${fromAtomicUsdc(target)} target`,
          amountAtomic: "0",
          poolFillBefore: before.toString(),
          poolFillAfter: before.toString(),
          roundId,
          approveHash: null,
          commitHash: null,
        });
        continue;
      }
      let amount = SHARE_ATOMIC;
      const evenSplit = remaining / BigInt(agentsLeft);
      if (evenSplit < amount) amount = evenSplit > 0n ? evenSplit : remaining;
      const after = before + amount;
      running = after;
      decisions.push({
        agent: seed.id,
        decision: "join",
        reason:
          `fill ${fromAtomicUsdc(before)}/${fromAtomicUsdc(target)} allows ` +
          `+${fromAtomicUsdc(amount)}; no dropout tag`,
        amountAtomic: amount.toString(),
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
    log("error", "agents.run.error", {
      route: "POST /api/agents/run",
      error: message,
    });
    const body: RunResponse = { ok: false, error: message };
    return NextResponse.json(body, { status: 500 });
  }
}
