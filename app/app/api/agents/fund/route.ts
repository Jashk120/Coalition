import { NextResponse } from "next/server";
import { erc20Abi } from "viem";
import type { Address, Hash } from "viem";
import {
  ARC_TESTNET,
  commitToPool,
  fromAtomicUsdc,
  resolveArcWallet,
} from "@jx-nexus/coalition";
import {
  POOL_ADDRESS,
  SEED_META,
  SHARE_ATOMIC,
  USDC_ADDRESS,
} from "@/lib/constants";
import { arcPublicClient, sepoliaPublicClient } from "@/lib/chain";
import { log } from "@/lib/logger";
import { orchestratorBaseUrl, readCurrentRound } from "@/lib/pool-state";
import { readSeedSigners } from "@/lib/seed-keys";
import type { SeedSigner } from "@/lib/seed-keys";
import type { FundResponse, FundStep } from "@/lib/types";

export const dynamic = "force-dynamic";

type ArcPublicClient = ReturnType<typeof arcPublicClient>;

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
 *
 * justFunded widens the retry to terminal settle denials: a wallet whose
 * commit just settled the round has provable on-chain stake, so the denial
 * is a poller/RPC convergence lag that clears within seconds. Without it
 * (repair path for wallets that may never have funded) the terminal denial
 * still fails fast to avoid a pointless 12s wait.
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

type FunderAttestation = {
  readonly index: number;
  readonly wallet: Address;
  readonly ensName: string | null;
  readonly ensWallet: Address | null;
  readonly ok: boolean;
  readonly note?: string;
};

/**
 * Attest one self-custody signer against its ENS subname: the signer address
 * MUST equal the live `agentN.agentpool.eth` Arc record. This is the
 * load-bearing ENS check — a key whose address the name does not resolve to
 * can never approve or commit.
 */
async function attestFunder(params: {
  readonly signer: SeedSigner;
  readonly index: number;
}): Promise<FunderAttestation> {
  const ensName = SEED_META[params.index]?.ensName ?? null;
  const wallet = params.signer.address;
  let ensWallet: Address | null = null;
  let note: string | undefined;
  if (ensName === null) {
    note = `no ENS subname configured for funder index ${params.index}`;
  } else {
    try {
      ensWallet = await withTimeout(
        resolveArcWallet({ publicClient: sepoliaPublicClient(), name: ensName }),
        20_000,
        `resolveArcWallet(${ensName})`,
      );
    } catch (error) {
      note = `ENS lookup failed for "${ensName}": ${errorMessage(error)}`;
    }
  }
  const ok =
    ensName !== null &&
    ensWallet !== null &&
    ensWallet.toLowerCase() === wallet.toLowerCase();
  if (!ok && note === undefined) {
    note =
      ensWallet === null
        ? `no Arc record for "${ensName ?? `index ${params.index}`}"`
        : `signer ${wallet} != ENS wallet ${ensWallet} for "${ensName}"`;
  }
  return {
    index: params.index,
    wallet,
    ensName,
    ensWallet,
    ok,
    ...(note === undefined ? {} : { note }),
  };
}

type AttestedFunder = {
  readonly index: number;
  readonly wallet: Address;
  readonly ensName: string | null;
  readonly ensWallet: Address;
  readonly ok: true;
};

function attestationFields(att: FunderAttestation): Pick<
  FundStep,
  "ensName" | "ensWallet" | "funderWallet" | "ensAttested"
> {
  return {
    ...(att.ensName === null ? {} : { ensName: att.ensName }),
    ensWallet: att.ensWallet,
    funderWallet: att.wallet,
    ensAttested: att.ok,
  };
}

type TxResult =
  | { readonly ok: true; readonly hash: Hash }
  | { readonly ok: false; readonly error: string };

