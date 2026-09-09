import { createPublicClient, createWalletClient, custom, encodeAbiParameters, encodeFunctionData, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";

import { ARC_TESTNET } from "../src/chains/index.js";
import { AgentId } from "../src/identity/index.js";
import {
  claimRefund,
  commitToPool,
  dropOut,
  finalizeExpired,
  getCurrentRoundId,
  getPoolMetadata,
  getPoolState,
  getRoundState,
  recordCompletions,
  settlePool,
  startRound,
  wouldExceedTarget,
} from "../src/pool/index.js";
import { resourcePoolAbi } from "../src/pool/abi.js";
import type { PoolState, RoundState } from "../src/pool/index.js";

const POOL = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

const TEST_ACCOUNT = { address: OWNER, type: "json-rpc" } as const;

function mockWallet(capture: { data?: `0x${string}` }, hash: `0x${string}`) {
  return createWalletClient({
    account: TEST_ACCOUNT,
    chain: ARC_TESTNET,
    transport: custom({
      request: async ({ method, params }) => {
        if (method === "eth_chainId") return "0x4cef52";
        expect(method).toBe("eth_sendTransaction");
        capture.data = (params as [{ readonly data: `0x${string}` }])[0].data;
        return hash;
      },
    }),
  });
}

const STATE: PoolState = {
  target: 10_000_000n,
  totalCommitted: 7_500_000n,
  settled: false,
  expired: false,
  participantCount: 3n,
};

function mockViews() {
  const selectors = {
    target: toFunctionSelector("target()"),
    totalCommitted: toFunctionSelector("totalCommitted()"),
    settled: toFunctionSelector("settled()"),
    expired: toFunctionSelector("expired()"),
    participantCount: toFunctionSelector("participantCount()"),
  } as const;
  return createPublicClient({
    chain: ARC_TESTNET,
    transport: custom({
      request: async ({ method, params }) => {
        if (method === "eth_chainId") return "0x4cef52";
        expect(method).toBe("eth_call");
        const data = (params as [{ readonly data: `0x${string}` }])[0].data;
        if (data.startsWith(selectors.target)) {
          return encodeAbiParameters([{ type: "uint256" }], [STATE.target]);
        }
        if (data.startsWith(selectors.totalCommitted)) {
          return encodeAbiParameters([{ type: "uint256" }], [STATE.totalCommitted]);
        }
        if (data.startsWith(selectors.settled)) {
          return encodeAbiParameters([{ type: "bool" }], [STATE.settled]);
        }
        if (data.startsWith(selectors.expired)) {
          return encodeAbiParameters([{ type: "bool" }], [STATE.expired]);
        }
        expect(data.startsWith(selectors.participantCount)).toBe(true);
        return encodeAbiParameters([{ type: "uint256" }], [STATE.participantCount]);
      },
    }),
  });
}

describe("commitToPool", () => {
  it("encodes the amount as bigint with no float path", async () => {
    // Given: a wallet capturing the send
    const capture: { data?: `0x${string}` } = {};
    const walletClient = mockWallet(
      capture,
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );

    // When: committing 1.5 USDC (ERC-20 atomic)
    const result = await commitToPool({
      walletClient,
      account: TEST_ACCOUNT,
      pool: POOL,
      amount: 1_500_000n,
    });

    // Then: commit(uint256) is encoded with the exact amount
    expect(capture.data?.startsWith(toFunctionSelector("commit(uint256)"))).toBe(
      true,
    );
    expect(capture.data?.endsWith("000000000000000000000000000000000000000000000000000000000016e360")).toBe(
      true,
    );
    expect(result.hash).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });
});

describe("dropOut", () => {
  it("encodes the dropout for the given agent", async () => {
    // Given: a wallet capturing the send
    const capture: { data?: `0x${string}` } = {};
    const walletClient = mockWallet(
      capture,
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );

    // When: agent 1 drops out
    const result = await dropOut({
      walletClient,
      account: TEST_ACCOUNT,
      pool: POOL,
      agentId: AgentId(1n),
    });

    // Then: dropOut(uint256) names the agent
    expect(capture.data?.startsWith(toFunctionSelector("dropOut(uint256)"))).toBe(
      true,
    );
    expect(result.hash).toBe(
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });
});

describe("finalizeExpired and settlePool", () => {
  it("encodes the terminal calls", async () => {
    // Given: a wallet capturing sends
    const capture: { data?: `0x${string}` } = {};
    const walletClient = mockWallet(
      capture,
      "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    );

    // When: finalizing then settling
    await finalizeExpired({ walletClient, account: TEST_ACCOUNT, pool: POOL });
    expect(capture.data?.startsWith(toFunctionSelector("finalizeExpired()"))).toBe(
      true,
    );
    await settlePool({ walletClient, account: TEST_ACCOUNT, pool: POOL });
    expect(capture.data?.startsWith(toFunctionSelector("settle()"))).toBe(true);
    // Expiry is now snapshot + pull: finalize snapshots, claimRefund pulls.
    await claimRefund({ walletClient, account: TEST_ACCOUNT, pool: POOL });
    expect(capture.data?.startsWith(toFunctionSelector("claimRefund()"))).toBe(
      true,
    );
    await recordCompletions({
      walletClient,
      account: TEST_ACCOUNT,
      pool: POOL,
      maxRecords: 50n,
    });
    expect(
      capture.data?.startsWith(toFunctionSelector("recordCompletions(uint256)")),
    ).toBe(true);
  });
});

describe("getPoolState", () => {
  it("maps the five views into one PoolState", async () => {
    // Given: mocked views for an open, unfilled pool
    const publicClient = mockViews();

    // When: reading state
    const state = await getPoolState({ publicClient, pool: POOL });

    // Then: every field matches the mocked views
    expect(state).toEqual(STATE);
  });
});

describe("getPoolMetadata", () => {
  it("maps the deploy-time views into one PoolMetadata", async () => {
    const selectors = {
      resourceURI: toFunctionSelector("resourceURI()"),
      maxParticipants: toFunctionSelector("maxParticipants()"),
      feedbackCursor: toFunctionSelector("feedbackCursor()"),
    } as const;
    const publicClient = createPublicClient({
      chain: ARC_TESTNET,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === "eth_chainId") return "0x4cef52";
          expect(method).toBe("eth_call");
          const data = (params as [{ readonly data: `0x${string}` }])[0].data;
          if (data.startsWith(selectors.resourceURI)) {
            return encodeAbiParameters([{ type: "string" }], ["ipfs://terms"]);
          }
          if (data.startsWith(selectors.maxParticipants)) {
            return encodeAbiParameters([{ type: "uint256" }], [200n]);
          }
          expect(data.startsWith(selectors.feedbackCursor)).toBe(true);
          return encodeAbiParameters([{ type: "uint256" }], [3n]);
        },
      }),
    });

    const metadata = await getPoolMetadata({ publicClient, pool: POOL });

    expect(metadata).toEqual({
      resourceURI: "ipfs://terms",
      maxParticipants: 200n,
      feedbackCursor: 3n,
    });
  });
});

