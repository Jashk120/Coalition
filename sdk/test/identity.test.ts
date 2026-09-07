import type { Account } from "viem";
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeAbiParameters,
  pad,
  parseAbiParameters,
  toEventSelector,
  toFunctionSelector,
} from "viem";
import { describe, expect, it } from "vitest";

import { ARC_TESTNET } from "../src/chains/index.js";
import {
  AgentId,
  DEFAULT_IDENTITY_REGISTRY,
  IdentityRegistryError,
  registerAgent,
  resolveAgent,
  setAgentWallet,
} from "../src/identity/index.js";

const REGISTRY = DEFAULT_IDENTITY_REGISTRY;
const AGENT_URI = "ipfs://bafyagent1";
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

/**
 * Unlocked-style test account: the mock transport pretends the node holds
 * the key, so no key material or local signing exists anywhere in tests.
 */
const TEST_ACCOUNT: Account = { address: OWNER, type: "json-rpc" };

function ethCallResult(data: `0x${string}`) {
  return async ({
    method,
  }: {
    method: string;
    params: readonly unknown[];
  }): Promise<`0x${string}`> => {
    expect(method).toBe("eth_call");
    return data;
  };
}

describe("resolveAgent", () => {
  it("returns the agentURI and wallet in one params object", async () => {
    // Given: a registry where tokenURI and getAgentWallet are mocked
    const tokenSelector = toFunctionSelector("tokenURI(uint256)");
    const walletSelector = toFunctionSelector("getAgentWallet(uint256)");
    const transport = custom({
      request: async ({ method, params }) => {
        expect(method).toBe("eth_call");
        const data = (params as [{ readonly data: `0x${string}` }])[0].data;
        if (data.startsWith(walletSelector)) {
          return encodeAbiParameters([{ type: "address" }], [WALLET]);
        }
        expect(data.startsWith(tokenSelector)).toBe(true);
        return encodeAbiParameters([{ type: "string" }], [AGENT_URI]);
      },
    });
    const publicClient = createPublicClient({
      chain: ARC_TESTNET,
      transport,
    });

    // When: resolving agent 1
    const resolved = await resolveAgent({
      publicClient,
      agentId: AgentId(1n),
    });

    // Then: both reads are decoded into one value
    expect(resolved).toEqual({ agentURI: AGENT_URI, wallet: WALLET });
  });
});

describe("registerAgent", () => {
  it("sends register and parses the agentId from the receipt", async () => {
    // Given: a wallet that captures the send, and a receipt with a Registered log
    const registerSelector = toFunctionSelector("register(string)");
    const account = TEST_ACCOUNT;
    let sentData: `0x${string}` | undefined;
    const walletClient = createWalletClient({
      account,
      chain: ARC_TESTNET,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === "eth_chainId") return "0x4cef52";
          expect(method).toBe("eth_sendTransaction");
          sentData = (params as [{ readonly data: `0x${string}` }])[0].data;
          return "0x1111111111111111111111111111111111111111111111111111111111111111";
        },
      }),
    });
    const agentId = 7n;
    const receipt = {
      blockHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      blockNumber: "0x1",
      contractAddress: null,
      cumulativeGasUsed: "0x5208",
      effectiveGasPrice: "0x1",
      from: OWNER,
      gasUsed: "0x5208",
      logs: [
        {
          address: REGISTRY,
          blockHash:
            "0x2222222222222222222222222222222222222222222222222222222222222222",
          blockNumber: "0x1",
          data: encodeAbiParameters(
            parseAbiParameters("string agentURI, address owner"),
            [AGENT_URI, OWNER],
          ),
          logIndex: "0x0",
          removed: false,
          topics: [
            toEventSelector("Registered(uint256,string,address)"),
            pad("0x07"),
            pad(OWNER),
          ],
          transactionHash:
            "0x1111111111111111111111111111111111111111111111111111111111111111",
          transactionIndex: "0x0",
        },
      ],
      logsBloom:
        "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      status: "0x1",
      to: REGISTRY,
      transactionHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      transactionIndex: "0x0",
      type: "0x2",
    };
    const publicClient = createPublicClient({
      chain: ARC_TESTNET,
      transport: custom({
        request: ethCallResult("0x" as `0x${string}`),
      }),
    });
    void publicClient;

    // When: registering with a metadata URI
    const polling = custom({
      request: async ({ method }) => {
        if (method === "eth_chainId") return "0x4cef52";
        expect(method).toBe("eth_getTransactionReceipt");
        return receipt;
      },
    });
    const pollingClient = createPublicClient({
      chain: ARC_TESTNET,
      transport: polling,
    });

    const result = await registerAgent({
      walletClient,
      publicClient: pollingClient,
      account,
      metadataURI: AGENT_URI,
    });

    // Then: the call encodes register(string) and the receipt yields the agentId
    expect(sentData?.startsWith(registerSelector)).toBe(true);
    expect(result.agentId).toBe(agentId);
    expect(result.hash).toBe(
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    );
  });

  it("throws a typed error when the receipt has no Registered log", async () => {
    // Given: a receipt with no logs
    const account = TEST_ACCOUNT;
    const walletClient = createWalletClient({
      account,
      chain: ARC_TESTNET,
      transport: custom({
        request: async ({ method }) => {
          if (method === "eth_chainId") return "0x4cef52";
          expect(method).toBe("eth_sendTransaction");
          return "0x3333333333333333333333333333333333333333333333333333333333333333";
        },
      }),
    });
    const publicClient = createPublicClient({
      chain: ARC_TESTNET,
      transport: custom({
        request: async () => ({
          blockHash:
            "0x2222222222222222222222222222222222222222222222222222222222222222",
          blockNumber: "0x1",
          contractAddress: null,
          cumulativeGasUsed: "0x5208",
          effectiveGasPrice: "0x1",
          from: OWNER,
          gasUsed: "0x5208",
          logs: [],
          logsBloom:
            "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
          status: "0x1",
          to: REGISTRY,
          transactionHash:
            "0x3333333333333333333333333333333333333333333333333333333333333333",
          transactionIndex: "0x0",
          type: "0x2",
        }),
      }),
    });

    // When/Then: the missing receipt surfaces as a typed error
    await expect(
      registerAgent({
        walletClient,
        publicClient,
        account,
        metadataURI: AGENT_URI,
      }),
    ).rejects.toThrow(IdentityRegistryError);
  });
});

describe("setAgentWallet", () => {
  it("encodes the EIP-712-bound wallet change", async () => {
    // Given: a wallet client capturing the send
    const selector = toFunctionSelector(
      "setAgentWallet(uint256,address,uint256,bytes)",
    );
    const account = TEST_ACCOUNT;
    let sentData: `0x${string}` | undefined;
    const walletClient = createWalletClient({
      account,
      chain: ARC_TESTNET,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === "eth_chainId") return "0x4cef52";
          expect(method).toBe("eth_sendTransaction");
          sentData = (params as [{ readonly data: `0x${string}` }])[0].data;
          return "0x4444444444444444444444444444444444444444444444444444444444444444";
        },
      }),
    });

    // When: binding a wallet with a deadline and signature
    const result = await setAgentWallet({
      walletClient,
      account,
      agentId: AgentId(1n),
      newWallet: WALLET,
      deadline: 1_800_000_000n,
      signature: "0xdeadbeef",
    });

    // Then: the 4-argument form is encoded and the hash returned
    expect(sentData?.startsWith(selector)).toBe(true);
    expect(result.hash).toBe(
      "0x4444444444444444444444444444444444444444444444444444444444444444",
    );
  });
});
