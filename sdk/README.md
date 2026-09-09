# Coalition SDK

TypeScript client for the Coalition pooling protocol on Arc testnet.
Requires Node.js 26 or later.

```sh
npm install @jx-nexus/coalition viem
```

> **Dual-decimal warning.** Native USDC (gas) is 18 decimals; the ERC-20 view
> is 6. Same asset, factor 10¹² — never mix raw values. This SDK keeps all
> on-chain amounts as `bigint` atomic units and display values as decimal
> strings, so the gap cannot hide in float math.

## Chains — Arc config + decimal helpers

```ts
import { createPublicClient, http } from "viem";
import { ARC_TESTNET, ARC_TESTNET_RPC_HTTP, fromAtomicUsdc, toAtomicUsdc } from "@jx-nexus/coalition";

const publicClient = createPublicClient({ chain: ARC_TESTNET, transport: http(ARC_TESTNET_RPC_HTTP) });
const atomic = toAtomicUsdc("1.5"); // 1500000n (ERC-20 view, the default)
fromAtomicUsdc(atomic); // "1.5"
```

## Identity — ERC-8004 agent registry

```ts
import { AgentId, registerAgent, resolveAgent } from "@jx-nexus/coalition";

const { agentId } = await registerAgent({ walletClient, publicClient, account, metadataURI: "ipfs://..." });
const agent = await resolveAgent({ publicClient, agentId }); // { agentURI, wallet }
```

Wallet binding is EIP-712-signed off-chain; pass the finished signature:

```ts
await setAgentWallet({ walletClient, account, agentId, newWallet, deadline, signature });
```

## Reputation — ERC-8004 feedback reads

```ts
import { getReputationSummary, readFeedback } from "@jx-nexus/coalition";

// clientAddresses must be non-empty (spec: unfiltered results invite Sybil spam)
const summary = await getReputationSummary({ publicClient, agentId, clientAddresses: [client], tag1: "starred" });
const entry = await readFeedback({ publicClient, agentId, clientAddress: client, feedbackIndex: 1n });
```

## Pool — resource pool (custom contract)
```ts
import { commitToPool, getPoolState, wouldExceedTarget } from "@jx-nexus/coalition";

const pool = "0x..."; // always explicit — no default (see src/pool/addresses.ts)
const state = await getPoolState({ publicClient, pool });
if (!wouldExceedTarget(state, toAtomicUsdc("2"))) {
  await commitToPool({ walletClient, account, pool, amount: toAtomicUsdc("2") });
}
```

> **Generated ABI.** `src/pool/abi.ts` is synced from
> `contracts/out/ResourcePool.sol/ResourcePool.json` — regenerate (never
> hand-edit) via `(cd contracts && forge build) && node sdk/scripts/sync-pool-abi.mjs`.

## Pool rounds — round-scoped funding (v2)

```ts
import { commitToPool, getRoundState, startRound } from "@jx-nexus/coalition";

const pool = "0x..."; // always explicit — no default (see src/pool/addresses.ts)
await startRound({ walletClient, account, pool, target: toAtomicUsdc("10"), durationSec: 3600n, maxParticipants: 10n });
await commitToPool({ walletClient, account, pool, amount: toAtomicUsdc("2"), roundId: 2n });
const round = await getRoundState({ publicClient, pool, roundId: 2n }); // { target, totalCommitted, settled, expired, participantCount, roundId, deadline }
```

Omit `roundId` on `commitToPool`, `dropOut`, `settlePool`,
`finalizeExpired`, `claimRefund`, or `recordCompletions` to use the
contract shim (current round on-chain).

## ENS — ENSv2 subnames on Sepolia (beta)

```ts
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { resolveArcWallet, resolveEnsToAgents } from "@jx-nexus/coalition";

const sepoliaClient = createPublicClient({ chain: sepolia, transport: http() });
const arcWallet = await resolveArcWallet({ publicClient: sepoliaClient, name: "agent1.agentpool.eth" });

// Scored path: subname → Arc wallet → ERC-8004 agent ids (free log reads)
const resolved = await resolveEnsToAgents({ sepoliaClient, arcClient: publicClient, name: "agent1.agentpool.eth" });
```

Writes look the resolver up fresh every call (never cached) and need a
Sepolia wallet client:

```ts
import { authorizeAgentRecord, registerSubname, setArcAddressRecord } from "@jx-nexus/coalition";

await registerSubname({ walletClient, account, registrar, label: "agent1", owner, registry, resolver, roleBitmap, expiry });
await authorizeAgentRecord({ walletClient, account, name: "agent1.agentpool.eth", resolver, agentWallet, allowed: true });
await setArcAddressRecord({ walletClient, publicClient: sepoliaClient, account, name: "agent1.agentpool.eth", arcWallet });
```

> **Beta caveats.** ENSv2 is beta on Sepolia: interfaces are not final and
> addresses rotate — re-fetch the Deployments table
> (`docs.ens.domains/learn/deployments/#sepolia-ensv2-beta`) before Day 8
> and at demo time. Every address in `src/ens/addresses.ts` is overridable
> per call; `VerifiableFactory` has no default (it already rotated once).
> Write ABIs in `src/ens/abi.ts` must be verified against
> `ensdomains/contracts-v2` HEAD before the demo.

## Development

```sh
npm install
npm run check
npm run build
npm test
```
