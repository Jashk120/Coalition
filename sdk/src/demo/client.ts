import type { Address, PublicClient } from "viem";

import { resolveEnsToAgents } from "../ens/index.js";
import type { AgentId } from "../identity/index.js";
import { resolveAgent } from "../identity/index.js";
import { getReputationSummary, readFeedback } from "../reputation/index.js";
import type { FeedbackEntry } from "../reputation/index.js";
import { DemoError } from "./types.js";
import type {
  DemoAgentDetail,
  DemoAgentResolution,
  DemoSeedAgent,
} from "./types.js";

export type ResolveSeedAgentsParams = {
  /** Sepolia client for the ENS → Arc hop. */
  readonly sepoliaClient: PublicClient;
  /** Arc client for wallet → agent-id → reputation reads. */
  readonly arcClient: PublicClient;
  /** Seeds in run order; resolution preserves this order. */
  readonly seeds: readonly DemoSeedAgent[];
  /**
   * Reviewers to aggregate reputation over. Must be non-empty (Sybil rule,
   * enforced before any network call): pool provider + committed peers.
   */
  readonly reviewers: readonly Address[];
  readonly tag1?: string;
  readonly tag2?: string;
  readonly coinType?: number;
  readonly identityRegistry?: Address;
  readonly reputationRegistry?: Address;
  /**
   * First block of the wallet → agent-id `Registered` log scan. Defaults to
   * genesis — pass the registry deploy block on RPCs with pruned history
   * (e.g. Arc testnet public RPC rejects `fromBlock: 0`).
   */
  readonly fromBlock?: bigint;
  /**
   * Feedback indices scanned per reviewer when hunting dropout tags.
   * Defaults to 3. A revert/miss ends that reviewer's scan — later indices
   * are assumed absent, never a crash.
   */
  readonly maxFeedbackPerClient?: number;
};

export type ResolveSeedAgentParams = Omit<ResolveSeedAgentsParams, "seeds"> & {
  readonly seed: DemoSeedAgent;
};

/** An unrevoked negative `dropout` tag fails the agent. */
export function isDropoutEntry(entry: FeedbackEntry): boolean {
  return entry.revoked === false && entry.tag1 === "dropout" && entry.value < 0n;
}

function checkedMaxFeedbackPerClient(value: number | undefined): number {
  const max = value ?? 3;
  if (!Number.isInteger(max) || max < 1) {
    throw new DemoError(
      `maxFeedbackPerClient must be a positive integer, got ${String(value)}`,
    );
  }
  return max;
}

async function findDropoutClient(params: {
  readonly arcClient: PublicClient;
  readonly agentId: AgentId;
  readonly reviewers: readonly Address[];
  readonly maxFeedbackPerClient: number;
  readonly reputationRegistry?: Address;
}): Promise<Address | null> {
  for (const reviewer of params.reviewers) {
    for (let index = 1; index <= params.maxFeedbackPerClient; index += 1) {
      let entry: FeedbackEntry;
      try {
        entry = await readFeedback({
          publicClient: params.arcClient,
          agentId: params.agentId,
          clientAddress: reviewer,
          feedbackIndex: BigInt(index),
          ...(params.reputationRegistry === undefined
            ? {}
            : { registry: params.reputationRegistry }),
        });
      } catch {
        // No entry at this index (revert on missing feedback) — later
        // indices for this reviewer are assumed absent; move on.
        break;
      }
      if (isDropoutEntry(entry)) return reviewer;
    }
  }
  return null;
}

/**
 * ENS-first resolution for one seed: subname → Arc wallet → agent ids →
 * per-id identity + reputation + dropout scan.
 *
 * Returns `skipped` (never throws) when the name has no Arc record or the
 * resolved wallet mismatches the seed wallet; the seed wallet rides along
 * as `fallbackWallet` so the demo runs before Sepolia records land.
 */
