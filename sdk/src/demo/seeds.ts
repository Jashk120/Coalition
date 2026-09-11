import type { Address } from "viem";

import { ARC_COIN_TYPE, DEFAULT_PARENT_NAME } from "../ens/index.js";
import type { DemoSeedAgent } from "./types.js";

/** Parent name under which per-agent subnames live. */
export const DEMO_PARENT_NAME = DEFAULT_PARENT_NAME;

/** Multicoin type used for Arc wallet records (ENSIP-9/11). */
export const DEMO_ARC_COIN_TYPE = ARC_COIN_TYPE;

/**
 * Deterministic 4-agent demo seeds, mirroring `demo/agents.seeds.json`.
 * `wallet` is the ENS cross-check only — live identity MUST come from
 * `ensName`, and there is no wallet fallback. Order is the demo run order —
 * never reorder.
 */
export const DEMO_SEED_AGENTS: readonly DemoSeedAgent[] = [
  {
    id: "agent-1",
    label: "agent1",
    ensName: "agent1.agentpool.eth",
    wallet: "0x0e14d61f2bf9e1a494677257b8855e7ed091d983",
  },
  {
    id: "agent-2",
    label: "agent2",
    ensName: "agent2.agentpool.eth",
    wallet: "0x253a4751cc35555253666bf90b88ad79b336b079",
  },
  {
    id: "agent-3",
    label: "agent3",
    ensName: "agent3.agentpool.eth",
    wallet: "0x336e65d480ceff959ea3245f0ade6dac96af0ee8",
  },
  {
    id: "agent-4",
    label: "agent4",
    ensName: "agent4.agentpool.eth",
    wallet: "0x96ae62a9559dc69f61e07e288ee616e9a6c1bc5f",
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
