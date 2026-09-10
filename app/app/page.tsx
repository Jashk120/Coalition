"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
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

type PlanLeg = {
  readonly wallet: string;
  readonly mb: number;
  readonly cuMicro: number;
  readonly amountAtomic: string;
};

type PlanView = {
  readonly sellers: readonly PlanLeg[];
  readonly totalAtomic: string;
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

/** Decimal-string spare amount greater than zero. */
function hasSpareAmount(value: string): boolean {
  try {
    return BigInt(value) > 0n;
  } catch {
    return value !== "" && value !== "0";
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
  const [market, setMarket] = useState<MarketState>({ status: "loading" });
  const [wantMem, setWantMem] = useState("200");
  const [wantCu, setWantCu] = useState("0.05");
  const [plan, setPlan] = useState<PlanState>({ status: "idle" });
  const [buy, setBuy] = useState<BuyState>({ status: "idle" });
  const [walletNames, setWalletNames] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );

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
    void loadMarket();
    void loadWallets();
    return () => {
      cancelled = true;
    };
  }, [loadActivity, loadMarket, loadWallets]);

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

      {resaleLive ? (
      <section className="card" aria-label="Resale market">
        <h2>Resale market</h2>
        <p className="fill-label">
          Spare per agent at cost basis. Agent-5 (outside buyer) previews a
          fill plan, then pays each leg from its own Circle wallet via the
          x402 Gateway flow — no local key. After the buy the buyer lands in
          Live Compute Usage like the other agents.
        </p>
        {market.status === "ready" ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Seller</th>
                  <th>Spare MB / CU</th>
                  <th>Rate (atomic)</th>
                </tr>
              </thead>
              <tbody>
                {market.entries.map((entry) => (
                  <tr key={entry.wallet}>
                    <td className="mono">{displayAgent(entry.wallet)}</td>
                    <td>
                      {entry.empty === true ? (
                        <span className="state">
                          No quota — {entry.reason ?? "not allocated"}
                        </span>
                      ) : (
                        <span className="fill-label">
                          {entry.availableMB} MB / {entry.availableCU} CU-micro
                        </span>
                      )}
                    </td>
                    <td className="mono">
                      {entry.empty === true
                        ? "—"
                        : `${entry.ratePerMBAtomic}/MB + ${entry.ratePerCUAtomic}/CU`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="fill-label">
          Want mem (MB) + CU, preview the fill plan, then pay it leg by leg.
        </p>
        <label className="fill-label">
          mem MB{" "}
          <input
            value={wantMem}
            onChange={(event) => setWantMem(event.target.value)}
            inputMode="numeric"
            aria-label="Wanted memory in MB"
          />
        </label>{" "}
        <label className="fill-label">
          CU{" "}
          <input
            value={wantCu}
            onChange={(event) => setWantCu(event.target.value)}
            inputMode="decimal"
            aria-label="Wanted compute units"
          />
        </label>{" "}
        <button
          className="trigger"
          type="button"
          onClick={() => void previewPlan()}
          disabled={plan.status === "loading" || buy.status === "paying"}
        >
          {plan.status === "loading" ? "Planning…" : "Preview plan"}
        </button>{" "}
        <button
          className="trigger"
          type="button"
          onClick={() => void payPlan()}
          disabled={plan.status !== "ready" || buy.status === "paying"}
        >
          {buy.status === "paying" ? "Paying…" : "Pay via Gateway"}
        </button>
        {plan.status === "error" ? (
          <div className="state state-error" role="alert">
            Plan failed: {plan.message}
          </div>
        ) : null}
        {plan.status === "ready" ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Seller</th>
                  <th>MB</th>
                  <th>CU-micro</th>
                  <th>Cost (USDC)</th>
                </tr>
              </thead>
              <tbody>
                {plan.plan.sellers.map((leg) => (
                  <tr key={leg.wallet}>
                    <td className="mono">{displayAgent(leg.wallet)}</td>
                    <td className="mono">{leg.mb}</td>
                    <td className="mono">{leg.cuMicro}</td>
                    <td className="mono">{formatUsdc(leg.amountAtomic)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="fill-label">
              Total {formatUsdc(plan.plan.totalAtomic)} USDC across{" "}
              {plan.plan.sellers.length} leg(s)
            </div>
          </div>
        ) : null}
        {buy.status === "error" ? (
          <div className="state state-error" role="alert">
            Buy failed: {buy.message}
          </div>
        ) : null}
        {buy.status === "ready" ? (
          <div className="state">
            Bought {buy.result.legsPaid} leg(s) for{" "}
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
        <p className="fill-label">
          Free pool resets the whole demo loop in one click: containers are
          revoked, the finished round is closed, and a fresh round opens for
          new agents (provider wallet required for the new round; refused
          with a countdown while a round is still fundable).
          Steps from the last Fund on-chain run need CIRCLE_* server env.
        </p>
        <button
          className="trigger"
          type="button"
          onClick={() => void freePool()}
          disabled={freeing}
        >
          {freeing ? "Freeing…" : "Free Pool"}
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
                    <td className="mono">{displayAgent(step.walletId)}</td>
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
                        ? displayAgent(event.agent)
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
