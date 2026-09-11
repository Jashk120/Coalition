import { readFileSync } from "node:fs";

import type { Address } from "viem";
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  pad,
  parseAbiParameters,
  toEventSelector,
  toFunctionSelector,
} from "viem";
import { sepolia } from "viem/chains";
import { describe, expect, it } from "vitest";

import { ARC_TESTNET } from "../src/chains/index.js";
import {
  DEMO_SEED_AGENTS,
  DemoError,
  isDropoutEntry,
  resolveSeedAgents,
} from "../src/demo/index.js";
import type { DemoSeedAgent } from "../src/demo/index.js";
import { AgentId } from "../src/identity/index.js";

const SEED_WALLET = "0x4f188f3da697984f0fc02e61fda4a34b00abf39a" as const;
const OTHER_WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const REVIEWER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const RESOLVER = "0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e" as const;
const ARC_CHAIN_ID = "0x4cef52";

const TOKEN_URI_SELECTOR = toFunctionSelector("tokenURI(uint256)");
const AGENT_WALLET_SELECTOR = toFunctionSelector("getAgentWallet(uint256)");
const BALANCE_OF_SELECTOR = toFunctionSelector("balanceOf(address)");
const GET_SUMMARY_SELECTOR = toFunctionSelector(
  "getSummary(uint256,address[],string,string)",
);
const READ_FEEDBACK_SELECTOR = toFunctionSelector(
  "readFeedback(uint256,address,uint64)",
);

function resolveWithGatewaysResult(addrBytes: `0x${string}`) {
  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "address" }],
    [addrBytes, RESOLVER],
  );
}

function arcAddressBytes(wallet: Address): `0x${string}` {
  return encodeAbiParameters([{ type: "address" }], [wallet]);
}

/** Sepolia mock: the Universal Resolver reports `wallet` (or no record). */
function sepoliaClientFor(wallet: Address | null) {
  return createPublicClient({
    chain: sepolia,
    transport: custom({
      request: async ({ method }) => {
        expect(method).toBe("eth_call");
        return resolveWithGatewaysResult(
          wallet === null ? "0x" : arcAddressBytes(wallet),
        );
      },
    }),
  });
}

function registeredLog(agentId: `0x${string}`, owner: Address) {
  return {
    address: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    blockHash:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    blockNumber: "0x1",
    data: encodeAbiParameters(parseAbiParameters("string agentURI, address owner"), [
      "ipfs://bafyagent1",
      owner,
    ]),
    logIndex: "0x0",
    removed: false,
    topics: [
      toEventSelector("Registered(uint256,string,address)"),
      agentId,
      pad(owner as `0x${string}`),
    ],
    transactionHash:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    transactionIndex: "0x0",
  };
}

type FeedbackStub = {
  readonly value: bigint;
  readonly decimals: number;
  readonly tag1: string;
  readonly tag2: string;
  readonly revoked: boolean;
};

/** Arc mock: free log reads + identity/reputation reads, dropout injectable. */
function arcClientMock(opts: {
  readonly owner: Address;
  readonly agentIds: `0x${string}`[];
  readonly feedback: FeedbackStub | null;
}) {
  return createPublicClient({
    chain: ARC_TESTNET,
    transport: custom({
      request: async ({ method, params }) => {
        if (method === "eth_chainId") return ARC_CHAIN_ID;
        if (method === "eth_blockNumber") return "0x100";
        if (method === "eth_getLogs") {
          return opts.agentIds.map((id) => registeredLog(id, opts.owner));
        }
        expect(method).toBe("eth_call");
        const data = (params as [{ readonly data: `0x${string}` }])[0].data;
        if (data.startsWith(BALANCE_OF_SELECTOR)) {
          return encodeAbiParameters(
            [{ type: "uint256" }],
            [BigInt(opts.agentIds.length)],
          );
        }
        if (data.startsWith(AGENT_WALLET_SELECTOR)) {
          return encodeAbiParameters([{ type: "address" }], [opts.owner]);
        }
        if (data.startsWith(TOKEN_URI_SELECTOR)) {
          return encodeAbiParameters(
            [{ type: "string" }],
            ["ipfs://bafyagent1"],
          );
        }
        if (data.startsWith(GET_SUMMARY_SELECTOR)) {
          return encodeAbiParameters(
            [{ type: "uint64" }, { type: "int128" }, { type: "uint8" }],
            [opts.feedback === null ? 0n : 1n, 87n, 0],
          );
        }
        expect(data.startsWith(READ_FEEDBACK_SELECTOR)).toBe(true);
        if (opts.feedback === null) {
          throw new Error("no feedback at this index");
        }
        return encodeAbiParameters(
          [
            { type: "int128" },
            { type: "uint8" },
            { type: "string" },
            { type: "string" },
            { type: "bool" },
          ],
          [
            opts.feedback.value,
            opts.feedback.decimals,
            opts.feedback.tag1,
            opts.feedback.tag2,
            opts.feedback.revoked,
          ],
        );
      },
    }),
  });
}

