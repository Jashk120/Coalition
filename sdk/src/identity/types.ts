import type { Address, Hash } from "viem";

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** An ERC-8004 agent id (ERC-721 tokenId). Never a raw bigint. */
export type AgentId = Brand<bigint, "AgentId">;
export function AgentId(value: bigint): AgentId {
  return value as AgentId;
}

/** Result of registering an agent: its id plus the mint transaction. */
export type AgentRegistration = {
  readonly agentId: AgentId;
  readonly hash: Hash;
};

/** An agent resolved to its registration URI and bound wallet. */
export type ResolvedAgent = {
  readonly agentURI: string;
  readonly wallet: Address;
};

/** Thrown when the registry interaction fails in a domain-specific way. */
export class IdentityRegistryError extends Error {
  readonly name = "IdentityRegistryError";
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
  }
}