export async function resolveSeedAgent(
  params: ResolveSeedAgentParams,
): Promise<DemoAgentResolution> {
  if (params.reviewers.length === 0) {
    throw new DemoError(
      "reviewers must be non-empty to resist Sybil-inflated summaries",
    );
  }
  const maxFeedbackPerClient = checkedMaxFeedbackPerClient(
    params.maxFeedbackPerClient,
  );
  const resolved = await resolveEnsToAgents({
    sepoliaClient: params.sepoliaClient,
    arcClient: params.arcClient,
    name: params.seed.ensName,
    ...(params.coinType === undefined ? {} : { coinType: params.coinType }),
    ...(params.identityRegistry === undefined
      ? {}
      : { identityRegistry: params.identityRegistry }),
    ...(params.fromBlock === undefined ? {} : { fromBlock: params.fromBlock }),
  });
  if (resolved === null) {
    return {
      status: "skipped",
      seed: params.seed,
      reason: `no Arc record for "${params.seed.ensName}"; falling back to seed wallet ${params.seed.wallet}`,
      fallbackWallet: params.seed.wallet,
    };
  }
  if (resolved.arcWallet.toLowerCase() !== params.seed.wallet.toLowerCase()) {
    return {
      status: "skipped",
      seed: params.seed,
      reason:
        `arc wallet mismatch for "${params.seed.ensName}": ` +
        `ENS resolves to ${resolved.arcWallet}, seed expects ${params.seed.wallet}`,
      fallbackWallet: params.seed.wallet,
    };
  }
  const details: DemoAgentDetail[] = [];
  for (const agentId of resolved.agentIds) {
    const [agent, summary] = await Promise.all([
      resolveAgent({
        publicClient: params.arcClient,
        agentId,
        ...(params.identityRegistry === undefined
          ? {}
          : { registry: params.identityRegistry }),
      }),
      getReputationSummary({
        publicClient: params.arcClient,
        agentId,
        clientAddresses: [...params.reviewers],
        ...(params.tag1 === undefined ? {} : { tag1: params.tag1 }),
        ...(params.tag2 === undefined ? {} : { tag2: params.tag2 }),
        ...(params.reputationRegistry === undefined
          ? {}
          : { registry: params.reputationRegistry }),
      }),
    ]);
    const dropoutClient = await findDropoutClient({
      arcClient: params.arcClient,
      agentId,
      reviewers: params.reviewers,
      maxFeedbackPerClient,
      ...(params.reputationRegistry === undefined
        ? {}
        : { reputationRegistry: params.reputationRegistry }),
    });
    details.push({
      agentId,
      agent,
      summary,
      dropout: dropoutClient !== null,
      dropoutClient,
    });
  }
  return {
    status: "resolved",
    seed: params.seed,
    arcWallet: resolved.arcWallet,
    agents: details,
  };
}

/**
 * ENS-first resolution for every seed, sequentially in seed order so the
 * demo run stays deterministic. Each entry is independently resolved or
 * skipped — one missing Arc record never aborts the rest.
 */
export async function resolveSeedAgents(
  params: ResolveSeedAgentsParams,
): Promise<readonly DemoAgentResolution[]> {
  if (params.seeds.length === 0) {
    throw new DemoError("seeds must be non-empty");
  }
  if (params.reviewers.length === 0) {
    throw new DemoError(
      "reviewers must be non-empty to resist Sybil-inflated summaries",
    );
  }
  const out: DemoAgentResolution[] = [];
  for (const seed of params.seeds) {
    out.push(
      await resolveSeedAgent({
        sepoliaClient: params.sepoliaClient,
        arcClient: params.arcClient,
        seed,
        reviewers: params.reviewers,
        ...(params.tag1 === undefined ? {} : { tag1: params.tag1 }),
        ...(params.tag2 === undefined ? {} : { tag2: params.tag2 }),
        ...(params.coinType === undefined ? {} : { coinType: params.coinType }),
        ...(params.identityRegistry === undefined
          ? {}
          : { identityRegistry: params.identityRegistry }),
        ...(params.reputationRegistry === undefined
          ? {}
          : { reputationRegistry: params.reputationRegistry }),
        ...(params.fromBlock === undefined
          ? {}
          : { fromBlock: params.fromBlock }),
        ...(params.maxFeedbackPerClient === undefined
          ? {}
          : { maxFeedbackPerClient: params.maxFeedbackPerClient }),
      }),
    );
  }
  return out;
}
