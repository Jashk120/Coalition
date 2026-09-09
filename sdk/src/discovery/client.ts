import type { Address, PublicClient } from "viem";

import { DEFAULT_PARENT_NAME, resolveArcWallet } from "../ens/index.js";
import type { GraphClient } from "../graph/index.js";
import { getPoolFill } from "../graph/index.js";
import {
  getCurrentRoundId,
  getPoolMetadata,
  getPoolState,
} from "../pool/index.js";
import { PoolDiscoveryError } from "./types.js";
import type { DiscoveredPool, PoolDiscoverySource } from "./types.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const UINT_PATTERN = /^\d+$/;

/**
 * Parse a comma-separated pool allowlist (e.g. `POOL_ADDRESSES` env) into
 * deduped addresses. Blank entries are ignored; a malformed entry throws
 * {@link PoolDiscoveryError} before any network call. `undefined`/empty
 * yields `[]` so the singleton fallback still applies downstream.
 */
export function parsePoolAddressList(
  value: string | undefined,
): Address[] {
  if (value === undefined || value.trim() === "") return [];
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    if (!ADDRESS_PATTERN.test(trimmed)) {
      throw new PoolDiscoveryError(
        `pool address "${trimmed}" is not a 0x address`,
      );
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed as Address);
  }
  return out;
}

export type PoolCandidate = {
  readonly pool: Address;
  readonly source: PoolDiscoverySource;
};

/**
 * Merge candidate addresses in priority order (explicit → subgraph →
 * singleton) and dedupe case-insensitively, keeping the first occurrence.
 * The singleton fallback is appended only when nothing else produced a
 * candidate, so 1-pool deployments work with zero configuration and N-pool
 * registries never see the singleton shadow them.
 */
export function collectPoolCandidates(params: {
  readonly fallbackPool?: Address;
  readonly extraPools?: readonly Address[];
  readonly subgraphPools?: readonly Address[];
}): PoolCandidate[] {
  const seen = new Set<string>();
  const out: PoolCandidate[] = [];
  const push = (pool: Address, source: PoolDiscoverySource): void => {
    const key = pool.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ pool, source });
  };
  for (const pool of params.extraPools ?? []) push(pool, "explicit");
  for (const pool of params.subgraphPools ?? []) push(pool, "subgraph");
  if (out.length === 0 && params.fallbackPool !== undefined) {
    push(params.fallbackPool, "singleton");
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const LIST_POOLS_QUERY = `query ListPools($first: Int!) {
  pools(first: $first) {
    id
  }
}`;

/**
 * Scan the subgraph's `pools` entity for up to `first` pool addresses.
 * Mirrors the `getPoolFill` request/validation style in `graph/queries.ts`.
 * Malformed entries are skipped (one bad entity cannot hide the rest);
 * transport or shape failures throw and are caught by `discoverPools`,
 * which degrades to the remaining candidate sources.
 */
export async function listSubgraphPools(
  client: GraphClient,
  first = 50,
): Promise<Address[]> {
  if (!Number.isInteger(first) || first < 1) {
    throw new PoolDiscoveryError(
      `first must be a positive integer, got ${String(first)}`,
    );
  }
  let response: Response;
  try {
    response = await fetch(client.endpoint, {
      method: "POST",
      headers: { ...client.headers },
      body: JSON.stringify({
        query: LIST_POOLS_QUERY,
        variables: { first },
      }),
      signal: AbortSignal.timeout(client.timeoutMs ?? 10_000),
    });
  } catch (error) {
    throw new PoolDiscoveryError(
      `pool discovery scan of ${client.endpoint} failed`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new PoolDiscoveryError(
      `pool discovery scan returned ${String(response.status)}`,
    );
  }
  const unknownBody: unknown = await response.json();
  if (!isRecord(unknownBody) || unknownBody["errors"] !== undefined) {
    throw new PoolDiscoveryError("pool discovery scan returned errors");
  }
  const data = unknownBody["data"];
  if (!isRecord(data)) {
    throw new PoolDiscoveryError("pool discovery payload data is not an object");
  }
  const raw = data["pools"];
  if (!Array.isArray(raw)) {
    throw new PoolDiscoveryError('pool discovery field "pools" is not an array');
  }
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
    const id = entry["id"];
    if (!ADDRESS_PATTERN.test(id)) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id as Address);
  }
  return out;
}

export type EnrichPoolParams = {
  /** Arc client for chain reads (and metadata/round enrichment). */
  readonly publicClient: PublicClient;
  readonly chainId: number;
  readonly pool: Address;
  readonly source: PoolDiscoverySource;
  readonly ensParent?: string;
  /** Subgraph-first fill snapshot when present; chain read otherwise. */
  readonly graphClient?: GraphClient;
};

function checkedChainId(chainId: number): number {
  if (!Number.isInteger(chainId) || chainId < 1) {
    throw new PoolDiscoveryError(
      `chainId must be a positive integer, got ${String(chainId)}`,
    );
  }
  return chainId;
}

