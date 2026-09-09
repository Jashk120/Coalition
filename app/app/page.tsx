"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_IDENTITY_REGISTRY } from "@jx-nexus/coalition";
import { EXPLORER_URL, OUTSIDE_BUYER, SEED_META } from "@/lib/constants";
import type {
  ActivityEvent,
  ActivityResponse,
  AgentsResponse,
  AgentUsageView,
  FreePoolResponse,
  FundResponse,
  NamespacesResponse,
  NamespaceView,
  RotateResponse,
  FundStep,
  ResolutionView,
  RoundView,
  UsageResponse,
} from "@/lib/types";

type QuoteState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly summary: string }
  | { readonly status: "empty"; readonly reason: string }
  | { readonly status: "error"; readonly message: string };

type TermsState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly body: string }
  | { readonly status: "error"; readonly message: string };

type AgentQuoteState = {
  readonly wallet: string;
  readonly ensName: string;
  readonly quote: QuoteState;
};

type ActivityState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly events: readonly ActivityEvent[] }
  | { readonly status: "error"; readonly message: string };

type UsageState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly agents: readonly AgentUsageView[];
      readonly settled: boolean;
      readonly windowHours: number;
    }
  | { readonly status: "error"; readonly message: string };

type QuotePayload =
  | {
      readonly ok: true;
      readonly empty?: false;
      readonly quote: {
        readonly seller: string;
        readonly payTo: string;
        readonly ratePerMBAtomic: string;
        readonly ratePerCUAtomic: string;
        readonly availableMB: string;
        readonly availableCU: string;
      };
    }
  | { readonly ok: true; readonly empty: true; readonly reason: string }
  | { readonly ok: false; readonly error: string };

type TermsPayload =
  | { readonly ok: true; readonly terms: unknown }
  | { readonly ok: false; readonly error: string };

const SEPOLIA_EXPLORER_URL = "https://sepolia.etherscan.io";

function shortAddress(address: string): string {
  return address.length > 12
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : address;
}

/** Decimal USDC string from 6-decimal atomic units; falls back to raw input. */
function formatUsdc(atomic: string): string {
  try {
    const value = BigInt(atomic);
    const whole = value / 1000000n;
    const frac = (value % 1000000n)
      .toString()
      .padStart(6, "0")
      .replace(/0+$/, "");
    return frac === "" ? whole.toString() : `${whole.toString()}.${frac}`;
  } catch {
    return atomic;
  }
}

function fillPercent(committed: string, target: string): number {
  try {
    const num = BigInt(committed);
    const den = BigInt(target);
    if (den === 0n) return 0;
    return Number((num * 100n) / den);
  } catch {
    return 0;
  }
}

