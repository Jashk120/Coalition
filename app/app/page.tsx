"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { DEFAULT_IDENTITY_REGISTRY } from "@jx-nexus/coalition";
import { EXPLORER_URL, OUTSIDE_BUYER, SEED_META } from "@/lib/constants";
import ThemeToggle from "./theme-toggle";
import type {
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

type TermsState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly body: string }
  | { readonly status: "error"; readonly message: string };

type MarketEntry = {
  readonly wallet: string;
  readonly availableMB: string;
  readonly availableCU: string;
  readonly ratePerMBAtomic: string;
  readonly ratePerCUAtomic: string;
  readonly empty?: boolean;
  readonly reason?: string;
};

type MarketState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly entries: readonly MarketEntry[] }
  | { readonly status: "error"; readonly message: string };

type PlanOutput = {
  readonly account: string;
  readonly amountAtomic: string;
};

type PlanView = {
  readonly outputs: readonly PlanOutput[];
  readonly totalAtomic: string;
  readonly nonce: string;
  readonly roundId: string;
  readonly headroomMB: number;
  readonly headroomCUMicro: number;
  readonly want?: { readonly mem: number; readonly cuMicro: number };
};

type PlanState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly plan: PlanView }
  | { readonly status: "error"; readonly message: string };

type BuyResult = {
  readonly buyer: string;
  readonly legsPaid: number;
  readonly totalAtomic: string;
  readonly to: unknown;
  readonly toToken?: string;
};

type BuyState =
  | { readonly status: "idle" }
  | { readonly status: "paying" }
  | { readonly status: "ready"; readonly result: BuyResult }
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

type TermsPayload =
  | { readonly ok: true; readonly terms: unknown }
  | { readonly ok: false; readonly error: string };

const SEPOLIA_EXPLORER_URL = "https://sepolia.etherscan.io";

function shortAddress(address: string): string {
  return address.length > 12
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : address;
}

/** Decimal-string spare amount greater than zero. */
function hasSpareAmount(value: string): boolean {
  try {
    return BigInt(value) > 0n;
  } catch {
    return value !== "" && value !== "0";
  }
}