/**
 * Enrich one candidate pool into a JSON-safe {@link DiscoveredPool}.
 * Read-only: subgraph-first `getPoolFill` when a graph client is present
 * (chain `getPoolMetadata` still supplies `resourceURI`, which the fill
 * snapshot lacks), otherwise chain `getPoolState` + `getPoolMetadata`.
 * `getCurrentRoundId` is best-effort — v1 pools without rounds report
 * `"0"`. Returns `null` when the pool is unreadable so `discoverPools`
 * can skip it without hiding the healthy pools.
 */
export async function enrichPool(
  params: EnrichPoolParams,
): Promise<DiscoveredPool | null> {
  const chainId = checkedChainId(params.chainId);
  const ensParent = params.ensParent ?? DEFAULT_PARENT_NAME;
  try {
    const [fill, metadata] = await Promise.all([
      params.graphClient === undefined
        ? null
        : getPoolFill(params.graphClient, params.pool).catch(() => null),
      getPoolMetadata({ publicClient: params.publicClient, pool: params.pool }),
    ]);
    const state =
      fill === null
        ? await getPoolState({
            publicClient: params.publicClient,
            pool: params.pool,
          })
        : null;
    let roundId = "0";
    try {
      const live = await getCurrentRoundId({
        publicClient: params.publicClient,
        pool: params.pool,
      });
      if (UINT_PATTERN.test(live.toString())) roundId = live.toString();
    } catch {
      // v1 pools (no currentRoundId) report round "0" — pool state, not error.
    }
    return {
      pool: params.pool,
      chainId,
      resourceURI: metadata.resourceURI,
      target: (fill === null ? state?.target : fill.target)?.toString() ?? "0",
      totalCommitted:
        (fill === null ? state?.totalCommitted : fill.totalCommitted)?.toString() ??
        "0",
      settled: fill === null ? (state?.settled ?? false) : fill.settled,
      roundId,
      source: params.source,
      ensParent,
    };
  } catch {
    return null;
  }
}

export type DiscoverPoolsParams = {
  /** Arc client for chain enrichment reads. */
  readonly publicClient: PublicClient;
  readonly chainId: number;
  /**
   * Singleton fallback (today's `POOL_ADDRESS`). Used only when no
   * explicit or subgraph candidate exists — multi-pool setups are additive
   * and never see the singleton shadow them.
   */
  readonly fallbackPool?: Address;
  /** Explicit N-pool list (registry output / parsed `POOL_ADDRESSES`). */
  readonly extraPools?: readonly Address[];
  /** Optional subgraph scan source; absent/unreachable degrades silently. */
  readonly graphClient?: GraphClient;
  /** Max subgraph entities to scan. Defaults to 50. */
  readonly subgraphFirst?: number;
  /**
   * ENS namespace the search runs under (default `agentpool.eth`).
   * Advisory tag on every output today; see module docs for the
   * text-record extension point.
   */
  readonly ensParentName?: string;
  /**
   * Optional ENS liveness probe: `{ sepoliaClient, name }` reuses the
   * existing `resolveArcWallet` primitive to check the namespace resolves.
   * Best-effort — a dead probe never fails discovery.
   */
  readonly ensProbe?: {
    readonly sepoliaClient: PublicClient;
    readonly name: string;
  };
};

/**
 * Discover available pools and enrich each into JSON-safe output.
 * Read-only — Fund/Run semantics are untouched. Works with 1 pool now
 * (singleton fallback, zero configuration) and N pools later (explicit
 * list + subgraph scan) without breaking callers: the return shape is
 * stable, only the array grows.
 */
export async function discoverPools(
  params: DiscoverPoolsParams,
): Promise<readonly DiscoveredPool[]> {
  const chainId = checkedChainId(params.chainId);
  const ensParentName = params.ensParentName ?? DEFAULT_PARENT_NAME;
  if (params.fallbackPool !== undefined && !ADDRESS_PATTERN.test(params.fallbackPool)) {
    throw new PoolDiscoveryError(
      `fallback pool "${params.fallbackPool}" is not a 0x address`,
    );
  }

  let subgraphPools: readonly Address[] = [];
  if (params.graphClient !== undefined) {
    try {
      subgraphPools = await listSubgraphPools(
        params.graphClient,
        params.subgraphFirst ?? 50,
      );
    } catch {
      // Subgraph scan is optional: degrade to explicit + singleton sources.
      subgraphPools = [];
    }
  }

  if (params.ensProbe !== undefined) {
    try {
      await resolveArcWallet({
        publicClient: params.ensProbe.sepoliaClient,
        name: params.ensProbe.name,
      });
    } catch {
      // Namespace liveness is advisory only — discovery proceeds regardless.
    }
  }

  const candidates = collectPoolCandidates({
    ...(params.fallbackPool === undefined
      ? {}
      : { fallbackPool: params.fallbackPool }),
    ...(params.extraPools === undefined ? {} : { extraPools: params.extraPools }),
    subgraphPools,
  });

  const discovered: DiscoveredPool[] = [];
  for (const candidate of candidates) {
    const enriched = await enrichPool({
      publicClient: params.publicClient,
      chainId,
      pool: candidate.pool,
      source: candidate.source,
      ensParent: ensParentName,
      ...(params.graphClient === undefined
        ? {}
        : { graphClient: params.graphClient }),
    });
    if (enriched !== null) discovered.push(enriched);
  }
  return discovered;
}
