import { NextResponse } from "next/server";
import {
  DEMO_SEED_AGENTS,
  fromAtomicUsdc,
  resolveSeedAgents,
} from "@jx-nexus/coalition";
import { IDENTITY_REGISTRY_FROM_BLOCK, SHARE_ATOMIC } from "@/lib/constants";
import { arcPublicClient, sepoliaPublicClient } from "@/lib/chain";
import { log } from "@/lib/logger";
import { readCurrentRound, readPoolState } from "@/lib/pool-state";
import type { AgentDecision, RunResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(ms)}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
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
    // ENS is mandatory: resolve every seed live before any join decision.
    // No hardcoded wallet fallback — an unresolved seed cannot join.
    const resolutions = await withTimeout(
      resolveSeedAgents({
        sepoliaClient: sepoliaPublicClient(),
        arcClient: arcPublicClient(),
        seeds: DEMO_SEED_AGENTS,
        reviewers: DEMO_SEED_AGENTS.map((seed) => seed.wallet),
        fromBlock: IDENTITY_REGISTRY_FROM_BLOCK,
      }),
      30_000,
      "resolveSeedAgents",
    ).catch((): null => null);
    const resolutionById = new Map(
      (resolutions ?? []).map((entry) => [entry.seed.id, entry]),
    );
    for (const [index, seed] of DEMO_SEED_AGENTS.entries()) {
      const round = await readCurrentRound();
      const roundId = round.view.roundId;
      const target: bigint = BigInt(round.view.target);
      const liveTotal: bigint = BigInt(round.view.totalCommitted);
      if (liveTotal > running) running = liveTotal;
      const before = running;
      const resolution = resolutionById.get(seed.id);
      if (resolution === undefined || resolution.status !== "resolved") {
        const reason =
          resolution === undefined
            ? `skip: ENS resolution unavailable for "${seed.ensName}"`
            : `skip: ENS unresolved — ${resolution.reason}`;
        decisions.push({
          agent: seed.id,
          decision: "skip",
          reason,
          amountAtomic: "0",
          poolFillBefore: before.toString(),
          poolFillAfter: before.toString(),
          roundId,
          approveHash: null,
          commitHash: null,
        });
        continue;
      }
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
