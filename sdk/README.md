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

> **Placeholder ABI.** `src/pool/abi.ts` is hand-minimal until `contracts/`
> lands — replace it with the Foundry artifact and do not extend it meanwhile.

## Development

```sh
npm install
npm run check
npm run build
npm test
```
