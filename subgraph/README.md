# Coalition ResourcePool Subgraph

Subgraph Studio subgraph indexing the Coalition `ResourcePool` on Arc
testnet (chain `5042002`, RPC `https://rpc.testnet.arc.network`).

- Pool: `0xC6f9A1559f9a02755aC7Ba4865C558B0ed46B4fd`
- Pool state at scaffold time: target 10 USDC (`10000000` atomic, 6-dec),
  `totalCommitted` 0, `settled` false.
- Indexer: Subgraph Studio deployment — ID: `TODO_STUDIO_DEPLOYMENT_ID`

Event shapes are derived from `sdk/src/pool/abi.ts` (generated from
`contracts/out/ResourcePool.sol/ResourcePool.json`); `abis/ResourcePool.json`
carries the six indexed events. Amounts are 6-decimal atomic USDC — see the
dual-decimal warning in `sdk/README.md`.

## Prerequisites

```sh
npm install
```

Requires Node.js 26 or later (see repo root `README.md`).

## Deploy

```sh
# One-time: authenticate against Subgraph Studio (key from the Studio UI —
# never commit it).
graph auth --studio <DEPLOY_KEY>

# Regenerate AssemblyScript types from schema + ABI.
npm run codegen

# Compile mappings.
npm run build

# First time only: create the Studio subgraph, then publish.
npm run create -- --node https://api.studio.thegraph.com/deploy/
npm run deploy -- --node https://api.studio.thegraph.com/deploy/ --ipfs https://api.studio.thegraph.com/ipfs/
```

After deploy, replace `TODO_STUDIO_DEPLOYMENT_ID` above with the Studio
deployment ID and verify the endpoint answers, e.g.:

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

`subgraph.yaml` pins `startBlock: 61056595` (Arc latest `61057595` at
scaffold time minus 1000). If the pool was deployed earlier, lower it to the
pool's deployment block before redeploying:

```sh
cast block-number --rpc-url https://rpc.testnet.arc.network
```

## Layout

- `subgraph.yaml` — manifest (Arc testnet data source, six event handlers)
- `schema.graphql` — `Pool`, `Commitment`, `Dropout`, `Settlement`,
  `Refund`, `Expiry`, `Completion` entities
- `src/mapping.ts` — AssemblyScript handlers (BigInt amounts throughout)
- `abis/ResourcePool.json` — event ABIs for codegen
