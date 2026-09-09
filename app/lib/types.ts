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

export type FundStep = { readonly walletId: string; readonly decision: "funded" | "skipped" | "failed"; readonly reason: string; readonly roundId?: string; readonly approveTxHash: string | null; readonly commitTxHash: string | null; readonly allocateOk?: boolean; readonly allocateError?: string };
export type FundResponse = { readonly ok: true; readonly pool: string; readonly roundId?: string; readonly steps: readonly FundStep[] } | { readonly ok: false; readonly error: string };

export type RotateResult = { readonly closedRoundId: string; readonly newRoundId: string; readonly finalizeTxHash: string | null; readonly startRoundTxHash: string };
export type RotateResponse = { readonly ok: true; readonly pool: string; readonly result: RotateResult } | { readonly ok: false; readonly error: string };

/** One discovered pool (JSON-safe; mirrors SDK `DiscoveredPool`). */
export type NamespaceView = {
  readonly seedId: string;
  readonly name: string;
  /**
   * Live Permissioned Resolver address, looked up fresh per request.
   * Null when the name has no resolver (zero address) — explicit empty
   * state showing live chain truth, never a hardcoded fallback.
   */
  readonly resolver: string | null;
  /**
   * Live Arc wallet from the subname's multicoin record. Null when the
   * name has no Arc record — explicit empty state, never the seed wallet.
   */
  readonly arcWallet: string | null;
  /** ERC-8004 agent ids owned by `arcWallet` (decimal strings, bigint-safe). Empty when unresolved. */
  readonly agentIds: readonly string[];
  /** Present when a hop failed or resolved empty (why the null/empty). */
  readonly note?: string;
};

export type NamespacesResponse =
  | {
      readonly ok: true;
      readonly ensParent: string;
      readonly namespaces: readonly NamespaceView[];
    }
  | { readonly ok: false; readonly error: string };export type DiscoveredPoolView = {
  readonly pool: string;
  readonly chainId: number;
  readonly resourceURI: string;
  readonly target: string;
  readonly totalCommitted: string;
  readonly settled: boolean;
  readonly roundId: string;
  readonly source: "explicit" | "subgraph" | "singleton";
  readonly ensParent: string;
};

export type PoolsResponse =
  | {
      readonly ok: true;
      readonly chainId: number;
      readonly ensParent: string;
      readonly pools: readonly DiscoveredPoolView[];
      readonly note?: string;
    }
  | { readonly ok: false; readonly error: string };

/** Orchestrator container-pool reset relay (POST /api/pools/free → POST /free-pool). */
export type FreePoolResponse =
  | { readonly ok: true; readonly freed: unknown }
  | { readonly ok: false; readonly error: string };

/**
 * Per-agent compute usage snapshot from the orchestrator (GET /usage).
 * Plain JSON numbers — no bigints cross this endpoint.
 */
export type AgentUsageView = {
  readonly wallet: string;
  readonly cpu: number;
  readonly memMB: number;
  readonly cuSeconds: number;
  readonly mbHours: number;
  readonly inFlightCUSeconds?: number;
  readonly inFlightMBHours?: number;
  readonly budgetCUSeconds: number;
  readonly budgetMBHours: number;
  readonly remainingCUSeconds: number;
  readonly remainingMBHours: number;
  readonly percentUsedCU: number;
  readonly percentUsedMB: number;
  readonly hasContainer: boolean;
  readonly settled: boolean;
};

/** Orchestrator usage relay (GET /api/usage → GET /usage). Public, no APP_KEY. */
export type UsageResponse =
  | {
      readonly ok: true;
      readonly agents: readonly AgentUsageView[];
      readonly settled: boolean;
      readonly windowHours: number;
    }
  | { readonly ok: false; readonly error: string };

/**
 * ENSv2 Enhanced Access Control demo (POST /api/ens/delegate):
 * grant → agent write → revoke → revoked write fails. Hashes are 0x tx hashes;
 * revokedWriteError carries the captured revert as proof the grant was loadbearing.
 */
export type EnsDelegateResponse =
  | {
      readonly ok: true;
      readonly name: string;
      readonly agentWallet: string;
      readonly resolver: string;
      readonly coinType: number;
      readonly grantTxHash: string;
      readonly writeTxHash: string;
      readonly revokeTxHash: string;
      readonly revokedWriteError: string;
    }
  | { readonly ok: false; readonly error: string };
