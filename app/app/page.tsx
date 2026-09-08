"use client";

import { useCallback, useEffect, useState } from "react";
import { OUTSIDE_BUYER, SEED_META } from "@/lib/constants";
import type {
  AgentDecision,
  AgentsResponse,
  ResolutionView,
  RunResponse,
} from "@/lib/types";

type QuoteState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly summary: string }
  | { readonly status: "error"; readonly message: string };

type TermsState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly body: string }
  | { readonly status: "error"; readonly message: string };

type QuotePayload =
  | {
      readonly ok: true;
      readonly quote: {
        readonly seller: string;
        readonly payTo: string;
        readonly ratePerMBAtomic: string;
        readonly ratePerCUAtomic: string;
        readonly availableMB: string;
        readonly availableCU: string;
      };
    }
  | { readonly ok: false; readonly error: string };

type TermsPayload =
  | { readonly ok: true; readonly terms: unknown }
  | { readonly ok: false; readonly error: string };

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

function resolutionFor(
  seedId: string,
  resolutions: readonly ResolutionView[],
): ResolutionView | undefined {
  return resolutions.find((entry) => entry.seedId === seedId);
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
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [log, setLog] = useState<readonly AgentDecision[]>([]);
  const [quote, setQuote] = useState<QuoteState>({ status: "loading" });
  const [terms, setTerms] = useState<TermsState>({ status: "loading" });

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

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    let cancelled = false;
    async function loadUsage(): Promise<void> {
      try {
        const quoteRes = await fetch(
          `/api/quote?seller=${SEED_META[0]?.wallet ?? ""}`,
          { cache: "no-store" },
        );
        const quoteBody = (await parseJson(quoteRes)) as QuotePayload;
        if (cancelled) return;
        if (quoteBody.ok) {
          const q = quoteBody.quote;
          setQuote({
            status: "ready",
            summary:
              `seller ${shortAddress(q.seller)} → payTo ${shortAddress(q.payTo)}; ` +
              `rate ${q.ratePerMBAtomic} atomic/MB + ${q.ratePerCUAtomic} atomic/CU; ` +
              `available ${q.availableMB} MB / ${q.availableCU} CU`,
          });
        } else {
          setQuote({ status: "error", message: quoteBody.error });
        }
      } catch (error) {
        if (!cancelled) {
          setQuote({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
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
    void loadUsage();
    return () => {
      cancelled = true;
    };
  }, []);

  const runDemo = useCallback(async () => {
    setRunning(true);
    setRunError(null);
    try {
      const response = await fetch("/api/agents/run", { method: "POST" });
      const body = (await parseJson(response)) as RunResponse;
      if (body.ok) {
        setLog((previous) => [...previous, ...body.decisions]);
        await loadAgents();
      } else {
        setRunError(body.error);
      }
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }, [loadAgents]);

  return (
    <main>
      <header>
        <h1>Coalition — Pool Dashboard</h1>
        <p>
          Deterministic 4-agent funding loop on Arc 5042002. Reads and dry-run
          decisions only — no on-chain writes from this UI.
        </p>
      </header>

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

      <div className="grid-two">
        <section className="card" aria-label="Demo loop trigger">
          <h2>Demo loop</h2>
          <p className="fill-label">
            Runs the 4 seeds sequentially as a dry run (wouldExceedTarget gate,
            null hashes). Each decision appends to the log below.
          </p>
          <button
            className="trigger"
            type="button"
            onClick={() => void runDemo()}
            disabled={running}
          >
            {running ? "Running…" : "Run demo loop"}
          </button>
          {runError !== null ? (
            <div className="state state-error" role="alert">
              Run failed: {runError}
            </div>
          ) : null}
        </section>

        <section className="card" aria-label="Outside buyer">
          <h2>Outside buyer</h2>
          <p className="fill-label">
            Held out of the funding loop — prices spare capacity via quotes,
            never commits.
          </p>
          <div className="mono">{OUTSIDE_BUYER.wallet}</div>
          <div className="mono">{OUTSIDE_BUYER.ensName}</div>
        </section>
      </div>

      <section className="card" aria-label="Decision log">
        <h2>Decision log</h2>
        {log.length === 0 ? (
          <div className="state">
            No decisions yet — press “Run demo loop” to append AgentDecision
            lines.
          </div>
        ) : (
          <div className="log" role="log" aria-live="polite">
            {log
              .map(
                (entry) =>
                  `${entry.agent} ${entry.decision} ${entry.amountAtomic} ` +
                  `fill ${entry.poolFillBefore}→${entry.poolFillAfter} :: ${entry.reason}`,
              )
              .join("\n")}
          </div>
        )}
      </section>

      <div className="grid-two">
        <section className="card" aria-label="Usage and budget">
          <h2>Usage / budget</h2>
          {quote.status === "loading" ? (
            <div className="state">Loading resale quote…</div>
          ) : quote.status === "error" ? (
            <div className="state state-error" role="alert">
              Quote unavailable: {quote.message}
            </div>
          ) : (
            <p className="fill-label">{quote.summary}</p>
          )}
          <p className="fill-label">
            Orchestrator budgets (cpu 0.70/1.0, mem 2800/4096 MB) are enforced
            behind POST /allocate + /run; this panel quotes resale pricing only.
          </p>
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
            <pre className="terms">{terms.body}</pre>
          )}
        </section>
      </div>
    </main>
  );
}
