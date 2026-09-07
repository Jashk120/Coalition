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