describe("wouldExceedTarget", () => {
  it("allows filling exactly to target", () => {
    // Given: 7.5 of 10 committed
    // When: committing exactly the remaining 2.5
    // Then: not exceeding
    expect(wouldExceedTarget(STATE, 2_500_000n)).toBe(false);
  });

  it("rejects anything over target", () => {
    // Given: 7.5 of 10 committed
    // When: committing one atomic unit too many
    // Then: exceeding
    expect(wouldExceedTarget(STATE, 2_500_001n)).toBe(true);
  });

  it("accepts a RoundState wherever a PoolState is expected", () => {
    // Given: a round state wrapping the same funding progress
    const roundState: RoundState = { ...STATE, roundId: 2n, deadline: 1_800n };
    // When: checking the cap with the round state
    // Then: same answer as the plain pool state
    expect(wouldExceedTarget(roundState, 2_500_000n)).toBe(false);
    expect(wouldExceedTarget(roundState, 2_500_001n)).toBe(true);
  });
});

describe("startRound", () => {
  it("encodes target, duration, and cap into startRound(uint256,uint64,uint256)", async () => {
    // Given: a wallet capturing the send
    const capture: { data?: `0x${string}` } = {};
    const walletClient = mockWallet(
      capture,
      "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    );

    // When: opening round 2
    const result = await startRound({
      walletClient,
      account: TEST_ACCOUNT,
      pool: POOL,
      target: 10_000_000n,
      durationSec: 3_600n,
      maxParticipants: 10n,
    });

    // Then: the full calldata matches the round-scoped overload
    const expected = encodeFunctionData({
      abi: resourcePoolAbi,
      functionName: "startRound",
      args: [10_000_000n, 3_600n, 10n],
    });
    expect(capture.data).toBe(expected);
    expect(capture.data?.startsWith(toFunctionSelector("startRound(uint256,uint64,uint256)"))).toBe(
      true,
    );
    expect(result.hash).toBe(
      "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    );
  });
});

describe("round-scoped writes", () => {
  it("encodes commit(uint256,uint256) with the round id", async () => {
    // Given: a wallet capturing the send
    const capture: { data?: `0x${string}` } = {};
    const walletClient = mockWallet(
      capture,
      "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    );

    // When: committing to round 2
    await commitToPool({
      walletClient,
      account: TEST_ACCOUNT,
      pool: POOL,
      amount: 1_500_000n,
      roundId: 2n,
    });

    // Then: the round-scoped overload carries the round id first
    const expected = encodeFunctionData({
      abi: resourcePoolAbi,
      functionName: "commit",
      args: [2n, 1_500_000n],
    });
    expect(capture.data).toBe(expected);
    expect(capture.data?.startsWith(toFunctionSelector("commit(uint256,uint256)"))).toBe(
      true,
    );
  });

  it("encodes claimRefund(uint256) with the round id", async () => {
    // Given: a wallet capturing the send
    const capture: { data?: `0x${string}` } = {};
    const walletClient = mockWallet(
      capture,
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    );

    // When: claiming the round 2 refund
    await claimRefund({ walletClient, account: TEST_ACCOUNT, pool: POOL, roundId: 2n });

    // Then: the round-scoped overload carries the round id
    const expected = encodeFunctionData({
      abi: resourcePoolAbi,
      functionName: "claimRefund",
      args: [2n],
    });
    expect(capture.data).toBe(expected);
    expect(capture.data?.startsWith(toFunctionSelector("claimRefund(uint256)"))).toBe(
      true,
    );
  });
});

describe("getRoundState", () => {
  it("maps the round views into one RoundState", async () => {
    // Given: mocked round views for round 2
    const roundId = 2n;
    const deadline = 1_800n;
    const roundTuple = [
      STATE.target,
      deadline,
      10n,
      STATE.totalCommitted,
      0n,
      STATE.settled,
      false,
      0n,
      0n,
      0n,
      0n,
      0n,
      0n,
    ] as const;
    const selectors = {
      rounds: toFunctionSelector("rounds(uint256)"),
      expired: toFunctionSelector("expired(uint256)"),
      participantCount: toFunctionSelector("participantCount(uint256)"),
    } as const;
    const publicClient = createPublicClient({
      chain: ARC_TESTNET,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === "eth_chainId") return "0x4cef52";
          expect(method).toBe("eth_call");
          const data = (params as [{ readonly data: `0x${string}` }])[0].data;
          if (data.startsWith(selectors.rounds)) {
            return encodeAbiParameters(
              [
                { type: "uint256" },
                { type: "uint64" },
                { type: "uint256" },
                { type: "uint256" },
                { type: "uint256" },
                { type: "bool" },
                { type: "bool" },
                { type: "uint256" },
                { type: "uint256" },
                { type: "uint256" },
                { type: "uint256" },
                { type: "uint256" },
                { type: "uint256" },
              ],
              [...roundTuple],
            );
          }
          if (data.startsWith(selectors.expired)) {
            return encodeAbiParameters([{ type: "bool" }], [STATE.expired]);
          }
          expect(data.startsWith(selectors.participantCount)).toBe(true);
          return encodeAbiParameters([{ type: "uint256" }], [STATE.participantCount]);
        },
      }),
    });

    // When: reading round state
    const state = await getRoundState({ publicClient, pool: POOL, roundId });

    // Then: every field matches the mocked views
    expect(state).toEqual({ ...STATE, roundId, deadline });
  });
});

describe("getCurrentRoundId", () => {
  it("reads the pool's latest round id", async () => {
    // Given: a mocked currentRoundId view
    const selector = toFunctionSelector("currentRoundId()");
    const publicClient = createPublicClient({
      chain: ARC_TESTNET,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === "eth_chainId") return "0x4cef52";
          expect(method).toBe("eth_call");
          const data = (params as [{ readonly data: `0x${string}` }])[0].data;
          expect(data.startsWith(selector)).toBe(true);
          return encodeAbiParameters([{ type: "uint256" }], [2n]);
        },
      }),
    });

    // When: reading the current round id
    const roundId = await getCurrentRoundId({ publicClient, pool: POOL });

    // Then: the mocked id comes back
    expect(roundId).toBe(2n);
  });
});
