import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  pad,
  parseAbiParameters,
  toEventSelector,
} from "viem";

import { ARC_TESTNET } from "../src/chains/index.js";
import { AgentId, findAgentsByOwner } from "../src/identity/index.js";

const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const AGENT_URI = "ipfs://bafyagent1";

function registeredLog(agentId: `0x${string}`, owner: `0x${string}`) {
  return {
    address: REGISTRY,
    blockHash:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    blockNumber: "0x1",
    data: encodeAbiParameters(parseAbiParameters("string agentURI, address owner"), [
      AGENT_URI,
      OWNER,
    ]),
    logIndex: "0x0",
    removed: false,
    topics: [toEventSelector("Registered(uint256,string,address)"), agentId, owner],
    transactionHash:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    transactionIndex: "0x0",
  };
}

describe("findAgentsByOwner", () => {
  let seenMethods: string[];

  beforeEach(() => {
    seenMethods = [];
  });

  function clientWithLogs(logs: ReturnType<typeof registeredLog>[]) {
    return createPublicClient({
      chain: ARC_TESTNET,
      transport: custom({
        request: async ({ method }) => {
          seenMethods.push(method);
          if (method === "eth_chainId") return "0x4cef52";
          expect(method).toBe("eth_getLogs");
          return logs;
        },
      }),
    });
  }

  it("returns agent ids owned by the wallet using only free log reads", async () => {
    // Given: two Registered logs for the owner
    const publicClient = clientWithLogs([
      registeredLog(pad("0x07"), pad(OWNER)),
      registeredLog(pad("0x0d"), pad(OWNER)),
    ]);

    // When: looking up by wallet
    const ids = await findAgentsByOwner({ publicClient, owner: OWNER });

    // Then: both ids, and no transaction was ever sent
    expect(ids).toEqual([AgentId(7n), AgentId(13n)]);
    expect(seenMethods).toEqual(["eth_getLogs"]);
  });

  it("returns empty when the wallet owns nothing", async () => {
    // Given: no logs for the wallet
    const publicClient = clientWithLogs([]);

    // When: looking up by wallet
    // Then: empty, not an error
    await expect(
      findAgentsByOwner({ publicClient, owner: OWNER }),
    ).resolves.toEqual([]);
  });
});
