import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GraphError,
  createGraphClient,
  getCommitments,
  getDropouts,
  getPoolFill,
  getPoolHealth,
} from "../src/graph/index.js";
import type { GraphClient } from "../src/graph/index.js";

const POOL = "0xC6f9A1559f9a02755aC7Ba4865C558B0ed46B4fd";
const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function client(): GraphClient {
  return createGraphClient({ endpoint: "https://graph.local/subgraph" });
}

function wirePool(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      pool: {
        id: POOL,
        target: "10000000",
        totalCommitted: "2500000",
        settled: false,
        participantCount: "2",
        ...overrides,
      },
    },
  };
}

function wireCommitments(items: unknown[]) {
  return { data: { commitments: items } };
}

function wireDropouts(items: unknown[]) {
  return { data: { dropouts: items } };
}

function stubFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createGraphClient", () => {
  it("injects the endpoint with default timeout and JSON headers", () => {
    // Given: a caller-supplied endpoint
    // When: creating the client
    // Then: endpoint flows through, nothing hardcoded
    const c = client();
    expect(c.endpoint).toBe("https://graph.local/subgraph");
    expect(c.timeoutMs).toBe(10_000);
    expect(c.headers["content-type"]).toBe("application/json");
  });
});

describe("getPoolFill", () => {
  it("parses decimal strings into bigint fields", async () => {
    // Given: a subgraph serving string-encoded atomics
    vi.stubGlobal("fetch", stubFetch(wirePool()));

    // When: fetching the pool fill
    const fill = await getPoolFill(client(), POOL);

    // Then: the fill round-trips exactly
    expect(fill).toEqual({
      pool: POOL,
      target: 10_000_000n,
      totalCommitted: 2_500_000n,
      settled: false,
      participantCount: 2n,
    });
  });

  it("rejects malformed payloads without partial results", async () => {
    // Given: a payload missing the target field
    const { data } = wirePool();
    const { target: _dropped, ...partial } = data.pool;
    void _dropped;
    vi.stubGlobal("fetch", stubFetch({ data: { pool: partial } }));

    // When/Then: typed error, never a half-parsed fill
    await expect(getPoolFill(client(), POOL)).rejects.toThrow(GraphError);
  });

  it("rejects non-address pools before any request", async () => {
    // Given: a fetch counter
    const fetch = stubFetch(wirePool());
    vi.stubGlobal("fetch", fetch);

    // When/Then: local validation fires, zero requests sent
    await expect(getPoolFill(client(), "pool-1")).rejects.toThrow(GraphError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("wraps HTTP failures as typed errors", async () => {
    // Given: a 500ing endpoint
    vi.stubGlobal("fetch", stubFetch({ error: "boom" }, 500));

    // When/Then: status surfaces as GraphError
    await expect(getPoolFill(client(), POOL)).rejects.toThrow(GraphError);
  });
});

describe("getCommitments", () => {
  it("parses commitment rows into bigint amounts", async () => {
    // Given: one commitment row with string-encoded atomics
    vi.stubGlobal(
      "fetch",
      stubFetch(
        wireCommitments([
          { wallet: WALLET, amount: "1000000", blockNumber: "12345" },
        ]),
      ),
    );

    // When: fetching commitments for the pool
    const rows = await getCommitments(client(), POOL);

    // Then: the row round-trips exactly
    expect(rows).toEqual([
      { wallet: WALLET, amount: 1_000_000n, blockNumber: 12_345n },
    ]);
  });

  it("rejects malformed rows without partial results", async () => {
    // Given: a row missing the amount field
    vi.stubGlobal(
      "fetch",
      stubFetch(wireCommitments([{ wallet: WALLET, blockNumber: "1" }])),
    );

    // When/Then: typed error, never half-parsed rows
    await expect(getCommitments(client(), POOL)).rejects.toThrow(GraphError);
  });

  it("rejects non-address wallets before any request", async () => {
    // Given: a fetch counter
    const fetch = stubFetch(wireCommitments([]));
    vi.stubGlobal("fetch", fetch);

    // When/Then: local validation fires, zero requests sent
    await expect(
      getCommitments(client(), POOL, "agent-b"),
    ).rejects.toThrow(GraphError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("wraps HTTP failures as typed errors", async () => {
    // Given: a 500ing endpoint
    vi.stubGlobal("fetch", stubFetch({ error: "boom" }, 500));

    // When/Then: status surfaces as GraphError
    await expect(getCommitments(client(), POOL)).rejects.toThrow(GraphError);
  });

  it("filters by pool only when no wallet is given", async () => {
    // Given: a fetch that records the outgoing request body
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init);
        return new Response(JSON.stringify(wireCommitments([])), { status: 200 });
      }),
    );

    // When: fetching every commitment in the pool
    await getCommitments(client(), POOL);

    // Then: no unset wallet variable reaches the subgraph
    const body = JSON.parse(String(calls[0]?.body)) as {
      query: string;
      variables: Record<string, string>;
    };
    expect(body.query).not.toContain("wallet: $wallet");
    expect(body.variables).toEqual({ pool: POOL.toLowerCase() });
  });

  it("filters by wallet when one is given", async () => {
    // Given: a fetch that records the outgoing request body
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init);
        return new Response(JSON.stringify(wireCommitments([])), { status: 200 });
      }),
    );

    // When: fetching one wallet's commitments
    await getCommitments(client(), POOL, WALLET);

    // Then: the wallet filter and variable both carry through
    const body = JSON.parse(String(calls[0]?.body)) as {
      query: string;
      variables: Record<string, string>;
    };
    expect(body.query).toContain("wallet: $wallet");
    expect(body.variables).toEqual({
      pool: POOL.toLowerCase(),
      wallet: WALLET.toLowerCase(),
    });
  });
});