const SEED: DemoSeedAgent = {
  id: "agent-1",
  label: "agent1",
  ensName: "agent1.agentpool.eth",
  wallet: SEED_WALLET,
};

describe("resolveSeedAgents null handling", () => {
  it("is unresolved when the name has no Arc record (no wallet fallback)", async () => {
    // Given: a subname with no Arc record, and an Arc client that must stay untouched
    const sepoliaClient = sepoliaClientFor(null);
    const arcClient = createPublicClient({
      chain: ARC_TESTNET,
      transport: custom({
        request: async () => {
          throw new Error("must not query Arc without a wallet");
        },
      }),
    });

    // When: resolving the seed
    const [resolution] = await resolveSeedAgents({
      sepoliaClient,
      arcClient,
      seeds: [SEED],
      reviewers: [REVIEWER],
    });

    // Then: unresolved with reason, no fallback wallet, no crash
    expect(resolution?.status).toBe("unresolved");
    if (resolution?.status !== "unresolved") throw new Error("expected unresolved");
    expect(resolution.reason).toContain("no Arc record");
    expect("fallbackWallet" in resolution).toBe(false);
  });

  it("is unresolved when the resolved wallet mismatches the seed wallet", async () => {
    // Given: ENS resolves to a wallet the seed does not expect
    const sepoliaClient = sepoliaClientFor(OTHER_WALLET);
    const arcClient = arcClientMock({
      owner: OTHER_WALLET,
      agentIds: [pad("0x07")],
      feedback: null,
    });

    // When: resolving the seed
    const [resolution] = await resolveSeedAgents({
      sepoliaClient,
      arcClient,
      seeds: [SEED],
      reviewers: [REVIEWER],
    });

    // Then: unresolved names both wallets, no fallback wallet
    expect(resolution?.status).toBe("unresolved");
    if (resolution?.status !== "unresolved") throw new Error("expected unresolved");
    expect(resolution.reason).toContain("mismatch");
    expect(resolution.reason).toContain(OTHER_WALLET);
    expect("fallbackWallet" in resolution).toBe(false);
  });
});

