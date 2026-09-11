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

/** First Arc block carrying pool code — activity log scans start here. */
export const POOL_DEPLOY_BLOCK: bigint = (() => {
  const raw = process.env["POOL_DEPLOY_BLOCK"];
  if (raw !== undefined && raw !== "" && /^\d+$/.test(raw)) return BigInt(raw);
  return 61221987n;
})();

export const EXPLORER_URL =
  process.env["NEXT_PUBLIC_EXPLORER_URL"] ?? "https://testnet.arcscan.app";

/** Max settled rounds shown in the dashboard history table. */
export const ROUND_HISTORY_LIMIT = 10;

/** Standard per-agent share (cap): 2.50 USDC in atomic units.
 * Fund/run routes commit at most this per wallet, splitting the live
 * remainder across the wallets still to run when less is left. */
export const SHARE_ATOMIC = 2500000n;

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
    wallet: "0x4f188f3da697984f0fc02e61fda4a34b00abf39a",
    cpu: 0.2,
    memMB: 800,
    shareUsdc: "2.50",
  },
  {
    id: "agent-2",
    label: "agent2",
    ensName: "agent2.agentpool.eth",
    wallet: "0x8c4d4ca5fe56c4aef3e7b424879f25693e9d5a2b",
    cpu: 0.15,
    memMB: 600,
    shareUsdc: "2.50",
  },
  {
    id: "agent-3",
    label: "agent3",
    ensName: "agent3.agentpool.eth",
    wallet: "0xde086aa43915670c74444b3e5a464d992e1f7770",
    cpu: 0.1,
    memMB: 400,
    shareUsdc: "2.50",
  },
  {
    id: "agent-4",
    label: "agent4",
    ensName: "agent4.agentpool.eth",
    wallet: "0x0a6415e892972214bceb0271746cb45932f7eaf1",
    cpu: 0.25,
    memMB: 1000,
    shareUsdc: "2.50",
  },
];

/** Held-out resale buyer: agent-5, never commits, stays outside the funding loop.
 * Keep the OUTSIDE_BUYER export name; do NOT add this wallet to
 * CIRCLE_WALLET_IDS or SEED_META — the buyer pays via its own
 * CIRCLE_BUYER_WALLET_ID Circle wallet through the x402 Gateway flow. */
export const OUTSIDE_BUYER = {
  wallet: "0x2e07588b8180c8235c2a1be7ffa2639545630dd1",
  ensName: "agent5.agentpool.eth",
} as const;

/** x402 resale rail: Arc testnet in CAIP-2 form for payment requirements. */
export const RESALE_NETWORK = "eip155:5042002";

/** USDC token on Arc testnet (x402 asset + Gateway deposit token). */
export const RESALE_USDC_ADDRESS = "0x3600000000000000000000000000000000000000";

/** Circle Gateway facilitator for x402 verify/settle (testnet). */
export const RESALE_FACILITATOR_URL = "https://gateway-api-testnet.circle.com";

/** Circle GatewayWallet contract on testnet (x402 verifyingContract + deposits). */
export const RESALE_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
