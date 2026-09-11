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
    wallet: "0x4f188f3da697984f0fc02e61fda4a34b00abf39a",
  },
  {
    id: "agent-2",
    label: "agent2",
    ensName: "agent2.agentpool.eth",
    wallet: "0x8c4d4ca5fe56c4aef3e7b424879f25693e9d5a2b",
  },
  {
    id: "agent-3",
    label: "agent3",
    ensName: "agent3.agentpool.eth",
    wallet: "0xde086aa43915670c74444b3e5a464d992e1f7770",
  },
  {
    id: "agent-4",
    label: "agent4",
    ensName: "agent4.agentpool.eth",
    wallet: "0x0a6415e892972214bceb0271746cb45932f7eaf1",
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
