import type {
  Account,
  Address,
  Hash,
  Hex,
  PublicClient,
  WalletClient,
} from "viem";
import { encodePacked, keccak256, toHex, zeroAddress } from "viem";
import {
  getEnsAddress,
  getEnsResolver,
  labelhash,
  namehash,
  normalize,
  packetToBytes,
} from "viem/ens";

import { findAgentsByOwner } from "../identity/index.js";
import { ARC_COIN_TYPE, DEFAULT_PARENT_NAME } from "./addresses.js";
import {
  ensAccessControlAbi,
  ensAddrAbi,
  ensSubnameRegistrarAbi,
} from "./abi.js";
import { EnsError } from "./types.js";
import type { EnsAgentResolution, EnsLabelCache, SubnameRegistration } from "./types.js";

/** Normalize a name or throw a typed error (invalid names never hit RPC). */
function normalizedName(name: string): string {
  try {
    return normalize(name);
  } catch (error) {
    throw new EnsError(`invalid ENS name "${name}"`, { cause: error });
  }
}

/**
 * In-memory cache keyed by `labelhash(label)`.
 *
 * Token IDs are mutable in ENSv2 — key by labelhash and resolve the live
 * token id at tx time. Never stores resolver addresses (looked up fresh
 * per write).
 */
export function createEnsLabelCache<T>(): EnsLabelCache<T> {
  const inner = new Map<Hex, T>();
  return {
    get: (label: string): T | undefined => inner.get(labelhash(label)),
    set: (label: string, value: T): void => {
      inner.set(labelhash(label), value);
    },
    clear: (): void => {
      inner.clear();
    },
    size: (): number => inner.size,
  };
}

export type ResolveArcWalletParams = {
  /** Sepolia client — resolution starts on L1 even though wallets live on Arc. */
  readonly publicClient: PublicClient;
  readonly name: string;
  readonly coinType?: number;
  readonly universalResolver?: Address;
};

/**
 * Resolve a subname to its Arc wallet via the Universal Resolver (never
 * direct). Returns `null` when the name has no Arc record — a subname with
 * no resolver inherits the parent's, so registration alone can be enough.
 */
export async function resolveArcWallet(
  params: ResolveArcWalletParams,
): Promise<Address | null> {
  const name = normalizedName(params.name);
  try {
    return await getEnsAddress(params.publicClient, {
      name,
      coinType: BigInt(params.coinType ?? ARC_COIN_TYPE),
      ...(params.universalResolver === undefined
        ? {}
        : { universalResolverAddress: params.universalResolver }),
    });
  } catch (error) {
    throw new EnsError(`failed to resolve "${name}"`, { cause: error });
  }
}

export type ResolveEnsResolverParams = {
  readonly publicClient: PublicClient;
  readonly name: string;
  readonly universalResolver?: Address;
};

/** Look up the live resolver for a name — always fresh, never cached. */
export async function resolveEnsResolver(
  params: ResolveEnsResolverParams,
): Promise<Address> {
  const name = normalizedName(params.name);
  try {
    const resolver = await getEnsResolver(params.publicClient, {
      name,
      ...(params.universalResolver === undefined
        ? {}
        : { universalResolverAddress: params.universalResolver }),
    });
    if (resolver === zeroAddress) {
      throw new EnsError(`no resolver for "${name}"`);
    }
    return resolver;
  } catch (error) {
    if (error instanceof EnsError) throw error;
    throw new EnsError(`failed to find resolver for "${name}"`, {
      cause: error,
    });
  }
}

export type SetArcAddressRecordParams = {
  readonly walletClient: WalletClient;
  /** Needed only when `resolver` is omitted (fresh lookup per write). */
  readonly publicClient?: PublicClient;
  readonly account: Account;
  readonly name: string;
  readonly arcWallet: Address;
  /** Live resolver — pass explicitly or it is looked up fresh, never cached. */
  readonly resolver?: Address;
  readonly coinType?: number;
};

/** Write (or overwrite) the name's Arc multicoin record. */
export async function setArcAddressRecord(
  params: SetArcAddressRecordParams,
): Promise<{ readonly hash: Hash; readonly resolver: Address }> {
  const name = normalizedName(params.name);
  let resolver = params.resolver;
  if (resolver === undefined) {
    if (params.publicClient === undefined) {
      throw new EnsError(
        `no resolver for "${name}": pass resolver or publicClient for a fresh lookup`,
      );
    }
    resolver = await resolveEnsResolver({
      publicClient: params.publicClient,
      name,
    });
  }
  const hash = await params.walletClient.writeContract({
    address: resolver,
    abi: ensAddrAbi,
    functionName: "setAddr",
    args: [namehash(name), BigInt(params.coinType ?? ARC_COIN_TYPE), params.arcWallet],
    account: params.account,
    chain: params.walletClient.chain,
  });
  return { hash, resolver };
}