function sharePercent(amountAtomic: string, totalAtomic: string): string {
  try {
    const amount = BigInt(amountAtomic);
    const total = BigInt(totalAtomic);
    if (total === 0n) return "0.00";
    const basisPoints = Number((amount * 10000n) / total) / 100;
    return basisPoints.toFixed(2);
  } catch {
    return "—";
  }
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

function roundResult(round: RoundView): "settled" | "expired" | "open" {
  if (round.settled) return "settled";
  if (round.expired) return "expired";
  return "open";
}

function isClosedRoundSkip(step: FundStep): boolean {
  return step.decision === "skipped" && /settled\/expired/i.test(step.reason);
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
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotateResult, setRotateResult] = useState<
    Extract<RotateResponse, { readonly ok: true }>["result"] | null
  >(null);
  const [freeing, setFreeing] = useState(false);
  const [freeError, setFreeError] = useState<string | null>(null);
  const [freeResult, setFreeResult] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageState>({ status: "loading" });
  const [terms, setTerms] = useState<TermsState>({ status: "loading" });
  const [namespaces, setNamespaces] = useState<readonly NamespaceView[] | null>(
    null,
  );
  const [namespacesError, setNamespacesError] = useState<string | null>(null);
  const [market, setMarket] = useState<MarketState>({ status: "loading" });
  const [wantMem, setWantMem] = useState("200");
  const [wantCu, setWantCu] = useState("0.05");
  const [plan, setPlan] = useState<PlanState>({ status: "idle" });
  const [buy, setBuy] = useState<BuyState>({ status: "idle" });
  const [walletNames, setWalletNames] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [railOpen, setRailOpen] = useState(false);

  const displayAgent = (address: string): ReactNode => {
    const name =
      walletNames.get(address.toLowerCase()) ?? shortAddress(address);
    return <span title={address}>{name}</span>;
  };

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

  const loadMarket = useCallback(async () => {
    try {
      const response = await fetch("/api/resale/market", { cache: "no-store" });
      const body = (await parseJson(response)) as
        | { readonly ok: true; readonly market: readonly MarketEntry[] }
        | { readonly ok: false; readonly error: string };
      if (body.ok) {
        setMarket({ status: "ready", entries: body.market });
      } else {
        setMarket({ status: "error", message: body.error });
      }
    } catch (error) {
      setMarket({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const loadWallets = useCallback(async () => {
    try {
      const response = await fetch("/api/agents/wallets", {
        cache: "no-store",
      });
      const body = (await parseJson(response)) as
        | {
            readonly ok: true;
            readonly names: readonly {
              readonly address: string;
              readonly ensName: string;
            }[];
          }
        | { readonly ok: false; readonly error: string };
      if (body.ok) {
        setWalletNames(
          new Map(
            body.names.map((entry) => [
              entry.address.toLowerCase(),
              entry.ensName,
            ]),
          ),
        );
      }
    } catch {
      return;
    }
  }, []);

  const loadTerms = useCallback(async () => {
    try {
      const termsRes = await fetch("/api/terms", { cache: "no-store" });
      const termsBody = (await parseJson(termsRes)) as TermsPayload;
      if (termsBody.ok) {
        setTerms({
          status: "ready",
          body: JSON.stringify(termsBody.terms, null, 2),
        });
      } else {
        setTerms({ status: "error", message: termsBody.error });
      }
    } catch (error) {
      setTerms({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const previewPlan = useCallback(async () => {
    setPlan({ status: "loading" });
    setBuy({ status: "idle" });
    try {
      const mem = Number.parseInt(wantMem, 10);
      const cu = Number.parseFloat(wantCu);
      const response = await fetch("/api/resale/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: OUTSIDE_BUYER.wallet, mem, cu }),
        cache: "no-store",
      });
      const body = (await parseJson(response)) as
        | { readonly ok: true; readonly plan: PlanView }
        | { readonly ok: false; readonly error: string };
      if (body.ok) {
        setPlan({ status: "ready", plan: body.plan });
      } else {
        setPlan({ status: "error", message: body.error });
      }
    } catch (error) {
      setPlan({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [wantMem, wantCu]);

  const payPlan = useCallback(async () => {
    if (plan.status !== "ready") return;
    setBuy({ status: "paying" });
    try {
      const response = await fetch("/api/resale/buy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: plan.plan }),
        cache: "no-store",
      });
      const body = (await parseJson(response)) as
        | {
            readonly ok: true;
            readonly buyer: string;
            readonly legsPaid: number;
            readonly totalAtomic: string;
            readonly to: unknown;
            readonly toToken?: string;
          }
        | { readonly ok: false; readonly error: string };
      if (body.ok) {
        setBuy({
          status: "ready",
          result: {
            buyer: body.buyer,
            legsPaid: body.legsPaid,
            totalAtomic: body.totalAtomic,
            to: body.to,
            ...(body.toToken === undefined ? {} : { toToken: body.toToken }),
          },
        });
        await loadUsage();
        await loadMarket();
      } else {
        setBuy({ status: "error", message: body.error });
      }
    } catch (error) {
      setBuy({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [plan, loadUsage, loadMarket]);

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
        await loadUsage();
        await loadMarket();
      } else {
        setFundError(body.error);
      }
    } catch (error) {
      setFundError(error instanceof Error ? error.message : String(error));
    } finally {
      setFunding(false);
    }
  }, [loadAgents, loadUsage, loadMarket]);

  useEffect(() => {
    void loadAgents();
    void loadUsage();
  }, [loadAgents, loadUsage]);

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

  // Polling keeps the dashboard live without manual reloads: pool/round
  // state plus resale market every 10s, wallet names every 30s, ENS
  // namespaces and terms every 60s (identity changes rarely; cached
  // server-side too).
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
    const marketTimer = setInterval(() => {
      void loadMarket();
    }, 10_000);
    const walletsTimer = setInterval(() => {
      void loadWallets();
    }, 30_000);
    const namespacesTimer = setInterval(() => {
      void loadNamespaces();
    }, 60_000);
    const termsTimer = setInterval(() => {
      void loadTerms();
    }, 60_000);
    return () => {
      clearInterval(agentsTimer);
      clearInterval(usageTimer);
      clearInterval(marketTimer);
      clearInterval(walletsTimer);
      clearInterval(namespacesTimer);
      clearInterval(termsTimer);
    };
  }, [
    loadAgents,
    loadUsage,
    loadMarket,
    loadWallets,
    loadNamespaces,
    loadTerms,
  ]);

  useEffect(() => {
    void loadNamespaces();
  }, [loadNamespaces]);

  useEffect(() => {
    void loadTerms();
    void loadMarket();
    void loadWallets();
  }, [loadMarket, loadTerms, loadWallets]);

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
      await loadUsage();
      await loadMarket();
    } catch (error) {
      setFreeError(error instanceof Error ? error.message : String(error));
    } finally {
      setFreeing(false);
    }
  }, [loadAgents, loadUsage, loadMarket]);

  // Resale shows whenever someone actually holds spare: an empty market
  // (no allocations, or fully-used slices) has nothing to sell, so the
  // section stays hidden instead of showing no-quota rows and a plan form
  // that can only 409. No settled requirement — the orchestrator settles
  // quota pre-settle too; only the funding endpoints close. A market
  // backend error stays visible so failures are diagnosable. Market polling
  // continues while hidden so the section appears as soon as spare lands.
  const resaleLive =
    market.status === "error" ||
    (market.status === "ready" &&
      market.entries.some(
        (entry) =>
          entry.empty !== true &&
          (hasSpareAmount(entry.availableMB) ||
            hasSpareAmount(entry.availableCU)),
      ));

  // KPI strip + merged Pool card derive from existing state only — no new
  // fetches. Round data wins when present, otherwise fall back to poolState.
  const poolView =
    agents === null
      ? null
      : {
          committed:
            agents.round?.totalCommitted ?? agents.poolState.totalCommitted,
          target: agents.round?.target ?? agents.poolState.target,
          participants:
            agents.round?.participantCount ?? agents.poolState.participantCount,
          status:
            agents.round !== undefined
              ? roundResult(agents.round)
              : `${agents.poolState.settled ? "settled" : "open"}${agents.poolState.expired ? " · expired" : ""}`,
          source: agents.poolStateSource,
          roundId: agents.round?.roundId,
          poolAddress: agents.pool,
          note: agents.note,
        };

  const poolFillPct =
    poolView === null ? null : fillPercent(poolView.committed, poolView.target);

  const liveCuTotals =
    usage.status === "ready"
      ? {
          used: usage.agents.reduce(
            (sum, agent) => sum + agent.cuSeconds + (agent.inFlightCUSeconds ?? 0),
            0,
          ),
          budget: usage.agents.reduce(
            (sum, agent) => sum + agent.budgetCUSeconds,
            0,
          ),
        }
      : null;

  return (
    <>
      <header className="site-header">
        <div className="site-header-inner">
          <div className="brand">
            <img
              src="/coalition-logo.png"
              alt="Coalition logo"
              className="brand-logo"
              width={40}
              height={40}
            />
            <div>
              <h1 className="brand-title">
                Coalition <span className="brand-accent">— Pool Dashboard</span>
              </h1>
              <p className="brand-subtitle">
                4-agent funding demo on Arc 5042002 · compute streams every
                1s · pool + market every 10s
              </p>
            </div>
          </div>
          <button
            className="btn btn-secondary rail-toggle"
            type="button"
            onClick={() => setRailOpen((open) => !open)}
            aria-expanded={railOpen}
            aria-controls="demo-rail"
          >
            {railOpen ? "Hide demo controls" : "Demo controls"}
          </button>
          <ThemeToggle />
        </div>
      </header>
      <main>
        <div className="app-shell">
          <aside
            className={railOpen ? "rail rail-open" : "rail"}
            id="demo-rail"
            aria-label="Demo controls for judges"
          >
            <span className="rail-badge">Demo · for judges</span>
            <div className="rail-body">
              <section className="card" aria-label="Demo controls">
        <h2>Demo controls</h2>
        <p className="card-lede">
          Run the 4-agent on-chain funding loop, then inspect each step below.
        </p>
        <details>
          <summary>How it works</summary>
          <div className="details-body">
            Runs the 4 agents sequentially: live round gate, then real USDC
            approve+commit per Circle wallet. Each step appends in the pool
            controls card with on-chain hashes.
          </div>
        </details>
        <div className="card-actions">
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => void fundDemo()}
            disabled={funding}
          >
            {funding ? "Funding…" : "Fund on-chain"}
          </button>
        </div>
        {fundError !== null ? (
          <div className="state state-error" role="alert">
            Fund failed: {fundError}
          </div>
        ) : null}
        <p className="fill-label" title="Held out of the funding loop; prices spare capacity via quotes and never commits.">
          Outside buyer — held out of the funding loop, prices spare capacity
          via quotes, never commits.
        </p>
        <div className="mono">{OUTSIDE_BUYER.wallet}</div>
        <div className="mono">{OUTSIDE_BUYER.ensName}</div>
      </section>

      {resaleLive ? (
      <section className="card card-trade" aria-label="Resale market">
        <h2>Resale market</h2>
        <p className="card-lede">
          Preview a fill plan for spare capacity, then settle it in one atomic payment.
        </p>
        <details>
          <summary>How it works</summary>
          <div className="details-body">
            Unallocated pool headroom, split skew-weighted across the 4
            agents. Agent-5 (outside buyer) previews a fill plan, then pays
            every share in one atomic settlement from its own Circle wallet —
            either all agents are paid or none are. After the buy the buyer
            lands in Live Compute Usage like the other agents.
          </div>
        </details>
        {market.status === "error" ? (
          <div className="state state-error" role="alert">
            Market unavailable: {market.message}
          </div>
        ) : null}
        <p
          className="fill-label"
          title="Set wanted memory and compute, preview the fill plan, then pay it in one settlement."
        >
          Want mem (MB) + CU, preview the fill plan, then pay it in one
          settlement.
        </p>
        <div className="card-actions">
          <label className="field">
            mem MB{" "}
            <input
              value={wantMem}
              onChange={(event) => setWantMem(event.target.value)}
              inputMode="numeric"
              aria-label="Wanted memory in MB"
            />
          </label>{" "}
          <label className="field">
            CU{" "}
            <input
              value={wantCu}
              onChange={(event) => setWantCu(event.target.value)}
              inputMode="decimal"
              aria-label="Wanted compute units"
            />
          </label>{" "}
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => void previewPlan()}
            disabled={plan.status === "loading" || buy.status === "paying"}
          >
            {plan.status === "loading" ? "Planning…" : "Preview plan"}
          </button>{" "}
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => void payPlan()}
            disabled={plan.status !== "ready" || buy.status === "paying"}
          >
            {buy.status === "paying" ? "Paying…" : "Pay plan"}
          </button>
        </div>
        {plan.status === "error" ? (
          <div className="state state-error" role="alert">
            Plan failed: {plan.message}
          </div>
        ) : null}
        {plan.status === "ready" ? (
          <div className="plan">
            <div className="fill-label">Pool headroom {plan.plan.headroomMB} MB / {plan.plan.headroomCUMicro} CU-micro · round {plan.plan.roundId}</div>
            <ul className="plan-list">
              {plan.plan.outputs.map((output) => (
                <li className="plan-row" key={output.account}>
                  <span className="plan-agent mono">{displayAgent(output.account)}</span>
                  <span className="plan-meta">
                    <span className="plan-share hint">{sharePercent(output.amountAtomic, plan.plan.totalAtomic)}%</span>
                    <span className="plan-amount mono num">{formatUsdc(output.amountAtomic)} USDC</span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="fill-label">Total {formatUsdc(plan.plan.totalAtomic)} USDC across {plan.plan.outputs.length} agent(s)</div>
          </div>
        ) : null}
        {buy.status === "error" ? (
          <div className="state state-error" role="alert">
            Buy failed: {buy.message}
          </div>
        ) : null}
        {buy.status === "ready" ? (
          <div className="state">
            Bought {buy.result.legsPaid} payout(s) for{" "}
            {formatUsdc(buy.result.totalAtomic)} USDC — buyer{" "}
            <span className="mono">{displayAgent(buy.result.buyer)}</span>{" "}
            holds quota (see Live Compute Usage).
            {buy.result.toToken !== undefined ? (
              <div className="mono">token {buy.result.toToken}</div>
            ) : null}
          </div>
        ) : null}
      </section>
      ) : null}

      <section className="card" aria-label="Pool controls and funding results">
        <h2>Pool controls + funding results</h2>
        <p className="card-lede">
          Reset the demo loop in one click, then review the last funding run.
        </p>
        <details>
          <summary>How it works</summary>
          <div className="details-body">
            Free pool resets the whole demo loop in one click: containers
            are revoked, the finished round is closed, and a fresh round
            opens for new agents (provider wallet required for the new
            round; refused with a countdown while a round is still
            fundable). Steps from the last Fund on-chain run need CIRCLE_*
            server env.
          </div>
        </details>
        <div className="card-actions">
          <button
            className="btn btn-danger"
            type="button"
            onClick={() => void freePool()}
            disabled={freeing}
          >
            {freeing ? "Freeing…" : "Free Pool"}
          </button>
        </div>
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
                    <td className="mono">{displayAgent(step.walletId)}</td>
                    <td>
                      <span
                        className={
                          isClosedRoundSkip(step)
                            ? "pill"
                            : step.decision === "funded"
                              ? "pill pill-ok"
                              : step.decision === "skipped"
                                ? "pill pill-warn"
                                : "state state-error"
                        }
                      >
                        {isClosedRoundSkip(step) ? "round closed" : step.decision}
                      </span>
                    </td>
                    <td>
                      <span className="fill-label">
                        {isClosedRoundSkip(step)
                          ? `round ${step.roundId ?? "—"} settled/expired`
                          : step.reason}
                      </span>
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
                      {step.ensAttested !== undefined ? (
                        <div>
                          <span
                            className={
                              step.ensAttested ? "pill pill-ok" : "pill pill-bad"
                            }
                            title={
                              step.ensWallet === null ||
                              step.ensWallet === undefined
                                ? `no ENS Arc record for ${step.ensName ?? "?"}`
                                : `ENS ${step.ensName ?? "?"} → ${step.ensWallet}; funder ${step.funderWallet ?? "?"}`
                            }
                          >
                            {step.ensAttested ? "ENS attested" : "ENS unattested"}
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
            </div>
          </aside>
          <div className="main-canvas">
            <ul className="kpi-strip" aria-label="Key metrics">
              <li className="kpi">
                <div className="kpi-label">Pool fill</div>
                <div className="kpi-value num">
                  {agentsError !== null
                    ? "—"
                    : poolFillPct === null
                      ? "…"
                      : `${poolFillPct}%`}
                </div>
                <div className="kpi-sub">
                  {poolView === null
                    ? "Loading pool state…"
                    : `${formatUsdc(poolView.committed)} / ${formatUsdc(poolView.target)} USDC`}
                </div>
              </li>
              <li className="kpi">
                <div className="kpi-label">Participants</div>
                <div className="kpi-value num">
                  {agentsError !== null
                    ? "—"
                    : poolView === null
                      ? "…"
                      : poolView.participants}
                </div>
                <div className="kpi-sub">
                  {poolView?.roundId !== undefined && poolView.roundId !== null
                    ? `Round ${poolView.roundId}`
                    : "Across all rounds"}
                </div>
              </li>
              <li className="kpi">
                <div className="kpi-label">Round status</div>
                <div className="kpi-value">
                  {agentsError !== null
                    ? "Unavailable"
                    : poolView === null
                      ? "…"
                      : poolView.status}
                </div>
              </li>
              <li className="kpi">
                <div className="kpi-label">Live compute burn</div>
                <div className="kpi-value num">
                  {liveCuTotals === null ? "…" : formatUsage(liveCuTotals.used)}
                </div>
                <div className="kpi-sub">
                  {usage.status === "ready"
                    ? `of ${formatUsage(liveCuTotals?.budget ?? 0)} CU-s budget · ${usage.agents.length} agent(s) · trailing ${usage.windowHours}h`
                    : usage.status === "error"
                      ? `Usage unavailable: ${usage.message}`
                      : "Loading live usage…"}
                </div>
              </li>
            </ul>

            <section className="card" aria-label="Pool">
        <h2>Pool</h2>
        {agentsError !== null ? (
          <div className="state state-error" role="alert">
            Pool state unavailable: {agentsError}
          </div>
        ) : poolView === null ? (
          <div className="state">Loading pool state…</div>
        ) : (
          <>
            <div className="pool-status">
              {poolView.roundId !== undefined ? (
                <>
                  <span className="pill pill-ok">
                    Round {poolView.roundId}
                  </span>{" "}
                  <span className="pill">{poolView.status}</span>
                </>
              ) : (
                <span className="pill">{poolView.status}</span>
              )}
              <span className="pool-source">source: {poolView.source}</span>
            </div>
            <div className="mono">{poolView.poolAddress}</div>
            <div className="fill-track" aria-hidden="true">
              <div
                className="fill-bar"
                style={{
                  width: `${String(fillPercent(poolView.committed, poolView.target))}%`,
                }}
              />
            </div>
            <div className="pool-detail">
              <span>
                <strong className="num">
                  {formatUsdc(poolView.committed)} / {formatUsdc(poolView.target)}
                </strong>{" "}
                USDC
              </span>
              <span>
                <strong className="num">{poolView.participants}</strong>{" "}
                participant(s)
              </span>
            </div>
            {poolView.note !== undefined ? (
              <div className="state">Degraded read: {poolView.note}</div>
            ) : null}
          </>
        )}
      </section>

      <section className="card card-centerpiece" aria-label="Live compute usage">
        <h2>Live Compute Usage</h2>
        <p className="card-lede">
          Settled agents burn compute on their own — bars climb live.
        </p>
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
              <span
                className="fill-label"
                title="Settled agents burn compute on their own — bars climb live."
              >
                {usage.agents.length} agent(s) · trailing {usage.windowHours}h
                · live every 1s
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
                        <td className="mono">{displayAgent(agent.wallet)}</td>
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
                  <th className="num">Total</th>
                  <th className="num">Participants</th>
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
                    <td className="num">{formatUsdc(round.totalCommitted)} USDC</td>
                    <td className="mono num">{round.participantCount}</td>
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

      <section className="identity-stack" aria-label="Identity">
        <section className="card" aria-label="Seed agents">
          <h2>Seed agents</h2>
          <p className="card-lede">The 4 deterministic funding members.</p>
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
                  <th className="num">CPU</th>
                  <th className="num">Mem</th>
                  <th className="num">Share</th>
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
                      <td className="num">{seed.cpu.toFixed(2)}</td>
                      <td className="num">{seed.memMB} MB</td>
                      <td className="num">${seed.shareUsdc}</td>
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
                            unresolved
                          </span>
                        )}
                        {resolution?.status === "unresolved" ? (
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
        <p className="card-lede">On-chain identity links per seed subname.</p>
        <details>
          <summary>Where this comes from</summary>
          <div className="details-body">
            Each seed subname owns its Permissioned Resolver data on Sepolia
            and links to ERC-8004 agent ids on Arc. Resolver and wallet are
            read live per request — never cached, never hardcoded.
          </div>
        </details>
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
            <summary>View terms.json</summary>
            <pre className="terms">{terms.body}</pre>
            </details>
        )}
            </section>
          </div>
        </div>
      </main>
    </>
  );
}
