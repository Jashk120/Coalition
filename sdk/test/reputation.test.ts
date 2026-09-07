import { createPublicClient, custom, encodeAbiParameters, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";

import { ARC_TESTNET } from "../src/chains/index.js";
import { AgentId } from "../src/identity/index.js";
import {
  DEFAULT_REPUTATION_REGISTRY,
  getReputationSummary,
  readFeedback,
  ReputationRegistryError,
} from "../src/reputation/index.js";

const CLIENT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

function mockReads(
  handler: (data: `0x${string}`) => `0x${string}`,
) {
  return createPublicClient({
    chain: ARC_TESTNET,
    transport: custom({
      request: async ({ method, params }) => {
        if (method === "eth_chainId") return "0x4cef52";
        expect(method).toBe("eth_call");
        return handler((params as [{ readonly data: `0x${string}` }])[0].data);
      },
    }),
  });
}

describe("getReputationSummary", () => {
  it("maps the summary tuple for the requested tag filter", async () => {
    // Given: a registry reporting 3 feedbacks averaging 87 (starred)
    const selector = toFunctionSelector(
      "getSummary(uint256,address[],string,string)",
    );
    const publicClient = mockReads((data) => {
      expect(data.startsWith(selector)).toBe(true);
      return encodeAbiParameters(
        [{ type: "uint64" }, { type: "int128" }, { type: "uint8" }],
        [3n, 87n, 0],
      );
    });

    // When: summarizing agent 1 as seen by one client under "starred"
    const summary = await getReputationSummary({
      publicClient,
      agentId: AgentId(1n),
      clientAddresses: [CLIENT],
      tag1: "starred",
    });

    // Then: count, value, and decimals are decoded
    expect(summary).toEqual({ count: 3n, value: 87n, decimals: 0 });
  });

  it("decodes negative fixed-point values", async () => {
    // Given: a -3.2% trading yield (value -32, decimals 1)
    const publicClient = mockReads(() =>
      encodeAbiParameters(
        [{ type: "uint64" }, { type: "int128" }, { type: "uint8" }],
        [1n, -32n, 1],
      ),
    );

    // When: summarizing without tag filters
    const summary = await getReputationSummary({
      publicClient,
      agentId: AgentId(1n),
      clientAddresses: [CLIENT],
    });

    // Then: the signed value survives decoding
    expect(summary).toEqual({ count: 1n, value: -32n, decimals: 1 });
  });

  it("rejects an empty client list before touching the network", async () => {
    // Given: a client that counts every request
    let calls = 0;
    const publicClient = createPublicClient({
      chain: ARC_TESTNET,
      transport: custom({
        request: async () => {
          calls += 1;
          return "0x";
        },
      }),
    });

    // When/Then: the protocol's non-empty requirement is enforced locally
    await expect(
      getReputationSummary({
        publicClient,
        agentId: AgentId(1n),
        clientAddresses: [],
      }),
    ).rejects.toThrow(ReputationRegistryError);
    expect(calls).toBe(0);
  });
});

describe("readFeedback", () => {
  it("returns one feedback entry with its revocation flag", async () => {
    // Given: a stored 87/100 "starred" feedback, not revoked
    const selector = toFunctionSelector("readFeedback(uint256,address,uint64)");
    const publicClient = mockReads((data) => {
      expect(data.startsWith(selector)).toBe(true);
      return encodeAbiParameters(
        [
          { type: "int128" },
          { type: "uint8" },
          { type: "string" },
          { type: "string" },
          { type: "bool" },
        ],
        [87n, 0, "starred", "", false],
      );
    });

    // When: reading the client's first feedback for agent 1
    const entry = await readFeedback({
      publicClient,
      agentId: AgentId(1n),
      clientAddress: CLIENT,
      feedbackIndex: 1n,
    });

    // Then: the entry carries value, tags, and revocation state
    expect(entry).toEqual({
      value: 87n,
      decimals: 0,
      tag1: "starred",
      tag2: "",
      revoked: false,
    });
  });
});

describe("registry address", () => {
  it("defaults to the canonical Arc testnet deployment", () => {
    // Given: the universal testnet CREATE2 deployment
    // When: reading the default
    // Then: no truncation, exact address
    expect(DEFAULT_REPUTATION_REGISTRY).toBe(
      "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    );
  });
});
