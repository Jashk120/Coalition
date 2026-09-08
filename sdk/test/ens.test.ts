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
import { sepolia } from "viem/chains";
import { namehash, toCoinType } from "viem/ens";
import { describe, expect, it } from "vitest";

import { ARC_TESTNET } from "../src/chains/index.js";
import {
  ARC_COIN_TYPE,
  EnsError,
  authorizeAgentRecord,
  buildUserRegistrySalt,
  createEnsLabelCache,
  registerSubname,
  resolveArcWallet,
  resolveEnsResolver,
  resolveEnsToAgents,
  setArcAddressRecord,
} from "../src/ens/index.js";

const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const RESOLVER = "0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e" as const;
const REGISTRAR = "0xa88553f454b77203b0d036a05c894d555eaaa2cc" as const;
const REGISTRY = "0x624a25d67b59d587752ebec8dded8827dae52050" as const;

const TEST_ACCOUNT: Account = { address: OWNER, type: "json-rpc" };
const SEPOLIA_CHAIN_ID = "0xaa36a7";
const ARC_CHAIN_ID = "0x4cef52";

/** eth_call mock returning a Universal-Resolver `resolveWithGateways` tuple. */
function resolveWithGatewaysResult(addrBytes: `0x${string}`) {
  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "address" }],
    [addrBytes, RESOLVER],
  );
}

function arcAddressBytes(): `0x${string}` {
  return encodeAbiParameters([{ type: "address" }], [WALLET]);
}

describe("ARC_COIN_TYPE", () => {
  it("matches viem derivation and the plan value", () => {
    expect(ARC_COIN_TYPE).toBe(2152525650);
    expect(ARC_COIN_TYPE).toBe(Number(toCoinType(5042002)));
  });
});

describe("createEnsLabelCache", () => {
  it("keys entries by labelhash, not by raw label", () => {
    const cache = createEnsLabelCache<bigint>();
    cache.set("agent1", 7n);
    expect(cache.get("agent1")).toBe(7n);
    expect(cache.get("agent2")).toBeUndefined();
    cache.set("agent2", 13n);
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get("agent1")).toBeUndefined();
  });
});

describe("resolveArcWallet", () => {
  it("resolves the Arc multicoin record via the Universal Resolver", async () => {
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: custom({
        request: async ({ method }) => {
          expect(method).toBe("eth_call");
          return resolveWithGatewaysResult(arcAddressBytes());
        },
      }),
    });
    const wallet = await resolveArcWallet({
      publicClient,
      name: "agent1.agentpool.eth",
    });
    expect(wallet).toBe(WALLET);
  });

  it("returns null when the name has no Arc record", async () => {
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: custom({
        request: async ({ method }) => {
          expect(method).toBe("eth_call");
          return resolveWithGatewaysResult("0x");
        },
      }),
    });
    await expect(
      resolveArcWallet({ publicClient, name: "nobody.agentpool.eth" }),
    ).resolves.toBeNull();
  });

  it("throws EnsError for invalid names before any RPC", async () => {
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: custom({
        request: async () => {
          throw new Error("must not reach RPC");
        },
      }),
    });
    await expect(
      resolveArcWallet({ publicClient, name: "bad_name.eth" }),
    ).rejects.toThrow(EnsError);
  });
});

describe("resolveEnsResolver", () => {
  it("returns the live resolver address", async () => {
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: custom({
        request: async ({ method }) => {
          expect(method).toBe("eth_call");
          return encodeAbiParameters(
            [{ type: "address" }, { type: "bytes32" }, { type: "uint256" }],
            [RESOLVER, namehash("agent1.agentpool.eth"), 0n],
          );
        },
      }),
    });
    const resolver = await resolveEnsResolver({
      publicClient,
      name: "agent1.agentpool.eth",
    });
    expect(resolver.toLowerCase()).toBe(RESOLVER.toLowerCase());
  });

  it("throws EnsError when no resolver exists", async () => {
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: custom({
        request: async () => {
          return encodeAbiParameters(
            [{ type: "address" }, { type: "bytes32" }, { type: "uint256" }],
            [
              "0x0000000000000000000000000000000000000000",
              namehash("nobody.agentpool.eth"),
              0n,
            ],
          );
        },
      }),
    });
    await expect(
      resolveEnsResolver({ publicClient, name: "nobody.agentpool.eth" }),
    ).rejects.toThrow(EnsError);
  });
});

