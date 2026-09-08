/**
 * JSON-safe view types shared by the API routes and the dashboard page.
 * Bigints cross the wire as decimal strings (JSON cannot carry bigint).
 */

/** Pool funding snapshot. Amounts are atomic-unit decimal strings. */
export type PoolStateView = {
  readonly target: string;
  readonly totalCommitted: string;
  readonly settled: boolean;
  readonly expired: boolean;
  readonly participantCount: string;
};

export type ResolutionView =
  | {
      readonly seedId: string;
      readonly status: "resolved";
      readonly arcWallet: string;
      readonly agentCount: number;
    }
  | {
      readonly seedId: string;
      readonly status: "skipped";
      readonly reason: string;
      readonly fallbackWallet: string;
    };

export type AgentsResponse =
  | {
      readonly ok: true;
      readonly pool: string;
      readonly chainId: number;
      readonly resolutions: readonly ResolutionView[];
      readonly poolState: PoolStateView;
      readonly poolStateSource: "subgraph" | "chain" | "fallback";
      readonly buyer: { readonly wallet: string; readonly ensName: string };
      readonly note?: string;
    }
  | { readonly ok: false; readonly error: string };

/** One dry-run decision line (see plans/agent-loop.md §2b). No chain writes. */
export type AgentDecision = {
  readonly agent: string;
  readonly decision: "join" | "skip";
  readonly reason: string;
  readonly amountAtomic: string;
  readonly poolFillBefore: string;
  readonly poolFillAfter: string;
  readonly approveHash: null;
  readonly commitHash: null;
};

export type RunResponse =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly agents: number;
      readonly mode: "sequential";
      readonly dryRun: true;
      readonly decisions: readonly AgentDecision[];
    }
  | { readonly ok: false; readonly error: string };