describe("getDropouts", () => {
  it("parses dropout rows into bigint amounts", async () => {
    // Given: one dropout row with string-encoded atomics
    vi.stubGlobal(
      "fetch",
      stubFetch(wireDropouts([{ wallet: WALLET, forfeited: "500000" }])),
    );

    // When: fetching dropouts for the pool
    const rows = await getDropouts(client(), POOL);

    // Then: the row round-trips exactly
    expect(rows).toEqual([{ wallet: WALLET, forfeited: 500_000n }]);
  });

  it("rejects malformed rows without partial results", async () => {
    // Given: a row with a non-uint forfeited field
    vi.stubGlobal(
      "fetch",
      stubFetch(wireDropouts([{ wallet: WALLET, forfeited: "lots" }])),
    );

    // When/Then: typed error, never half-parsed rows
    await expect(getDropouts(client(), POOL)).rejects.toThrow(GraphError);
  });

  it("wraps HTTP failures as typed errors", async () => {
    // Given: a 500ing endpoint
    vi.stubGlobal("fetch", stubFetch({ error: "boom" }, 500));

    // When/Then: status surfaces as GraphError
    await expect(getDropouts(client(), POOL)).rejects.toThrow(GraphError);
  });
});

describe("getPoolHealth", () => {
  function wireHealth(
    poolFields: Record<string, unknown> = {},
    dropouts: unknown[] = [],
  ) {
    return {
      data: {
        pool: {
          settled: true,
          participantCount: "3",
          forfeitedTotal: "500000",
          ...poolFields,
        },
        dropouts,
      },
    };
  }

  it("parses pool health with dropout count", async () => {
    // Given: a pool with two dropout rows
    vi.stubGlobal(
      "fetch",
      stubFetch(wireHealth({}, [{ id: "1" }, { id: "2" }])),
    );

    // When: fetching the pool health
    const health = await getPoolHealth(client(), POOL);

    // Then: reliability context round-trips exactly
    expect(health).toEqual({
      settled: true,
      participantCount: 3n,
      forfeitedTotal: 500_000n,
      dropoutCount: 2,
    });
  });

  it("rejects malformed payloads without partial results", async () => {
    // Given: a payload with a non-uint participantCount
    vi.stubGlobal(
      "fetch",
      stubFetch(wireHealth({ participantCount: "lots" }, [])),
    );

    // When/Then: typed error, never half-parsed health
    await expect(getPoolHealth(client(), POOL)).rejects.toThrow(GraphError);
  });

  it("rejects non-address pools before any request", async () => {
    // Given: a fetch counter
    const fetch = stubFetch(wireHealth({}, []));
    vi.stubGlobal("fetch", fetch);

    // When/Then: local validation fires, zero requests sent
    await expect(getPoolHealth(client(), "pool-1")).rejects.toThrow(
      GraphError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
