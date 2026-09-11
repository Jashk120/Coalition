import type { Address } from "viem";

import type { ResolvedAgent } from "../identity/index.js";
import type { AgentId } from "../identity/index.js";
import type { ReputationSummary } from "../reputation/index.js";

/** Thrown when demo seed resolution is misconfigured before any network call. */
export class DemoError extends Error {
  readonly name = "DemoError";
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
  }
}

/**
 * One deterministic demo seed. `ensName` is the live identity
 * (`<label>.agentpool.eth`); `wallet` is retained **only** as the ENS
 * cross-check — live resolution of `ensName` must equal it. There is no
 * wallet fallback: a seed that does not resolve live is `unresolved` and
 * cannot join or fund.
 */
export type DemoSeedAgent = {
  readonly id: string;
  readonly label: string;
  readonly ensName: string;
  readonly wallet: Address;
};

/** Per-agent-id identity + reputation detail behind one seed. */
export type DemoAgentDetail = {
  readonly agentId: AgentId;
  readonly agent: ResolvedAgent;
  /** Aggregate reputation as seen by the configured reviewers. */
  readonly summary: ReputationSummary;
  /** True when an unrevoked `dropout` tag with negative value was found. */
  readonly dropout: boolean;
  /** Reviewer whose feedback carried the dropout tag, if any. */
  readonly dropoutClient: Address | null;
};

/**
 * Resolution outcome per seed, in seed order. `unresolved` is normal output
 * (missing Arc record, wallet mismatch) — never an exception — and carries
 * **no wallet**: ENS is the only identity source, so an unresolved seed is
 * ineligible to join or fund. Callers must not substitute `seed.wallet`.
 */
export type DemoAgentResolution =
  | {
      readonly status: "resolved";
      readonly seed: DemoSeedAgent;
      readonly arcWallet: Address;
      readonly agents: readonly DemoAgentDetail[];
    }
  | {
      readonly status: "unresolved";
      readonly seed: DemoSeedAgent;
      readonly reason: string;
    };
