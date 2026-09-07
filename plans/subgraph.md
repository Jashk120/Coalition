# Subgraph — Build / Deploy / Query on Arc Testnet

Verified 2026-09-07 against The Graph docs, Studio, npm, MCP repos.

## 0. Stack

| Piece | Pin |
|---|---|
| Manifest `specVersion` / mapping `apiVersion` | `1.3.0` / `0.0.9` (`wasm/assemblyscript`, `ethereum/contract` + `ethereum/events`) |
| `@graphprotocol/graph-cli` | `0.98.1` stable (`gnd 0.1.0` now default executor) |
| `@graphprotocol/graph-ts` | `0.38.2` |
| Network string | `arc-testnet` (docs page `.../supported-networks/arc-testnet/` — first-class entry, chain `eip155:5042002`) |
| MCP server | `https://subgraphs.mcp.thegraph.com/sse` via `mcp-remote` + Gateway API key |

## 1. Day-1 checks (blocking, ~15 min, before Day 7 assumes anything)

1. `arc-testnet` appears in `graph init --network` / Studio network dropdown.
2. A Studio-deployed `arc-testnet` subgraph reaches `Synced` (not `Failed`).
3. Publish → Gateway serving + billing works for `arc-testnet`.
4. **ERC-8004 presence on Arc.** Conflict to resolve live: our SDK defaults
   assume universal CREATE2 addresses (`0x8004A818…BD9e` /
   `0x8004B663…8713`), but those are confirmed only for Ethereum/Base/BNB/
   Avalanche/Mantle — Arc is not listed. Check `testnet.arcscan.app` first.
   If absent: index `ResourcePool` only, or deploy the ERC-8004 registries
   ourselves. This check gates whether the Identity/Reputation dataSources below exist.
5. Fallback if Studio doesn't serve Arc yet (docs allow it): self-host
   `graph-node` against `https://rpc.testnet.arc.io` — same `subgraph.yaml` works.

## 2. Scaffold

```bash
npm install -g @graphprotocol/graph-cli@0.98.1
graph init --product subgraph-studio --from-contract <RESOURCEPOOL_ADDRESS> \
  --network arc-testnet --abi ./abis/ResourcePool.json \
  coalition-arc-testnet ./coalition-subgraph
# prompts: index events as entities=true; add another contract=yes (ERC-8004, if check 4 passes)
graph add <ERC8004_ADDRESS> --abi ./abis/IdentityRegistry.json \
  --contract-name IdentityRegistry --network-file ./networks.json
graph codegen && graph build
```

Edit 3 files only: `subgraph.yaml` (what to index), `schema.graphql` (what to
query), `src/*.ts` mappings (event → entity). One subgraph, one network,
multiple `dataSources` (ResourcePool + IdentityRegistry + ReputationRegistry).

`event:` signatures must exactly match Solidity canonical types — codegen
silently skips mismatches. Verify against `abis/*.json`. `startBlock` =
contract creation block. Pin `address` (don't index unscoped) for bounty
determinism. **Pool event names below are provisional** — regenerate from the
Foundry artifact once `contracts/` lands.

## 3. Schema (minimal)

Pool side: `Pool` (id, creator, stake, state, createdAt/updatedAt) +
immutable `Commitment`, `Settlement`, `Refund`, `Dropout`, `Completion`
(tx-hash+logIndex ids, amounts as `BigInt`, `@derivedFrom` back to pool).
ERC-8004 side: `Agent` (id, owner, agentURI) + immutable `Feedback`
(value `BigInt` — `int128` overflows `Int`/`Int8`; `valueDecimals` as `Int`;
`feedbackIndex: uint64` as `BigInt`; store un-indexed `tag1`/`tag2`, never the
indexed topic hash). Entity ids: `Bytes!` (tx hash concat logIndex).

## 4. Deploy + keys + endpoints

```bash
graph auth <DEPLOY_KEY>   # Studio subgraph page
graph deploy <SLUG>       # or: graph publish
```

- Dev (private, free): `https://api.studio.thegraph.com/query/<ID>/<SLUG>/<VERSION>/`
- Network (after publish): `https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<ID>`
- API key: Studio → API Keys → scope to subgraph. Limit: 3 unpublished
  deployments/account; 100k free queries/mo after publish.

## 5. MCP wiring (agent decision loop)

Our subgraph is **private** — not in the 15k searchable set. Never use keyword
search for it: pin the Deployment ID (`0x…`) / IPFS hash / Subgraph ID and
call `get_schema_by_deployment_id` → `execute_query_by_deployment_id` with the
Gateway key. opencode config (`mcp-remote` + `Authorization: Bearer
{env:GRAPH_GATEWAY_API_KEY}` against the SSE endpoint); Claude Desktop needs
the `graphql://subgraph` resource attached per conversation.

**Deterministic fallback is mandatory, not optional:** on any MCP/timeout
failure the agent POSTs the same GraphQL to the Gateway/Studio endpoint and
parses JSON. The demo moment ("pool fill % and prior dropouts for wallet X" →
join/no-join) must survive a dead LLM call.

## 6. Verify matrix (Day 7 exit)

Studio logs `Synced` → sample GraphQL returns pool + feedback rows → NL MCP
query returns correct data and visibly changes agent behavior → kill MCP and
confirm the GraphQL fallback still drives the decision.