function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function formatUsage(value: number): string {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function resolutionFor(
  seedId: string,
  resolutions: readonly ResolutionView[],
): ResolutionView | undefined {
  return resolutions.find((entry) => entry.seedId === seedId);
}

/** Human countdown to a unix-seconds deadline ("0" = legacy pool, no deadline). */
function formatCountdown(deadline: string): string {
  try {
    const at = BigInt(deadline);
    if (at === 0n) return "no deadline (legacy pool)";
    const remaining = Number(at * 1000n - BigInt(Date.now()));
    if (remaining <= 0) return "deadline passed";
    const totalSeconds = Math.floor(remaining / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts: string[] = [];
    if (days > 0) parts.push(`${String(days)}d`);
    if (hours > 0 || days > 0) parts.push(`${String(hours)}h`);
    if (minutes > 0 || hours > 0 || days > 0) parts.push(`${String(minutes)}m`);
    parts.push(`${String(seconds)}s`);
    return `deadline in ${parts.join(" ")}`;
  } catch {
    return deadline;
  }
}

function roundResult(round: RoundView): "settled" | "expired" | "open" {
  if (round.settled) return "settled";
  if (round.expired) return "expired";
  return "open";
}

async function parseJson(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

export default function DashboardPage() {
  const [agents, setAgents] = useState<Extract<
    AgentsResponse,
    { readonly ok: true }
  > | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [funding, setFunding] = useState(false);
  const [fundError, setFundError] = useState<string | null>(null);
  const [fundSteps, setFundSteps] = useState<readonly FundStep[]>([]);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotateResult, setRotateResult] = useState<
    Extract<RotateResponse, { readonly ok: true }>["result"] | null
  >(null);
  const [freeing, setFreeing] = useState(false);
  const [freeError, setFreeError] = useState<string | null>(null);
  const [freeResult, setFreeResult] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<readonly AgentQuoteState[]>([]);
  const [activity, setActivity] = useState<ActivityState>({ status: "loading" });
  const [usage, setUsage] = useState<UsageState>({ status: "loading" });
  const [terms, setTerms] = useState<TermsState>({ status: "loading" });
  const [namespaces, setNamespaces] = useState<readonly NamespaceView[] | null>(
    null,
  );
  const [namespacesError, setNamespacesError] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    try {
      const response = await fetch("/api/agents", { cache: "no-store" });
      const body = (await parseJson(response)) as AgentsResponse;
      if (body.ok) {
        setAgents(body);
        setAgentsError(null);
      } else {
        setAgentsError(body.error);
      }
    } catch (error) {
      setAgentsError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }, []);

  const loadActivity = useCallback(async () => {
    try {
      const activityRes = await fetch("/api/activity", { cache: "no-store" });
      const activityBody = (await parseJson(activityRes)) as ActivityResponse;
      if (activityBody.ok) {
        setActivity({ status: "ready", events: activityBody.events });
      } else {
        setActivity({ status: "error", message: activityBody.error });
      }
    } catch (error) {
      setActivity({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const loadUsage = useCallback(async () => {
    try {
      const response = await fetch("/api/usage", { cache: "no-store" });
      const body = (await parseJson(response)) as UsageResponse;
      if (body.ok) {
        setUsage({
          status: "ready",
          agents: Array.isArray(body.agents) ? body.agents : [],
          settled: body.settled,
          windowHours: body.windowHours,
        });
      } else {
        setUsage({ status: "error", message: body.error });
      }
    } catch (error) {
      setUsage({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const fundDemo = useCallback(async () => {
    setFunding(true);
    setFundError(null);
    try {
      const response = await fetch("/api/agents/fund", {
        method: "POST",
        cache: "no-store",
      });
      const body = (await parseJson(response)) as FundResponse;
      if (body.ok) {
        setFundSteps(body.steps);
        await loadAgents();
        await loadActivity();
      } else {
        setFundError(body.error);
      }
    } catch (error) {
      setFundError(error instanceof Error ? error.message : String(error));
    } finally {
      setFunding(false);
    }
  }, [loadAgents, loadActivity]);

  const rotateDemo = useCallback(async () => {
    setRotating(true);
    setRotateError(null);
    try {
      const response = await fetch("/api/agents/rotate", {
        method: "POST",
        cache: "no-store",
      });
      const body = (await parseJson(response)) as RotateResponse;
      if (body.ok) {
        setRotateResult(body.result);
        setFundSteps([]);
        await loadAgents();
        await loadActivity();
      } else {
        setRotateError(body.error);
      }
    } catch (error) {
      setRotateError(error instanceof Error ? error.message : String(error));
    } finally {
      setRotating(false);
    }
  }, [loadAgents, loadActivity]);

  useEffect(() => {
    void loadAgents();
    void loadUsage();
  }, [loadAgents, loadUsage]);

  // Polling keeps the dashboard live without manual reloads: pool/round
  // state every 10s, on-chain activity every 15s (staggered so the
  // throttle-sensitive RPC readers never fire in the same tick).
  // Orchestrator usage polls every 1s: it is a cheap in-memory read (no
  // RPC), and the per-second tick is what makes live in-flight bars visibly
  // climb while burns run.
  useEffect(() => {
    const agentsTimer = setInterval(() => {
      void loadAgents();
    }, 10_000);
    const usageTimer = setInterval(() => {
      void loadUsage();
    }, 1_000);
    const activityTimer = setInterval(() => {
      void loadActivity();
    }, 15_000);
    return () => {
      clearInterval(agentsTimer);
      clearInterval(usageTimer);
      clearInterval(activityTimer);
    };
  }, [loadAgents, loadUsage, loadActivity]);

  const loadNamespaces = useCallback(async () => {
    try {
      const response = await fetch("/api/ens/namespaces", { cache: "no-store" });
      const body = (await parseJson(response)) as NamespacesResponse;
      if (body.ok) {
        setNamespaces(body.namespaces);
        setNamespacesError(null);
      } else {
        setNamespacesError(body.error);
      }
    } catch (error) {
      setNamespacesError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }, []);

  useEffect(() => {
    void loadNamespaces();
  }, [loadNamespaces]);

  useEffect(() => {
    let cancelled = false;
    async function loadQuotes(): Promise<void> {
      const rows = await Promise.all(
        SEED_META.map(async (seed): Promise<AgentQuoteState> => {
          const base = { wallet: seed.wallet, ensName: seed.ensName };
          try {
            const quoteRes = await fetch(
              `/api/quote?seller=${seed.wallet}`,
              { cache: "no-store" },
            );
            const quoteBody = (await parseJson(quoteRes)) as QuotePayload;
            if (quoteBody.ok) {
              if (quoteBody.empty === true) {
                return { ...base, quote: { status: "empty", reason: quoteBody.reason } };
              }
              const q = quoteBody.quote;
              return {
                ...base,
                quote: {
                  status: "ready",
                  summary:
                    `rate ${q.ratePerMBAtomic} atomic/MB + ${q.ratePerCUAtomic} atomic/CU; ` +
                    `available ${q.availableMB} MB / ${q.availableCU} CU`,
                },
              };
            }
            return { ...base, quote: { status: "error", message: quoteBody.error } };
          } catch (error) {
            return {
              ...base,
              quote: {
                status: "error",
                message: error instanceof Error ? error.message : String(error),
              },
            };
          }
        }),
      );
      if (!cancelled) setQuotes(rows);
    }
    async function loadTerms(): Promise<void> {
      try {
        const termsRes = await fetch("/api/terms", { cache: "no-store" });
        const termsBody = (await parseJson(termsRes)) as TermsPayload;
        if (cancelled) return;
        if (termsBody.ok) {
          setTerms({
            status: "ready",
            body: JSON.stringify(termsBody.terms, null, 2),
          });
        } else {
          setTerms({ status: "error", message: termsBody.error });
        }
      } catch (error) {
        if (!cancelled) {
          setTerms({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    void loadQuotes();
    void loadActivity();
    void loadTerms();
    return () => {
      cancelled = true;
    };
  }, [loadActivity]);

  const freePool = useCallback(async () => {
    if (
      !window.confirm(
        "Reset the demo loop? Containers are revoked, the finished round is closed, and a fresh round opens for new agents.",
      )
    ) {
      return;
    }
    setFreeing(true);
    setFreeError(null);
    setFreeResult(null);
    try {
      const response = await fetch("/api/pools/free", {
        method: "POST",
        cache: "no-store",
      });
      const body = (await parseJson(response)) as FreePoolResponse;
      if (!body.ok) {
        setFreeError(body.error);
        return;
      }
      setFreeResult(JSON.stringify(body.freed) ?? "ok");
      const rotateRes = await fetch("/api/agents/rotate", {
        method: "POST",
        cache: "no-store",
      });
      const rotateBody = (await parseJson(rotateRes)) as RotateResponse;
      if (rotateBody.ok) {
        setRotateResult(rotateBody.result);
        setFundSteps([]);
      } else {
        setRotateError(rotateBody.error);
      }
      await loadAgents();
      await loadActivity();
      await loadUsage();
    } catch (error) {
      setFreeError(error instanceof Error ? error.message : String(error));
    } finally {
      setFreeing(false);
    }
  }, [loadAgents, loadActivity, loadUsage]);

  return (
    <main>
      <header>
        <h1>Coalition — Pool Dashboard</h1>
        <p>
          4-agent funding demo on Arc 5042002. Fund on-chain writes real
          approve+commit transactions via Circle wallets. Live — compute
          usage streams every second, pool state every 10s, on-chain
          activity every 15s.
        </p>
      </header>

      <section className="card" aria-label="Demo controls">
        <h2>Demo controls</h2>
        <p className="fill-label">
          Runs the 4 agents sequentially: live round gate, then real USDC
          approve+commit per Circle wallet. Each step appends in the pool
          controls card with on-chain hashes.
        </p>
        <button
          className="trigger"
          type="button"
          onClick={() => void fundDemo()}
          disabled={funding}
        >
          {funding ? "Funding…" : "Fund on-chain"}
        </button>
        {fundError !== null ? (
          <div className="state state-error" role="alert">
            Fund failed: {fundError}
          </div>
        ) : null}
        <p className="fill-label">
          Outside buyer — held out of the funding loop, prices spare capacity
          via quotes, never commits.
        </p>
        <div className="mono">{OUTSIDE_BUYER.wallet}</div>
        <div className="mono">{OUTSIDE_BUYER.ensName}</div>
      </section>

      <section className="card" aria-label="Pool controls and funding results">
        <h2>Pool controls + funding results</h2>
        <p className="fill-label">
          Free pool resets the whole demo loop in one click: containers are
          revoked, the finished round is closed, and a fresh round opens for
          new agents (provider wallet required for the new round; refused
          with a countdown while a round is still fundable). Rotate pool
          alone only opens the next round without touching containers.
          Steps from the last Fund on-chain run need CIRCLE_* server env.
        </p>
        <button
          className="trigger"
          type="button"
          onClick={() => void freePool()}
          disabled={freeing}
        >
          {freeing ? "Freeing…" : "Free Pool"}
        </button>{" "}
        <button
          className="trigger"
          type="button"
          onClick={() => void rotateDemo()}
          disabled={rotating}
        >
          {rotating ? "Rotating…" : "Rotate pool"}
        </button>
        {freeError !== null ? (
          <div className="state state-error" role="alert">
            Free pool failed: {freeError}
          </div>
        ) : null}
        {freeResult !== null ? (
          <div className="state">Pool freed: {freeResult}</div>
        ) : null}
        {rotateError !== null ? (
          <div className="state state-error" role="alert">
            Rotate failed: {rotateError}
          </div>
        ) : null}
        {rotateResult !== null ? (
          <div className="state">
            Round {rotateResult.closedRoundId} → {rotateResult.newRoundId}
            {rotateResult.finalizeTxHash !== null ? (
              <span className="mono">
                {" "}
                <a
                  href={`${EXPLORER_URL}/tx/${rotateResult.finalizeTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  finalize {shortAddress(rotateResult.finalizeTxHash)}
                </a>
              </span>
            ) : null}{" "}
            <span className="mono">
              <a
                href={`${EXPLORER_URL}/tx/${rotateResult.startRoundTxHash}`}
                target="_blank"
                rel="noreferrer"
              >
                startRound {shortAddress(rotateResult.startRoundTxHash)}
              </a>
            </span>
          </div>
        ) : null}
        {fundSteps.length === 0 ? (
          <div className="state">No funded steps</div>
        ) : (
          <div className="table-wrap">
            <table>
              <tbody>
                {fundSteps.map((step) => (
                  <tr key={step.walletId}>
                    <td className="mono">{shortAddress(step.walletId)}</td>
                    <td>
                      <span
                        className={
                          step.decision === "funded"
                            ? "pill pill-ok"
                            : step.decision === "skipped"
                              ? "pill pill-warn"
                              : "state state-error"
                        }
                      >
                        {step.decision}
                      </span>
                    </td>
                    <td>
                      <span className="fill-label">{step.reason}</span>
                      {step.approveTxHash !== null ? (
                        <div className="mono">
                          <a
                            href={`${EXPLORER_URL}/tx/${step.approveTxHash}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            approve {shortAddress(step.approveTxHash)}
                          </a>
                        </div>
                      ) : null}
                      {step.commitTxHash !== null ? (
                        <div className="mono">
                          <a
                            href={`${EXPLORER_URL}/tx/${step.commitTxHash}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            commit {shortAddress(step.commitTxHash)}
                          </a>
                        </div>
                      ) : null}
                      {step.allocateOk !== undefined ? (
                        <div>
                          <span
                            className={
                              step.allocateOk ? "pill pill-ok" : "pill pill-bad"
                            }
                          >
                            {step.allocateOk
                              ? "allocated"
                              : `allocate failed${step.allocateError !== undefined ? `: ${step.allocateError}` : ""}`}
                          </span>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-label="Pool fill">
        <h2>Pool fill</h2>
        {agentsError !== null ? (
          <div className="state state-error" role="alert">
            Pool state unavailable: {agentsError}
          </div>
        ) : agents === null ? (
          <div className="state">Loading pool state…</div>
        ) : (
          <>
            <div className="mono">{agents.pool}</div>
            <div className="fill-track" aria-hidden="true">
              <div
                className="fill-bar"
                style={{
                  width: `${String(fillPercent(agents.poolState.totalCommitted, agents.poolState.target))}%`,
                }}
              />
            </div>
            <div className="fill-label">
              {formatUsdc(agents.poolState.totalCommitted)} /{" "}
              {formatUsdc(agents.poolState.target)} USDC ·{" "}
              {agents.poolState.participantCount} participant(s) ·{" "}
              {agents.poolState.settled ? "settled" : "open"}
              {agents.poolState.expired ? " · expired" : ""} · source:{" "}
              {agents.poolStateSource}
            </div>
            {agents.note !== undefined ? (
              <div className="state">Degraded read: {agents.note}</div>
            ) : null}
          </>
        )}
      </section>

      <section className="card" aria-label="Live compute usage">
        <h2>Live Compute Usage</h2>
        {usage.status === "loading" ? (
          <div className="state">Loading live usage…</div>
        ) : usage.status === "error" ? (
          <div className="state state-error" role="alert">
            Usage unavailable: {usage.message}
          </div>
        ) : usage.agents.length === 0 ? (
          <div className="state">
            No usage yet — containers appear after settle → allocate.
          </div>
        ) : (
          <>
            <div>
              <span className={usage.settled ? "pill pill-ok" : "pill"}>
                {usage.settled ? "settled" : "open"}
              </span>{" "}
              <span className="fill-label">
                {usage.agents.length} agent(s) · trailing {usage.windowHours}h
                · live every 1s
              </span>
            </div>
            <div>
              <span className="fill-label">
                Settled agents burn compute on their own — bars climb live.
              </span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Slice</th>
                    <th>CU-seconds used vs budget</th>
                    <th>MB-hours used vs budget</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.agents.map((agent) => {
                    const liveCU =
                      agent.cuSeconds + (agent.inFlightCUSeconds ?? 0);
                    const liveMB =
                      agent.mbHours + (agent.inFlightMBHours ?? 0);
                    const livePctCU =
                      agent.budgetCUSeconds > 0
                        ? Math.min(100, (liveCU / agent.budgetCUSeconds) * 100)
                        : 0;
                    const livePctMB =
                      agent.budgetMBHours > 0
                        ? Math.min(100, (liveMB / agent.budgetMBHours) * 100)
                        : 0;
                    const running =
                      (agent.inFlightCUSeconds ?? 0) > 0 ||
                      (agent.inFlightMBHours ?? 0) > 0;
                    const overBudget = livePctCU >= 100 || livePctMB >= 100;
                    return (
                      <tr key={agent.wallet}>
                        <td className="mono">{shortAddress(agent.wallet)}</td>
                        <td>
                          {agent.cpu.toFixed(2)} CPU · {agent.memMB} MB
                        </td>
                        <td>
                          <div className="fill-track" aria-hidden="true">
                            <div
                              className="fill-bar"
                              style={{
                                width: `${String(clampPercent(livePctCU))}%`,
                              }}
                            />
                          </div>
                          <div className="fill-label">
                            {formatUsage(liveCU)} /{" "}
                            {formatUsage(agent.budgetCUSeconds)} CU-s ·{" "}
                            {formatUsage(agent.remainingCUSeconds)} left
                          </div>
                        </td>
                        <td>
                          <div className="fill-track" aria-hidden="true">
                            <div
                              className="fill-bar"
                              style={{
                                width: `${String(clampPercent(livePctMB))}%`,
                              }}
                            />
                          </div>
                          <div className="fill-label">
                            {formatUsage(liveMB)} /{" "}
                            {formatUsage(agent.budgetMBHours)} MB-h ·{" "}
                            {formatUsage(agent.remainingMBHours)} left
                          </div>
                        </td>
                        <td>
                          <span
                            className={
                              overBudget
                                ? "pill pill-bad"
                                : running
                                  ? "pill pill-ok"
                                  : agent.settled
                                    ? "pill pill-ok"
                                    : agent.hasContainer
                                      ? "pill pill-ok"
                                      : "pill pill-warn"
                            }
                          >
                            {overBudget
                              ? "over budget"
                              : running
                                ? "running"
                                : agent.settled
                                  ? "settled"
                                  : agent.hasContainer
                                    ? "active"
                                    : "no container"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        <details>
          <summary className="fill-label">
            Resale pricing ({quotes.length} agents)
          </summary>
          {quotes.length === 0 ? (
            <div className="state">Loading resale quotes…</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Resale quote</th>
                  </tr>
                </thead>
                <tbody>
                  {quotes.map((row) => (
                    <tr key={row.wallet}>
                      <td>
                        <div className="mono">{row.ensName}</div>
                        <div className="mono">{shortAddress(row.wallet)}</div>
                      </td>
                      <td>
                        {row.quote.status === "ready" ? (
                          <span className="fill-label">
                            {row.quote.summary}
                          </span>
                        ) : row.quote.status === "empty" ? (
                          <span className="state">
                            Not allocated — {row.quote.reason}
                          </span>
                        ) : row.quote.status === "error" ? (
                          <span className="state state-error" role="alert">
                            Quote unavailable: {row.quote.message}
                          </span>
                        ) : (
                          <span className="state">Loading…</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      </section>

      <section className="card" aria-label="Live round">
        <h2>Live round</h2>
        {agentsError !== null ? (
          <div className="state state-error" role="alert">
            Round state unavailable: {agentsError}
          </div>
        ) : agents === null ? (
          <div className="state">Loading round state…</div>
        ) : agents.round === undefined ? (
          <div className="state">No round data — refresh pool state.</div>
        ) : (
          <>
            <div>
              <span className="pill pill-ok">Round {agents.round.roundId}</span>{" "}
              <span className="pill">
                {roundResult(agents.round)}
              </span>
            </div>
            <div className="fill-track" aria-hidden="true">
              <div
                className="fill-bar"
                style={{
                  width: `${String(fillPercent(agents.round.totalCommitted, agents.round.target))}%`,
                }}
              />
            </div>
            <div className="fill-label">
              {formatUsdc(agents.round.totalCommitted)} /{" "}
              {formatUsdc(agents.round.target)} USDC ·{" "}
              {agents.round.participantCount} participant(s) ·{" "}
              {formatCountdown(agents.round.deadline)}
            </div>
            <div className="mono">
              deadline{" "}
              {agents.round.deadline === "0"
                ? "—"
                : new Date(
                    Number(BigInt(agents.round.deadline) * 1000n),
                  ).toISOString()}
            </div>
          </>
        )}
      </section>

      <section className="card" aria-label="Round history">
        <h2>Round history</h2>
        {agentsError !== null ? (
          <div className="state state-error" role="alert">
            History unavailable: {agentsError}
          </div>
        ) : agents === null ? (
          <div className="state">Loading round history…</div>
        ) : agents.history === undefined || agents.history.length === 0 ? (
          <div className="state">
            No settled rounds yet — history appears after the first round
            closes.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Round</th>
                  <th>Result</th>
                  <th>Total</th>
                  <th>Participants</th>
                  <th>Pool</th>
                </tr>
              </thead>
              <tbody>
                {agents.history.map((round) => (
                  <tr key={round.roundId}>
                    <td className="mono">{round.roundId}</td>
                    <td>
                      <span
                        className={
                          roundResult(round) === "settled"
                            ? "pill pill-ok"
                            : roundResult(round) === "expired"
                              ? "pill pill-warn"
                              : "pill"
                        }
                      >
                        {roundResult(round)}
                      </span>
                    </td>
                    <td>{formatUsdc(round.totalCommitted)} USDC</td>
                    <td className="mono">{round.participantCount}</td>
                    <td className="mono">
                      <a
                        href={`${EXPLORER_URL}/address/${agents.pool}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {shortAddress(agents.pool)}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-label="Seed agents">
        <h2>Seed agents</h2>
        {agentsError !== null ? (
          <div className="state state-error" role="alert">
            Resolution unavailable: {agentsError}
          </div>
        ) : agents === null ? (
          <div className="state">Resolving ENS identities…</div>
        ) : agents.resolutions.length === 0 ? (
          <div className="state">No seed agents configured.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>ENS name</th>
                  <th>Wallet</th>
                  <th>CPU</th>
                  <th>Mem</th>
                  <th>Share</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {SEED_META.map((seed) => {
                  const resolution = resolutionFor(seed.id, agents.resolutions);
                  return (
                    <tr key={seed.id}>
                      <td>{seed.label}</td>
                      <td className="mono">{seed.ensName}</td>
                      <td className="mono">{shortAddress(seed.wallet)}</td>
                      <td>{seed.cpu.toFixed(2)}</td>
                      <td>{seed.memMB} MB</td>
                      <td>${seed.shareUsdc}</td>
                      <td>
                        {resolution === undefined ? (
                          <span className="pill pill-warn">unknown</span>
                        ) : resolution.status === "resolved" ? (
                          <span
                            className="pill pill-ok"
                            title={`Arc wallet ${resolution.arcWallet}; ${String(resolution.agentCount)} agent id(s)`}
                          >
                            resolved · {resolution.agentCount} id(s)
                          </span>
                        ) : (
                          <span
                            className="pill pill-warn"
                            title={resolution.reason}
                          >
                            skipped
                          </span>
                        )}
                        {resolution?.status === "skipped" ? (
                          <div className="mono">{resolution.reason}</div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-label="Agent namespaces">
        <h2>Agent namespaces</h2>
        <p className="fill-label">
          Each seed subname owns its Permissioned Resolver data on Sepolia and
          links to ERC-8004 agent ids on Arc. Resolver and wallet are read
          live per request — never cached, never hardcoded.
        </p>
        {namespacesError !== null ? (
          <div className="state state-error" role="alert">
            Namespaces unavailable: {namespacesError}
          </div>
        ) : namespaces === null ? (
          <div className="state">Resolving subname namespaces…</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Subname</th>
                  <th>Resolver (Sepolia)</th>
                  <th>Arc wallet</th>
                  <th>ERC-8004 agent ids</th>
                </tr>
              </thead>
              <tbody>
                {namespaces.map((entry) => (
                  <tr key={entry.seedId}>
                    <td className="mono">{entry.name}</td>
                    <td className="mono">
                      {entry.resolver === null ? (
                        <span className="pill pill-warn">no resolver</span>
                      ) : (
                        <a
                          href={`${SEPOLIA_EXPLORER_URL}/address/${entry.resolver}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {shortAddress(entry.resolver)}
                        </a>
                      )}
                    </td>
                    <td className="mono">
                      {entry.arcWallet === null ? (
                        <span className="pill pill-warn">no Arc record</span>
                      ) : (
                        <a
                          href={`${EXPLORER_URL}/address/${entry.arcWallet}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {shortAddress(entry.arcWallet)}
                        </a>
                      )}
                    </td>
                    <td className="mono">
                      {entry.agentIds.length === 0 ? (
                        <span className="pill">none</span>
                      ) : (
                        entry.agentIds.map((id) => (
                          <span key={id}>
                            <a
                              href={`${EXPLORER_URL}/token/${DEFAULT_IDENTITY_REGISTRY}?a=${id}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              #{id}
                            </a>{" "}
                          </span>
                        ))
                      )}
                      {entry.note !== undefined ? (
                        <div className="mono">{entry.note}</div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>


      <section className="card" aria-label="On-chain activity">
        <h2>On-chain activity</h2>
        {activity.status === "loading" ? (
          <div className="state">Loading pool events…</div>
        ) : activity.status === "error" ? (
          <div className="state state-error" role="alert">
            Activity unavailable: {activity.message}
          </div>
        ) : activity.events.length === 0 ? (
          <div className="state">
            No commitments yet — pool awaiting first commit.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Agent</th>
                  <th>Amount</th>
                  <th>Block</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {activity.events.map((event) => (
                  <tr key={`${event.blockNumber}-${event.txHash}-${event.kind}`}>
                    <td>
                      {event.kind}
                      {event.roundId !== undefined
                        ? ` · round ${event.roundId}`
                        : null}
                    </td>
                    <td className="mono">
                      {event.kind === "committed"
                        ? shortAddress(event.agent)
                        : "—"}
                    </td>
                    <td>
                      {event.kind === "committed"
                        ? `${formatUsdc(event.amountAtomic)} USDC`
                        : event.kind === "settled"
                          ? `${formatUsdc(event.totalAtomic)} USDC`
                          : `${formatUsdc(event.targetAtomic)} USDC target`}
                    </td>
                    <td className="mono">{event.blockNumber}</td>
                    <td className="mono">
                      <a
                        href={`${EXPLORER_URL}/tx/${event.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {shortAddress(event.txHash)}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-label="Pool terms">
        <h2>Pool terms</h2>
        {terms.status === "loading" ? (
          <div className="state">Loading terms.json…</div>
        ) : terms.status === "error" ? (
          <div className="state state-error" role="alert">
            Terms unavailable: {terms.message}
          </div>
        ) : (
          <details>
            <summary className="fill-label">View terms.json</summary>
            <pre className="terms">{terms.body}</pre>
          </details>
        )}
      </section>
    </main>
  );
}
