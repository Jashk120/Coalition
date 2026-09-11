import type { Address } from "viem";

import { ARC_COIN_TYPE, DEFAULT_PARENT_NAME } from "../ens/index.js";
import type { DemoSeedAgent } from "./types.js";

/** Parent name under which per-agent subnames live. */
export const DEMO_PARENT_NAME = DEFAULT_PARENT_NAME;

/** Multicoin type used for Arc wallet records (ENSIP-9/11). */
export const DEMO_ARC_COIN_TYPE = ARC_COIN_TYPE;

/**
 * Deterministic 4-agent demo seeds, mirroring `demo/agents.seeds.json`.
 * `wallet` is the cross-check/fallback; live identity comes from `ensName`.
 * Order is the demo run order — never reorder.
 */
export const DEMO_SEED_AGENTS: readonly DemoSeedAgent[] = [
  {
    id: "agent-1",
    label: "agent1",
    ensName: "agent1.agentpool.eth",
    wallet: "0x0427194a9c99599a8bbbcc292b1523be91e4101d",
  },
  {
    id: "agent-2",
    label: "agent2",
    ensName: "agent2.agentpool.eth",
    wallet: "0xd1a3c06eb92dfd48fa1bf10ba2071da25e39cd47",
  },
  {
    id: "agent-3",
    label: "agent3",
    ensName: "agent3.agentpool.eth",
    wallet: "0x072825b4ba2c8019ccceba10e59b29a40980be94",
  },
  {
    id: "agent-4",
    label: "agent4",
    ensName: "agent4.agentpool.eth",
    wallet: "0x67bc424b83be66f7f5c4fc2324d4154744f1b310",
  },
];

/** Held-out resale buyer: never commits, stays outside the funding loop. */
export const DEMO_SEED_BUYER: {
  readonly wallet: Address;
  readonly ensName: string;
} = {
  wallet: "0x2e07588b8180c8235c2a1be7ffa2639545630dd1",
  ensName: "agent5.agentpool.eth",
};
