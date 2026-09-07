import type { Address, PublicClient } from "viem";

import type { AgentId } from "../identity/index.js";
import { reputationRegistryAbi } from "./abi.js";
import { DEFAULT_REPUTATION_REGISTRY } from "./addresses.js";
import { ReputationRegistryError } from "./types.js";
import type { FeedbackEntry, ReputationSummary } from "./types.js";

export type GetReputationSummaryParams = {
  readonly publicClient: PublicClient;
  readonly agentId: AgentId;
  /**
   * Reviewers to aggregate over. Must be non-empty: unfiltered results
   * are subject to Sybil/spam attacks (see EIP-8004 Security Considerations).
   */
  readonly clientAddresses: readonly Address[];
  readonly tag1?: string;
  readonly tag2?: string;
  readonly registry?: Address;
};

/** Aggregate reputation for an agent as seen by the given reviewers. */
export async function getReputationSummary(
  params: GetReputationSummaryParams,
): Promise<ReputationSummary> {
  if (params.clientAddresses.length === 0) {
    throw new ReputationRegistryError(
      "clientAddresses must be non-empty to resist Sybil-inflated summaries",
    );
  }
  const registry = params.registry ?? DEFAULT_REPUTATION_REGISTRY;
  const [count, value, decimals] = await params.publicClient.readContract({
    address: registry,
    abi: reputationRegistryAbi,
    functionName: "getSummary",
    args: [
      params.agentId,
      [...params.clientAddresses],
      params.tag1 ?? "",
      params.tag2 ?? "",
    ],
  });
  return { count, value, decimals: Number(decimals) };
}

export type ReadFeedbackParams = {
  readonly publicClient: PublicClient;
  readonly agentId: AgentId;
  readonly clientAddress: Address;
  /** 1-indexed counter of the client's feedbacks for this agent. */
  readonly feedbackIndex: bigint;
  readonly registry?: Address;
};

/** Read one stored feedback entry. */
export async function readFeedback(
  params: ReadFeedbackParams,
): Promise<FeedbackEntry> {
  const registry = params.registry ?? DEFAULT_REPUTATION_REGISTRY;
  const [value, decimals, tag1, tag2, revoked] =
    await params.publicClient.readContract({
      address: registry,
      abi: reputationRegistryAbi,
      functionName: "readFeedback",
      args: [params.agentId, params.clientAddress, params.feedbackIndex],
    });
  return { value, decimals: Number(decimals), tag1, tag2, revoked };
}