describe("setArcAddressRecord", () => {
  const selector = toFunctionSelector("setAddr(bytes32,uint256,bytes)");

  function walletCapturing(capture: {
    to?: `0x${string}`;
    data?: `0x${string}`;
  }) {
    return createWalletClient({
      account: TEST_ACCOUNT,
      chain: sepolia,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === "eth_chainId") return SEPOLIA_CHAIN_ID;
          expect(method).toBe("eth_sendTransaction");
          const tx = (params as [{ readonly to: `0x${string}`; readonly data: `0x${string}` }])[0];
          capture.to = tx.to;
          capture.data = tx.data;
          return "0x1111111111111111111111111111111111111111111111111111111111111111";
        },
      }),
    });
  }

  it("encodes setAddr with the Arc coin type at an explicit resolver", async () => {
    const capture: { to?: `0x${string}`; data?: `0x${string}` } = {};
    const walletClient = walletCapturing(capture);
    const result = await setArcAddressRecord({
      walletClient,
      account: TEST_ACCOUNT,
      name: "agent1.agentpool.eth",
      arcWallet: WALLET,
      resolver: RESOLVER,
    });
    expect(capture.to).toBe(RESOLVER);
    expect(capture.data?.startsWith(selector)).toBe(true);
    expect(result.resolver).toBe(RESOLVER);
  });

  it("looks the resolver up fresh when none is passed", async () => {
    const capture: { to?: `0x${string}`; data?: `0x${string}` } = {};
    const walletClient = walletCapturing(capture);
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: custom({
        request: async ({ method }) => {
          expect(method).toBe("eth_call");
          return encodeAbiParameters(
            [{ type: "address" }, { type: "bytes32" }, { type: "uint256" }],
            [RESOLVER, namehash("agent1.agentpool.eth"), 0n],
          );
        },
      }),
    });
    const result = await setArcAddressRecord({
      walletClient,
      publicClient,
      account: TEST_ACCOUNT,
      name: "agent1.agentpool.eth",
      arcWallet: WALLET,
    });
    expect(capture.to?.toLowerCase()).toBe(RESOLVER.toLowerCase());
    expect(result.resolver.toLowerCase()).toBe(RESOLVER.toLowerCase());
  });

  it("throws EnsError when the resolver is unknown and undiscoverable", async () => {
    const capture: { to?: `0x${string}`; data?: `0x${string}` } = {};
    const walletClient = walletCapturing(capture);
    await expect(
      setArcAddressRecord({
        walletClient,
        account: TEST_ACCOUNT,
        name: "agent1.agentpool.eth",
        arcWallet: WALLET,
      }),
    ).rejects.toThrow(EnsError);
    expect(capture.data).toBeUndefined();
  });
});

describe("authorizeAgentRecord", () => {
  it("encodes authorizeAddrRoles for grant and revoke", async () => {
    const selector = toFunctionSelector(
      "authorizeAddrRoles(bytes,uint256,address,bool)",
    );
    const seen: `0x${string}`[] = [];
    const walletClient = createWalletClient({
      account: TEST_ACCOUNT,
      chain: sepolia,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === "eth_chainId") return SEPOLIA_CHAIN_ID;
          expect(method).toBe("eth_sendTransaction");
          seen.push((params as [{ readonly data: `0x${string}` }])[0].data);
          return "0x2222222222222222222222222222222222222222222222222222222222222222";
        },
      }),
    });
    for (const allowed of [true, false]) {
      const result = await authorizeAgentRecord({
        walletClient,
        account: TEST_ACCOUNT,
        name: "agent1.agentpool.eth",
        resolver: RESOLVER,
        agentWallet: WALLET,
        allowed,
      });
      expect(result.hash).toBe(
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      );
    }
    expect(seen).toHaveLength(2);
    for (const data of seen) {
      expect(data.startsWith(selector)).toBe(true);
    }
  });
});

