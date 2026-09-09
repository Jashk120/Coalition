import { NextResponse } from "next/server";
import {
  createGraphClient,
  discoverPools,
  parsePoolAddressList,
} from "@jx-nexus/coalition";
import { arcPublicClient, sepoliaPublicClient } from "@/lib/chain";
import { CHAIN_ID, POOL_ADDRESS } from "@/lib/constants";
import { log } from "@/lib/logger";
import type { PoolsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const ENS_PARENT = "agentpool.eth";

/**
 * GET /api/pools — read-only pool discovery.
 *
 * Candidates are additive: explicit `POOL_ADDRESSES` (comma-separated,
 * future registry output) plus an optional `SUBGRAPH_ENDPOINT` scan, with
 * the `POOL_ADDRESS` singleton as the zero-config default. One pool today,
 * N pools later — the shape is stable, only the array grows. Fund/Run
 * semantics are untouched. An ENS liveness probe runs best-effort via the
 * SDK and never fails the request.
 */
export async function GET(): Promise<NextResponse<PoolsResponse>> {
  const endpoint = process.env["SUBGRAPH_ENDPOINT"];
  const apiKey = process.env["SUBGRAPH_API_KEY"];
  const graphClient =
    endpoint === undefined || endpoint === ""
      ? undefined
      : createGraphClient({
          endpoint,
          ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }),
        });

  let extraPools: ReturnType<typeof parsePoolAddressList> = [];
  let note: string | undefined;
  try {
    extraPools = parsePoolAddressList(
      process.env["POOL_ADDRESSES"] ?? process.env["NEXT_PUBLIC_POOL_ADDRESSES"],
    );
  } catch (error) {
    note =
      error instanceof Error
        ? `ignoring malformed POOL_ADDRESSES: ${error.message}`
        : "ignoring malformed POOL_ADDRESSES";
  }

  const pools = await discoverPools({
    publicClient: arcPublicClient(),
    chainId: CHAIN_ID,
    fallbackPool: POOL_ADDRESS,
    extraPools,
    ensParentName: ENS_PARENT,
    ensProbe: {
      sepoliaClient: sepoliaPublicClient(),
      name: `agent1.${ENS_PARENT}`,
    },
    ...(graphClient === undefined ? {} : { graphClient }),
  });

  log("info", "pools.discover", {
    route: "GET /api/pools",
    pools: pools.length,
    chainId: CHAIN_ID,
    ensParent: ENS_PARENT,
  });

  return NextResponse.json({
    ok: true,
    chainId: CHAIN_ID,
    ensParent: ENS_PARENT,
    pools: pools.map((pool) => ({
      pool: pool.pool,
      chainId: pool.chainId,
      resourceURI: pool.resourceURI,
      target: pool.target,
      totalCommitted: pool.totalCommitted,
      settled: pool.settled,
      roundId: pool.roundId,
      source: pool.source,
      ensParent: pool.ensParent,
    })),
    ...(note === undefined ? {} : { note }),
  });
}