/** Approve the pool to pull `amount`, signed by the agent's own key. */
async function approveUsdc(
  publicClient: ArcPublicClient,
  signer: SeedSigner,
  amount: bigint,
): Promise<TxResult> {
  try {
    const hash = await signer.walletClient.writeContract({
      address: USDC_ADDRESS as Address,
      abi: erc20Abi,
      functionName: "approve",
      args: [POOL_ADDRESS, amount],
      account: signer.account,
      chain: ARC_TESTNET,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return { ok: true, hash };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Commit to `roundId` (omit on the v1 shim), signed by the agent's own key. */
async function commitToRound(
  publicClient: ArcPublicClient,
  signer: SeedSigner,
  roundId: string,
  amount: bigint,
): Promise<TxResult> {
  try {
    const { hash } = await commitToPool({
      walletClient: signer.walletClient,
      account: signer.account,
      pool: POOL_ADDRESS,
      amount,
      ...(roundId === "0" ? {} : { roundId: BigInt(roundId) }),
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return { ok: true, hash };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function allocateWithRetry(
  wallet: string,
  index: number,
  justFunded = false,
): Promise<{ readonly ok: boolean; readonly error?: string }> {
  const seed = SEED_META[index];
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
    const terminal = isTerminalSettleDenial(last.error);
    if (terminal && !justFunded) return last;
    if (!terminal && !isRoundLagError(last.error)) return last;
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
 * POST /api/agents/fund — headless on-chain funding from the agents' own
 * self-custody keys (`~/.coalition/seed-keys.json`). Live gating (settled /
 * expired / full) then a USDC approve + pool commit per agent, recording the
 * tx hashes. Funding is gated on ENS: each key must derive the wallet its
 * `agentN.agentpool.eth` record resolves to, so a misaligned key fails closed.
 * A missing keys file yields 503 with a setup hint.
 */
export async function POST(): Promise<NextResponse<FundResponse>> {
  const seedKeys = readSeedSigners();
  if (!seedKeys.ok) {
    log("error", "agents.fund.missing_keys", {
      route: "POST /api/agents/fund",
      error: seedKeys.error,
    });
    return NextResponse.json({ ok: false, error: seedKeys.error }, { status: 503 });
  }
  const signers = seedKeys.signers;

  const started = Date.now();
  const publicClient = arcPublicClient();

  try {
    const slots: { readonly index: number; readonly step: FundStep }[] = [];
    let fundedRoundId: string | undefined;
    // ENS attestation pre-pass: the signer for each agent must be the wallet
    // its subname resolves to. Unattested signers never reach approve/commit.
    const attestations = new Map<number, FunderAttestation>();
    for (const signer of signers) {
      attestations.set(
        signer.index,
        await attestFunder({ signer, index: signer.index }),
      );
    }
    const attestedLeftFrom = (index: number): number =>
      [...attestations.values()].filter((att) => att.ok && att.index >= index)
        .length;
    log("info", "agents.fund.attest", {
      route: "POST /api/agents/fund",
      attested: [...attestations.values()].filter((att) => att.ok).length,
      total: attestations.size,
    });
    // Phase 1 — sequential gating reads in seed order (order is the demo
    // run order and must never change). Amounts split one snapshot
    // remainder locally: identical math to per-iteration re-reads when
    // nothing else commits mid-run, and it can never overshoot the target.
    // No chain writes here.
    type FundJob = {
      readonly signer: SeedSigner;
      readonly index: number;
      readonly roundId: string;
      readonly amount: bigint;
      readonly att: AttestedFunder;
    };
    const jobs: FundJob[] = [];
    const opening = await readCurrentRound().catch((): null => null);
    log("info", "agents.fund.start", {
      route: "POST /api/agents/fund",
      wallets: signers.length,
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
      for (const signer of signers) {
        slots.push({ index: signer.index, step: {
          wallet: signer.address,
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
      for (const signer of signers) {
        const index = signer.index;
        const wallet = signer.address;
        const att = attestations.get(index);
        const attWallet = att?.ensWallet ?? null;
        if (att === undefined || !att.ok || attWallet === null) {
          const step: FundStep = {
            wallet,
            decision: "failed",
            reason: `ENS attestation failed: ${att?.note ?? "unknown signer"}`,
            roundId,
            approveTxHash: null,
            commitTxHash: null,
            ...(att === undefined ? {} : attestationFields(att)),
          };
          slots.push({ index, step });
          log("info", "agents.fund.step", {
            wallet,
            decision: step.decision,
            reason: step.reason,
            ensAttested: false,
          });
          continue;
        }
        if (closed) {
          // Repair path: funding is done but the slice may be missing
          // (earlier 409s from round-tracker lag). Proven participants can
          // still allocate post-settle, so try before skipping.
          const allocation = await allocateWithRetry(attWallet, index);
          const step: FundStep = {
            wallet,
            decision: "skipped",
            reason: `skip: round ${roundId} settled/expired`,
            roundId,
            approveTxHash: null,
            commitTxHash: null,
            allocateOk: allocation.ok,
            ...(allocation.error === undefined
              ? {}
              : { allocateError: allocation.error }),
            ...attestationFields(att),
          };
          slots.push({ index, step });
          log("info", "agents.fund.step", {
            wallet,
            decision: step.decision,
            reason: step.reason,
            allocateOk: allocation.ok,
            ensAttested: true,
          });
          continue;
        }

        // Dynamic fill: split whatever is left across the wallets still
        // to run, capped at the standard share.
        if (remaining <= 0n) {
          const step: FundStep = {
            wallet,
            decision: "skipped",
            reason: `skip: round ${roundId} already at ${fromAtomicUsdc(target)} target`,
            roundId,
            approveTxHash: null,
            commitTxHash: null,
            ...attestationFields(att),
          };
          slots.push({ index, step });
          log("info", "agents.fund.step", {
            wallet,
            decision: step.decision,
            reason: step.reason,
          });
          continue;
        }
        const walletsLeft = attestedLeftFrom(index);
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
          signer,
          index,
          roundId,
          amount,
          att: {
            index: att.index,
            wallet: attWallet,
            ensName: att.ensName,
            ensWallet: attWallet,
            ok: true,
          },
        });
      }
    }

    // Phase 2 — parallel approves. Independent USDC approvals, one per
    // account with no shared nonce, so Promise.all is safe; it preserves
    // seed order in the returned array.
    const approvals = await Promise.all(
      jobs.map((job) => approveUsdc(publicClient, job.signer, job.amount)),
    );

    // Phase 3 — sequential commits in seed order. Commits share the round
    // remainder and the last one auto-settles, so they must not race.
    for (const [jobAt, job] of jobs.entries()) {
      const { signer, index, roundId, amount, att } = job;
      const wallet = signer.address;
      const approve = approvals[jobAt];
      if (approve === undefined || !approve.ok) {
        const step: FundStep = {
          wallet,
          decision: "failed",
          reason: `approve failed: ${approve === undefined ? "missing" : approve.error}`,
          roundId,
          approveTxHash: null,
          commitTxHash: null,
          ...attestationFields(att),
        };
        slots.push({ index, step });
        log("info", "agents.fund.step", {
          wallet,
          decision: step.decision,
          reason: step.reason,
        });
        continue;
      }
      try {
        const commit = await commitToRound(publicClient, signer, roundId, amount);
        if (!commit.ok) {
          const step: FundStep = {
            wallet,
            decision: "failed",
            reason: `commit failed: ${commit.error}`,
            roundId,
            approveTxHash: approve.hash,
            commitTxHash: null,
            ...attestationFields(att),
          };
          slots.push({ index, step });
          log("info", "agents.fund.step", {
            wallet,
            decision: step.decision,
            reason: step.reason,
            approveTxHash: approve.hash,
          });
          continue;
        }

        // Provision the VPS slice right after the commit lands: one fund
        // click funds on-chain AND allocates compute. The slice goes to the
        // ENS-attested agent wallet, so the orchestrator's entitlement is
        // keyed to the same identity ENS names. Retried: the tracker's round
        // view can lag the commit by seconds. A failed allocate never flips
        // funded to failed — the money moved, so it is only recorded on the step.
        const allocation = await allocateWithRetry(att.ensWallet, index, true);
        const step: FundStep = {
          wallet,
          decision: "funded",
          reason: `funded +${fromAtomicUsdc(amount)} USDC to round ${roundId}`,
          roundId,
          approveTxHash: approve.hash,
          commitTxHash: commit.hash,
          allocateOk: allocation.ok,
          ...(allocation.error === undefined
            ? {}
            : { allocateError: allocation.error }),
          ...attestationFields(att),
        };
        slots.push({ index, step });
        fundedRoundId = roundId;
        log("info", "agents.fund.step", {
          wallet,
          decision: step.decision,
          reason: step.reason,
          approveTxHash: approve.hash,
          commitTxHash: commit.hash,
          allocateOk: allocation.ok,
          ...(allocation.error === undefined
            ? {}
            : { allocateError: allocation.error }),
        });
      } catch (error) {
        const step: FundStep = {
          wallet,
          decision: "failed",
          reason: `failed: ${errorMessage(error)}`,
          approveTxHash: approve.hash,
          commitTxHash: null,
          ...attestationFields(att),
        };
        slots.push({ index, step });
        log("info", "agents.fund.step", {
          wallet,
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
