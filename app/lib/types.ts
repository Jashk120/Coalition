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

/** One round-scoped funding snapshot. Amounts are atomic-unit decimal strings. */
export type RoundView = {
  readonly roundId: string;
  readonly target: string;
  readonly totalCommitted: string;
  readonly settled: boolean;
  readonly expired: boolean;
  readonly deadline: string;
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
      readonly round?: RoundView;
      readonly roundId?: string;
      readonly deadline?: string;
      readonly history?: readonly RoundView[];
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
  readonly roundId?: string;
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
      readonly roundId?: string;
      readonly decisions: readonly AgentDecision[];
    }
  | { readonly ok: false; readonly error: string };

/** One on-chain pool event (amounts are atomic-unit decimal strings). */
export type ActivityEvent =
  | {
      readonly kind: "committed";
      readonly agent: string;
      readonly amountAtomic: string;
      readonly roundId?: string;
      readonly blockNumber: string;
      readonly txHash: string;
    }
  | {
      readonly kind: "settled";
      readonly totalAtomic: string;
      readonly roundId?: string;
      readonly blockNumber: string;
      readonly txHash: string;
    }
  | {
      readonly kind: "round-started";
      readonly roundId: string;
      readonly targetAtomic: string;
      readonly deadline: string;
      readonly blockNumber: string;
      readonly txHash: string;
    };

export type ActivityResponse =
  | {
      readonly ok: true;
      readonly pool: string;
      readonly events: readonly ActivityEvent[];
    }
  | { readonly ok: false; readonly error: string };

export type FundStep = { readonly walletId: string; readonly decision: "funded" | "skipped" | "failed"; readonly reason: string; readonly roundId?: string; readonly approveTxHash: string | null; readonly commitTxHash: string | null };
export type FundResponse = { readonly ok: true; readonly pool: string; readonly roundId?: string; readonly steps: readonly FundStep[] } | { readonly ok: false; readonly error: string };