describe("resolveSeedAgents live path", () => {
  it("walks subname to wallet to agent id with identity and reputation", async () => {
    // Given: ENS resolves to the seed wallet owning agent 7, no dropout tags
    const sepoliaClient = sepoliaClientFor(SEED_WALLET);
    const arcClient = arcClientMock({
      owner: SEED_WALLET,
      agentIds: [pad("0x07")],
      feedback: null,
    });

    // When: resolving the seed
    const [resolution] = await resolveSeedAgents({
      sepoliaClient,
      arcClient,
      seeds: [SEED],
      reviewers: [REVIEWER],
    });

    // Then: resolved with the full identity + reputation detail
    expect(resolution?.status).toBe("resolved");
    if (resolution?.status !== "resolved") throw new Error("expected resolve");
    expect(resolution.arcWallet.toLowerCase()).toBe(SEED_WALLET.toLowerCase());
    expect(resolution.agents.map((a) => a.agentId)).toEqual([AgentId(7n)]);
    expect(resolution.agents[0]?.agent.agentURI).toBe("ipfs://bafyagent1");
    expect(resolution.agents[0]?.summary.count).toBe(0n);
    expect(resolution.agents[0]?.dropout).toBe(false);
    expect(resolution.agents[0]?.dropoutClient).toBeNull();
  });

  it("flags an unrevoked negative dropout tag with the flagging reviewer", async () => {
    // Given: the reviewer's first feedback is a dropout mark
    const sepoliaClient = sepoliaClientFor(SEED_WALLET);
    const arcClient = arcClientMock({
      owner: SEED_WALLET,
      agentIds: [pad("0x07")],
      feedback: {
        value: -1n,
        decimals: 0,
        tag1: "dropout",
        tag2: "pool",
        revoked: false,
      },
    });

    // When: resolving the seed
    const [resolution] = await resolveSeedAgents({
      sepoliaClient,
      arcClient,
      seeds: [SEED],
      reviewers: [REVIEWER],
    });

    // Then: the agent is resolved but marked as a dropout fail
    if (resolution?.status !== "resolved") throw new Error("expected resolve");
    expect(resolution.agents[0]?.dropout).toBe(true);
    expect(resolution.agents[0]?.dropoutClient).toBe(REVIEWER);
  });

  it("preserves seed order across all four demo seeds", async () => {
    // Given: every demo seed resolves to its own wallet with no agents
    const sepoliaClient = createPublicClient({
      chain: sepolia,
      transport: custom({
        request: async ({ method }) => {
          expect(method).toBe("eth_call");
          return resolveWithGatewaysResult("0x");
        },
      }),
    });
    const arcClient = createPublicClient({
      chain: ARC_TESTNET,
      transport: custom({
        request: async () => {
          throw new Error("must not query Arc without a wallet");
        },
      }),
    });

    // When: resolving the full deterministic set (all missing records)
    const resolutions = await resolveSeedAgents({
      sepoliaClient,
      arcClient,
      seeds: DEMO_SEED_AGENTS,
      reviewers: [REVIEWER],
    });

    // Then: four unresolved entries in seed order, each with its own reason
    expect(resolutions.map((r) => r.seed.id)).toEqual([
      "agent-1",
      "agent-2",
      "agent-3",
      "agent-4",
    ]);
    for (const resolution of resolutions) {
      if (resolution.status !== "unresolved") throw new Error("expected unresolved");
      expect(resolution.reason).toContain("no Arc record");
      expect("fallbackWallet" in resolution).toBe(false);
    }
  });
});

describe("resolveSeedAgents validation", () => {
  it("rejects empty reviewers before any network call", async () => {
    // Given: transports that fail loudly on any request
    const failing = custom({
      request: async () => {
        throw new Error("must not reach the network");
      },
    });
    const sepoliaClient = createPublicClient({ chain: sepolia, transport: failing });
    const arcClient = createPublicClient({ chain: ARC_TESTNET, transport: failing });

    // When/Then: the Sybil rule throws a typed error with zero RPC
    await expect(
      resolveSeedAgents({ sepoliaClient, arcClient, seeds: [SEED], reviewers: [] }),
    ).rejects.toThrow(DemoError);
  });
});

describe("isDropoutEntry", () => {
  it("only fails on unrevoked negative dropout tags", () => {
    expect(
      isDropoutEntry({
        value: -1n,
        decimals: 0,
        tag1: "dropout",
        tag2: "pool",
        revoked: false,
      }),
    ).toBe(true);
    expect(
      isDropoutEntry({
        value: -1n,
        decimals: 0,
        tag1: "dropout",
        tag2: "pool",
        revoked: true,
      }),
    ).toBe(false);
    expect(
      isDropoutEntry({
        value: 5n,
        decimals: 0,
        tag1: "dropout",
        tag2: "pool",
        revoked: false,
      }),
    ).toBe(false);
    expect(
      isDropoutEntry({
        value: -1n,
        decimals: 0,
        tag1: "starred",
        tag2: "",
        revoked: false,
      }),
    ).toBe(false);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

describe("demo seeds mirror", () => {
  it("sdk DEMO_SEED_AGENTS matches demo/agents.seeds.json ensName and wallet", () => {
    // Given: the checked-in seed file
    const raw = readFileSync(
      new URL("../../demo/agents.seeds.json", import.meta.url),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error("seeds file is not an object");
    const agents = parsed["agents"];
    if (!Array.isArray(agents)) throw new Error("seeds file has no agents array");

    // When/Then: every sdk seed has the same ensName + wallet in the same order
    expect(agents.length).toBe(DEMO_SEED_AGENTS.length);
    agents.forEach((entry, index) => {
      if (!isRecord(entry)) throw new Error(`agent ${index} is not an object`);
      const sdkSeed = DEMO_SEED_AGENTS[index];
      expect(entry["ensName"]).toBe(sdkSeed?.ensName);
      expect(entry["wallet"]).toBe(sdkSeed?.wallet);
      expect(entry["id"]).toBe(sdkSeed?.id);
    });
  });
});
