import type { Address, Hash } from "viem";

import type { AgentId } from "../identity/index.js";

/** Thrown when an ENS interaction is invalid before or during a call. */
export class EnsError extends Error {
  readonly name = "EnsError";
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
  }
}

/**
 * In-memory cache keyed by labelhash hex.
 *
 * Token IDs are mutable in ENSv2, so caches key by `labelhash(label)` and
 * callers resolve the live token id at tx time (`findTokenId`). Resolver
 * addresses are never cached here — look the resolver up fresh per write.
 */
export type EnsLabelCache<T> = {
  readonly get: (label: string) => T | undefined;
  readonly set: (label: string, value: T) => void;
  readonly clear: () => void;
  readonly size: () => number;
};

/** Result of the scored ENS → Arc → ERC-8004 resolution path. */
export type EnsAgentResolution = {
  /** Arc wallet from the name's multicoin address record (`ARC_COIN_TYPE`). */
  readonly arcWallet: Address;
  /** Agent ids owned by that wallet (via `findAgentsByOwner` log reads). */
  readonly agentIds: readonly AgentId[];
};

/** Receipt of a subname registration write. */
export type SubnameRegistration = {
  readonly hash: Hash;
  /** Fully-qualified name that was registered (`label.parentName`). */
  readonly name: string;
};
