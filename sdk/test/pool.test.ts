import { createPublicClient, createWalletClient, custom, encodeAbiParameters, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";

import { ARC_TESTNET } from "../src/chains/index.js";
import { AgentId } from "../src/identity/index.js";
import {
  claimRefund,
  commitToPool,
  dropOut,
  finalizeExpired,
  getPoolMetadata,
  getPoolState,
  recordCompletions,
  settlePool,
  wouldExceedTarget,
} from "../src/pool/index.js";
import type { PoolState } from "../src/pool/index.js";

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
});