describe("registerSubname", () => {
  it("encodes register and returns the qualified name", async () => {
    const selector = toFunctionSelector(
      "register(string,address,address,address,uint256,uint64)",
    );
    let sentTo: `0x${string}` | undefined;
    let sentData: `0x${string}` | undefined;
    const walletClient = createWalletClient({
      account: TEST_ACCOUNT,
      chain: sepolia,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === "eth_chainId") return SEPOLIA_CHAIN_ID;
          expect(method).toBe("eth_sendTransaction");
          const tx = (params as [{ readonly to: `0x${string}`; readonly data: `0x${string}` }])[0];
          sentTo = tx.to;
          sentData = tx.data;
          return "0x3333333333333333333333333333333333333333333333333333333333333333";
        },
      }),
    });
    const result = await registerSubname({
      walletClient,
      account: TEST_ACCOUNT,
      registrar: REGISTRAR,
      label: "agent1",
      owner: OWNER,
      registry: REGISTRY,
      resolver: RESOLVER,
      roleBitmap: 0b111n,
      expiry: 1_800_000_000n,
    });
    expect(sentTo).toBe(REGISTRAR);
    expect(sentData?.startsWith(selector)).toBe(true);
    expect(result.name).toBe("agent1.agentpool.eth");
  });

  it("rejects labels containing dots", async () => {
    const walletClient = createWalletClient({
      account: TEST_ACCOUNT,
      chain: sepolia,
      transport: custom({
        request: async () => {
          throw new Error("must not reach RPC");
        },
      }),
    });
    await expect(
      registerSubname({
        walletClient,
        account: TEST_ACCOUNT,
        registrar: REGISTRAR,
        label: "evil.label",
        owner: OWNER,
        registry: REGISTRY,
        resolver: RESOLVER,
        roleBitmap: 1n,
        expiry: 1n,
      }),
    ).rejects.toThrow(EnsError);
  });
});

describe("buildUserRegistrySalt", () => {
  it("is deterministic and varies by version and parent", () => {
    const a = buildUserRegistrySalt({ version: 1n });
    const b = buildUserRegistrySalt({ version: 1n });
    const c = buildUserRegistrySalt({ version: 2n });
    const d = buildUserRegistrySalt({
      parentName: "other.eth",
      version: 1n,
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });
});

describe("resolveEnsToAgents", () => {
  function registeredLog(agentId: `0x${string}`) {
    return {
      address: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      blockHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      blockNumber: "0x1",
      data: encodeAbiParameters(
        parseAbiParameters("string agentURI, address owner"),
        ["ipfs://bafyagent1", WALLET],
      ),
      logIndex: "0x0",
      removed: false,
      topics: [
        toEventSelector("Registered(uint256,string,address)"),
        agentId,
        pad(WALLET),
      ],
      transactionHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      transactionIndex: "0x0",
    };
  }

  it("walks ENS to Arc wallet to agent ids", async () => {
    const sepoliaClient = createPublicClient({
      chain: sepolia,
      transport: custom({
        request: async ({ method }) => {
          expect(method).toBe("eth_call");
          return resolveWithGatewaysResult(arcAddressBytes());
        },
      }),
    });
    const arcClient = createPublicClient({
      chain: ARC_TESTNET,
      transport: custom({
        request: async ({ method }) => {
          if (method === "eth_chainId") return ARC_CHAIN_ID;
          if (method === "eth_blockNumber") return "0x100";
          if (method === "eth_call") {
            return encodeAbiParameters(parseAbiParameters("uint256 balance"), [
              1n,
            ]);
          }
          expect(method).toBe("eth_getLogs");
          return [registeredLog(pad("0x07"))];
        },
      }),
    });
    const resolved = await resolveEnsToAgents({
      sepoliaClient,
      arcClient,
      name: "agent1.agentpool.eth",
    });
    expect(resolved?.arcWallet).toBe(WALLET);
    expect(resolved?.agentIds.map(Number)).toEqual([7]);
  });

  it("returns null when the name has no Arc record", async () => {
    const sepoliaClient = createPublicClient({
      chain: sepolia,
      transport: custom({
        request: async () => resolveWithGatewaysResult("0x"),
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
    await expect(
      resolveEnsToAgents({
        sepoliaClient,
        arcClient,
        name: "nobody.agentpool.eth",
      }),
    ).resolves.toBeNull();
  });
});