export type AuthorizeAgentRecordParams = {
  readonly walletClient: WalletClient;
  readonly account: Account;
  readonly name: string;
  /** Live resolver — always explicit (EAC grants are per-resolver). */
  readonly resolver: Address;
  /** Agent wallet granted (or revoked with `allowed: false`) write access. */
  readonly agentWallet: Address;
  readonly allowed: boolean;
  readonly coinType?: number;
};

/**
 * Grant/revoke per-agent least privilege: the agent wallet may write only
 * its own Arc record (`authorizeAddrRoles(dnsName, coinType, wallet, …)`).
 */
export async function authorizeAgentRecord(
  params: AuthorizeAgentRecordParams,
): Promise<{ readonly hash: Hash }> {
  const name = normalizedName(params.name);
  const dnsName = toHex(packetToBytes(name));
  const hash = await params.walletClient.writeContract({
    address: params.resolver,
    abi: ensAccessControlAbi,
    functionName: "authorizeAddrRoles",
    args: [dnsName, BigInt(params.coinType ?? ARC_COIN_TYPE), params.agentWallet, params.allowed],
    account: params.account,
    chain: params.walletClient.chain,
  });
  return { hash };
}

export type RegisterSubnameParams = {
  readonly walletClient: WalletClient;
  readonly account: Account;
  /** Parent registrar — always explicit (one parent, one deployment). */
  readonly registrar: Address;
  readonly label: string;
  readonly parentName?: string;
  readonly owner: Address;
  readonly registry: Address;
  readonly resolver: Address;
  /** EAC role bitmap (e.g. SET_SUBREGISTRY|SET_RESOLVER|CAN_TRANSFER_ADMIN). */
  readonly roleBitmap: bigint;
  readonly expiry: bigint;
};

/** Register `label.parentName` owned by `owner` (beta — verify selector). */
export async function registerSubname(
  params: RegisterSubnameParams,
): Promise<SubnameRegistration> {
  if (params.label === "" || params.label.includes(".")) {
    throw new EnsError(`invalid subname label "${params.label}"`);
  }
  const parentName = params.parentName ?? DEFAULT_PARENT_NAME;
  const name = `${params.label}.${normalizedName(parentName)}`;
  const hash = await params.walletClient.writeContract({
    address: params.registrar,
    abi: ensSubnameRegistrarAbi,
    functionName: "register",
    args: [
      params.label,
      params.owner,
      params.registry,
      params.resolver,
      params.roleBitmap,
      params.expiry,
    ],
    account: params.account,
    chain: params.walletClient.chain,
  });
  return { hash, name };
}

/**
 * Factory salt for a `UserRegistry` proxy deployment:
 * `keccak256("UserRegistry", namehash(parent), version)`.
 *
 * Encoding assumption — verify against `VerifiableFactory` before Day-8.
 */
export function buildUserRegistrySalt(params: {
  readonly parentName?: string;
  readonly version: bigint;
}): Hex {
  const parent = normalizedName(params.parentName ?? DEFAULT_PARENT_NAME);
  return keccak256(
    encodePacked(
      ["string", "bytes32", "uint256"],
      ["UserRegistry", namehash(parent), params.version],
    ),
  );
}

export type ResolveEnsToAgentsParams = {
  /** Sepolia client for the ENS → Arc hop. */
  readonly sepoliaClient: PublicClient;
  /** Arc client for the wallet → agent-id hop (free log reads). */
  readonly arcClient: PublicClient;
  readonly name: string;
  readonly coinType?: number;
  readonly identityRegistry?: Address;
  /**
   * First block of the wallet → agent-id `Registered` log scan. Defaults to
   * genesis — pass the registry deploy block on RPCs with pruned history
   * (e.g. Arc testnet public RPC rejects `fromBlock: 0`).
   */
  readonly fromBlock?: bigint;
};

/**
 * The scored resolution path: subname → Arc wallet (`ARC_COIN_TYPE`) →
 * agent ids (`findAgentsByOwner` on `Registered` logs, zero gas). Returns
 * `null` when the name has no Arc record. Callers continue into
 * `resolveAgent` / `getReputationSummary` per id.
 */
export async function resolveEnsToAgents(
  params: ResolveEnsToAgentsParams,
): Promise<EnsAgentResolution | null> {
  const arcWallet = await resolveArcWallet({
    publicClient: params.sepoliaClient,
    name: params.name,
    ...(params.coinType === undefined ? {} : { coinType: params.coinType }),
  });
  if (arcWallet === null) return null;
  const agentIds = await findAgentsByOwner({
    publicClient: params.arcClient,
    owner: arcWallet,
    ...(params.identityRegistry === undefined
      ? {}
      : { registry: params.identityRegistry }),
    ...(params.fromBlock === undefined ? {} : { fromBlock: params.fromBlock }),
  });
  return { arcWallet, agentIds };
}
