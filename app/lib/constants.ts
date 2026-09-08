import type { Address } from "viem";

/**
 * Dashboard constants. Chain/pool/seed values mirror
 * `demo/agents.seeds.json` and `plans/agent-loop.md` §§1–2; the live
 * resolution and pool reads always come from the SDK, never from here.
 */

export const POOL_ADDRESS =
  (process.env["NEXT_PUBLIC_POOL_ADDRESS"] as Address | undefined) ??
  "0xC6f9A1559f9a02755aC7Ba4865C558B0ed46B4fd";

export const CHAIN_ID = Number(
  process.env["NEXT_PUBLIC_CHAIN_ID"] ?? "5042002",
);

/**
 * First Arc block carrying IdentityRegistry code. The wallet → agent-id
 * `Registered` log scan starts here because the public Arc RPC serves pruned
 * history and rejects genesis scans. Override via
 * `IDENTITY_REGISTRY_FROM_BLOCK` (server env) if the registry redeploys.
 */
export const IDENTITY_REGISTRY_FROM_BLOCK: bigint = (() => {
  const raw = process.env["IDENTITY_REGISTRY_FROM_BLOCK"];
  if (raw !== undefined && raw !== "" && /^\d+$/.test(raw)) return BigInt(raw);
  return 29241340n;
})();

/** Funding target: 10.00 USDC in 6-decimal atomic units. */
export const TARGET_ATOMIC = 10000000n;

/** Per-agent share: 2.00 USDC in atomic units. */
export const SHARE_ATOMIC = 2000000n;

export const ORCHESTRATOR_URL =
  process.env["NEXT_PUBLIC_ORCHESTRATOR_URL"] ?? "http://localhost:8080";

/** Display metadata per seed (cpu/mem/share). Run order = array order. */
export type SeedMeta = {
  readonly id: string;
  readonly label: string;
  readonly ensName: string;
  readonly wallet: Address;
  readonly cpu: number;
  readonly memMB: number;
  readonly shareUsdc: string;
};

export const SEED_META: readonly SeedMeta[] = [
  {
    id: "agent-1",
    label: "agent1",
    ensName: "agent1.agentpool.eth",
    wallet: "0x0427194a9c99599a8bbbcc292b1523be91e4101d",
    cpu: 0.2,
    memMB: 800,
    shareUsdc: "2.00",
  },
  {
    id: "agent-2",
    label: "agent2",
    ensName: "agent2.agentpool.eth",
    wallet: "0xd1a3c06eb92dfd48fa1bf10ba2071da25e39cd47",
    cpu: 0.15,
    memMB: 600,
    shareUsdc: "2.00",
  },
  {
    id: "agent-3",
    label: "agent3",
    ensName: "agent3.agentpool.eth",
    wallet: "0x072825b4ba2c8019ccceba10e59b29a40980be94",
    cpu: 0.1,
    memMB: 400,
    shareUsdc: "2.00",
  },
  {
    id: "agent-4",
    label: "agent4",
    ensName: "agent4.agentpool.eth",
    wallet: "0x67bc424b83be66f7f5c4fc2324d4154744f1b310",
    cpu: 0.25,
    memMB: 1000,
    shareUsdc: "2.00",
  },
];

/** Held-out resale buyer: never commits, stays outside the funding loop. */
export const OUTSIDE_BUYER = {
  wallet: "0x71846352cc198d7f3bfeb677f8631eb84d311329",
  ensName: "buyer.agentpool.eth",
} as const;
