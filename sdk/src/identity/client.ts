import type { Account, Address, Hash, PublicClient, WalletClient } from "viem";
import { parseEventLogs } from "viem";

import { identityRegistryAbi } from "./abi.js";
import { DEFAULT_IDENTITY_REGISTRY } from "./addresses.js";
import { AgentId, IdentityRegistryError } from "./types.js";
import type { AgentRegistration, ResolvedAgent } from "./types.js";

export type RegisterAgentParams = {
  readonly walletClient: WalletClient;
  readonly publicClient: PublicClient;
  readonly account: Account;
  readonly metadataURI: string;
  readonly registry?: Address;
};

/**
 * Mint an ERC-8004 agent identity and return its id.
 *
 * The id is parsed from the receipt's `Registered` event — a receipt
 * without one throws {@link IdentityRegistryError}.
 */
export async function registerAgent(
  params: RegisterAgentParams,
): Promise<AgentRegistration> {
  const registry = params.registry ?? DEFAULT_IDENTITY_REGISTRY;
  const hash = await params.walletClient.writeContract({
    address: registry,
    abi: identityRegistryAbi,
    functionName: "register",
    args: [params.metadataURI],
    account: params.account,
    chain: params.walletClient.chain,
  });
  const receipt = await params.publicClient.waitForTransactionReceipt({ hash });
  const events = parseEventLogs({
    abi: identityRegistryAbi,
    logs: receipt.logs,
    eventName: "Registered",
  });
  const first = events[0];
  if (first === undefined) {
    throw new IdentityRegistryError(
      `no Registered event in receipt ${hash} from ${registry}`,
    );
  }
  return { agentId: AgentId(first.args.agentId), hash };
}

export type SetAgentWalletParams = {
  readonly walletClient: WalletClient;
  readonly account: Account;
  readonly agentId: AgentId;
  readonly newWallet: Address;
  readonly deadline: bigint;
  /** EIP-712 (EOA) or EIP-1271 (contract wallet) signature, produced off-chain over the registry domain. */
  readonly signature: `0x${string}`;
  readonly registry?: Address;
};

/**
 * Bind a wallet to an agent. The `signature` must already prove control
 * of `newWallet` — signing it is the caller's job, not this function's.
 */
export async function setAgentWallet(
  params: SetAgentWalletParams,
): Promise<{ readonly hash: Hash }> {
  const registry = params.registry ?? DEFAULT_IDENTITY_REGISTRY;
  const hash = await params.walletClient.writeContract({
    address: registry,
    abi: identityRegistryAbi,
    functionName: "setAgentWallet",
    args: [params.agentId, params.newWallet, params.deadline, params.signature],
    account: params.account,
    chain: params.walletClient.chain,
  });
  return { hash };
}

export type ResolveAgentParams = {
  readonly publicClient: PublicClient;
  readonly agentId: AgentId;
  readonly registry?: Address;
};

/** Resolve an agent id to its registration URI and bound wallet. */
export async function resolveAgent(
  params: ResolveAgentParams,
): Promise<ResolvedAgent> {
  const registry = params.registry ?? DEFAULT_IDENTITY_REGISTRY;
  const [agentURI, wallet] = await Promise.all([
    params.publicClient.readContract({
      address: registry,
      abi: identityRegistryAbi,
      functionName: "tokenURI",
      args: [params.agentId],
    }),
    params.publicClient.readContract({
      address: registry,
      abi: identityRegistryAbi,
      functionName: "getAgentWallet",
      args: [params.agentId],
    }),
  ]);
  return { agentURI, wallet };
}

export type FindAgentsByOwnerParams = {
  readonly publicClient: PublicClient;
  readonly owner: Address;
  readonly registry?: Address;
  /** First block to scan. Defaults to genesis — pass the registry deploy block on busy chains. */
  readonly fromBlock?: bigint;
};

/**
 * Find agent ids owned by a wallet. ERC-8004 has no on-chain reverse lookup
 * (no Enumerable, no lookup-by-address in the spec), so this filters the
 * indexed `owner` on `Registered` logs instead. Pure off-chain log reads —
 * zero gas. Closes the ENS → wallet → id hop.
 *
 * Two guards for range-capped RPCs (Arc testnet rejects ranges over ~10k
 * blocks): a `balanceOf` fast path returns `[]` without any log call when
 * the wallet owns nothing, and the remaining scan runs in 10k-block chunks.
 */
export async function findAgentsByOwner(
  params: FindAgentsByOwnerParams,
): Promise<readonly AgentId[]> {
  const registry = params.registry ?? DEFAULT_IDENTITY_REGISTRY;
  const balance = await params.publicClient.readContract({
    address: registry,
    abi: identityRegistryAbi,
    functionName: "balanceOf",
    args: [params.owner],
  });
  if (balance === 0n) return [];
  const latest = await params.publicClient.getBlockNumber();
  const start = params.fromBlock ?? 0n;
  const ids: AgentId[] = [];
  for (let cursor = start; cursor <= latest; ) {
    const end = cursor + 10_000n > latest ? latest : cursor + 10_000n;
    const logs = await params.publicClient.getContractEvents({
      address: registry,
      abi: identityRegistryAbi,
      eventName: "Registered",
      args: { owner: params.owner },
      fromBlock: cursor,
      toBlock: end,
    });
    for (const log of logs) {
      if (log.args.agentId !== undefined) ids.push(AgentId(log.args.agentId));
    }
    if (end === latest) break;
    cursor = end + 1n;
  }
  return ids;
}
