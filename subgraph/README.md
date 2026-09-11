# Coalition ResourcePool Subgraph

Subgraph Studio subgraph indexing the Coalition `ResourcePool` on Arc
testnet (chain `5042002`, RPC `https://rpc.testnet.arc.network`).

- Pool: `0x8b9f38c7B005Dd67203e27240F45335a9e64F692`
- Pool state at scaffold time: target 10 USDC (`10000000` atomic, 6-dec),
  `totalCommitted` 0, `settled` false.
- Live deployment (v0.0.1): https://thegraph.com/studio/subgraph/coalition-resource-pool
- Query endpoint: `https://api.studio.thegraph.com/query/1760135/coalition-resource-pool/v0.0.1`

Event shapes are derived from `sdk/src/pool/abi.ts` (generated from
`contracts/out/ResourcePool.sol/ResourcePool.json`); `abis/ResourcePool.json`
carries the six indexed events. Only the v1 (unindexed-round) shapes are
indexed: the v2 overloads (`Committed(agent, roundId, amount)`,
`Settled(roundId, total)`) fire alongside them in the same transactions, so
indexing the v1 legs still captures every fund movement. Amounts are
6-decimal atomic USDC — see the dual-decimal warning in `sdk/README.md`.

## Prerequisites

```sh
npm install
```

Requires Node.js 22 or later (tested on Node 24; see repo root `README.md`).

## Deploy

First create the subgraph in the Subgraph Studio UI (slug `coalition-resource-pool`)
and copy its deploy key. Current `graph-cli` `deploy` has no `--studio` flag, so
target `--node` directly:

```sh
# One-time: authenticate against Subgraph Studio (deploy key from the Studio
# UI, never committed).
graph auth --studio <DEPLOY_KEY>

# Regenerate AssemblyScript types from schema + ABI.
npm run codegen

# Compile mappings.
npm run build

# Deploy. Bump --version-label to publish an update.
graph deploy --node https://api.studio.thegraph.com/deploy/ --ipfs https://api.thegraph.com/ipfs/api/v0 --version-label v0.0.1 coalition-resource-pool
```

> The IPFS endpoint is `https://api.thegraph.com/ipfs/api/v0`; the older
> `.../studio.thegraph.com/ipfs/` URL returns 404. Studio does not auto-create
> the subgraph, so create the slug in the UI first.

After deploy, verify the endpoint answers, e.g.:

```graphql
{
  pools {
    id
    target
    totalCommitted
    settled
    participantCount
  }
}
```

## Refreshing startBlock

`subgraph.yaml` pins `startBlock: 61221987` (the pool's deployment block).
If the pool redeploys, lower it to the new deployment block before
redeploying:

```sh
cast block-number --rpc-url https://rpc.testnet.arc.network
```

## Layout

- `subgraph.yaml` — manifest (Arc testnet data source, six event handlers)
- `schema.graphql` — `Pool`, `Commitment`, `Dropout`, `Settlement`,
  `Refund`, `Expiry`, `Completion` entities
- `src/mapping.ts` — AssemblyScript handlers (BigInt amounts throughout)
- `abis/ResourcePool.json` — event ABIs for codegen
