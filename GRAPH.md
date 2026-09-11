# GRAPH.md: Best AI Tooling or AI Use Case with The Graph (From Scratch) submission receipt

**Overall: The Graph is load-bearing, not cosmetic.** Pool funding views read
the subgraph first (`readPoolState`), the roster path (`readRoster`) is
subgraph-or-bust with no chain fallback, and pool discovery scans the
subgraph when the endpoint is set. Live verified 2026-09-11 against the
Studio dev endpoint: `_meta.hasIndexingErrors = false`, one `Pool` entity,
47 commitments, 0 dropouts. The subgraph is deployed to Subgraph Studio only;
it has NOT been published to the decentralized network. No Substreams, MCP,
A2A, or Graph-targeted x402 usage exists (§8). Video is still TODO (§11 TODO-a).

Coalition enters the Start Fresh (Net-new) build pool: git history begins
2026-09-04 and runs to 2026-09-11.

## 1. Qualification fit (per track requirement)

Track: "Best AI Tooling or AI Use Case with The Graph (From Scratch)", $5,000.

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 1 | Built from scratch on The Graph (Start Fresh) | PASS | Git history 2026-09-04 to 2026-09-11; `subgraph/` scaffolded in-repo (`subgraph.yaml`, `schema.graphql`, `src/mapping.ts`); deployed as new Studio slug `coalition-resource-pool`, numeric ID `1760135` (§2) |
| 2 | Subgraph indexes project contracts live | PASS (live) | Data source `ResourcePool` on `arc-testnet`, address `0x8b9f38c7B005Dd67203e27240F45335a9e64F692`, `startBlock: 61221987`; six event handlers (§4); live query 2026-09-11 returned the pool + 47 commitments (§3) |
| 3 | App consumes the subgraph (AI tooling or AI use case) | PASS on app reads, GAP on agent reasoning | `readPoolState` is subgraph-first, `readRoster` is subgraph-or-bust, `discoverPools` scans the subgraph (§6); the agent decision loop (`POST /api/agents/run`) still decides from on-chain reads, so The Graph feeds the UI today, not the AI loop (§10) |
| 4 | Central, not cosmetic | PASS | `readRoster()` throws `"subgraph roster unavailable: SUBGRAPH_ENDPOINT is not configured"` when unset; no silent fallback exists on that path (`app/lib/pool-state.ts`) |
| 5 | Reproducible deployment receipt | PASS | Manifest, mapping, dependency, endpoint, IPFS hash, and exact deploy command in §2; Studio page + query endpoint listed |
| 6 | Video demo | FAIL (TODO) | No video exists; TODO-a (§11); the roster path (no fallback) is the recommended proof beat |

Do not claim a decentralized-network publication, a video, or agent-over-subgraph
reasoning until §8, §10, and §11 say otherwise.

## 2. Deployment facts

| Fact | Value |
|---|---|
| Network (Studio slug) | `arc-testnet` (The Graph lists it as a supported network) |
| Chain id | `eip155:5042002` (5042002) |
| RPC | `https://rpc.testnet.arc.network` |
| Pool contract (Arc testnet) | `0x8b9f38c7B005Dd67203e27240F45335a9e64F692` |
| `startBlock` | `61221987` (pool deployment block) |
| Manifest (`subgraph/subgraph.yaml`) | `specVersion: 1.0.0`, `indexerHints.prune: auto`, mapping `apiVersion: 0.0.9`, `language: wasm/assemblyscript`, data source name `ResourcePool`, `network: arc-testnet` |
| Dependencies actually installed | `@graphprotocol/graph-cli` `^0.90.0` (resolved 0.90.1; a warning offers 0.98.1), `@graphprotocol/graph-ts` `^0.34.0` |
| Node used locally | `v24.10.0` |
| Studio slug | `coalition-resource-pool` |
| Studio page | `https://thegraph.com/studio/subgraph/coalition-resource-pool` |
| Studio numeric ID | `1760135` |
| Live query endpoint (Studio dev URL) | `https://api.studio.thegraph.com/query/1760135/coalition-resource-pool/v0.0.1` |
| IPFS build hash (deployed `v0.0.1`) | `Qmahg6CnFDDhW4J86iSsoxKXsGfzprXY2mkN8AFgnvAqh4` |
| Amount encoding | 6-decimal atomic USDC as `BigInt` (never float math; see `sdk/README.md` dual-decimal warning) |

Exact working deploy sequence (inside `subgraph/`, after creating the slug
in the Studio UI; the CLI does not auto-create it):

```sh
graph auth --studio <DEPLOY_KEY>
npm run codegen && npm run build
graph deploy --node https://api.studio.thegraph.com/deploy/ --ipfs https://api.thegraph.com/ipfs/api/v0 --version-label v0.0.1 coalition-resource-pool
```

Gotchas on record (all hit during this deployment):

- Current `graph-cli` `deploy` has NO `--studio` flag (docs are misleading); use `--node https://api.studio.thegraph.com/deploy/`.
- The IPFS endpoint must be `https://api.thegraph.com/ipfs/api/v0`; the older `.../studio.thegraph.com/ipfs/` returns HTTP 404.
- The subgraph must be created first in the Studio UI; the CLI does not auto-create it.

## 3. Live verification (2026-09-11)

Endpoint queried:

```text
https://api.studio.thegraph.com/query/1760135/coalition-resource-pool/v0.0.1
```

Method: plain GraphQL `POST` against the endpoint above, with and without a
Bearer API key. Both return HTTP 200; the Studio dev endpoint does not
require the key (§7).

Observed results:

| Check | Result |
|---|---|
| HTTP status (with key) | `200` |
| HTTP status (without key) | `200` |
| `_meta.hasIndexingErrors` | `false` |
| `_meta.block.number` | `61567239` |
| `pools` rows | 1 |
| `pool.id` | `0x8b9f38c7b005dd67203e27240f45335a9e64f692` |
| `pool.target` | `10000000` (10 USDC, 6-decimal atomic) |
| `pool.totalCommitted` | `110000000` |
| `pool.settled` | `true` |
| `pool.participantCount` | `47` |
| `getCommitments` rows (pool only) | 47 |
| `getDropouts` rows (pool only) | 0 |

Reproduce with:

```graphql
{
  _meta { hasIndexingErrors block { number } }
  pools {
    id
    target
    totalCommitted
    settled
    participantCount
  }
}
```

```graphql
query ($pool: String!) {
  commitments(where: { pool: $pool }) {
    wallet
    amount
    blockNumber: block
  }
  dropouts(where: { pool: $pool }) {
    wallet
    forfeited
  }
}
```

Variables: `{ "pool": "0x8b9f38c7b005dd67203e27240f45335a9e64f692" }`.

## 4. Schema — entities and event handlers

Source of truth: `subgraph/schema.graphql`, `subgraph/subgraph.yaml`,
`subgraph/src/mapping.ts`. Event shapes derive from `sdk/src/pool/abi.ts`
(generated from `contracts/out/ResourcePool.sol/ResourcePool.json`); only
the v1 (unindexed-round) legs are indexed, and the v2 overloads
(`Committed(agent, roundId, amount)`, `Settled(roundId, total)`) fire
alongside them in the same transactions, so every fund movement is captured.

| Entity (`schema.graphql`) | One row per | Indexed fields (note) |
|---|---|---|
| `Pool` | Pool address (`id` = pool address) | `target`, `totalCommitted`, `forfeitedTotal`, `settled`, `expiredFinalized`, `participantCount`, plus `@derivedFrom` lists |
| `Commitment` | `Committed` event (repeat commits are separate rows; `id` = tx + logIndex) | `pool`, `wallet`, `amount`, `block`, `timestamp`, `txHash` |
| `Dropout` | `DroppedOut` event | `pool`, `wallet`, `forfeited`, `block`, `timestamp`, `txHash` |
| `Settlement` | `Settled` event ("funds left the pool", NOT "threshold met"; `kind` = `settle` or `expiry-sweep`) | `pool`, `total`, `kind`, `block`, `timestamp`, `txHash` |
| `Refund` | `Refunded` event (each `claimRefund` pull-withdrawal) | `pool`, `wallet`, `amount`, `block`, `timestamp`, `txHash` |
| `Expiry` | `ExpiredFinalized` event (expiry marker only; payouts follow as `Refund` rows) | `pool`, `balance`, `claimants`, `block`, `timestamp`, `txHash` |
| `Completion` | `CompletionRecorded` event (dropout = -1, completion = +1) | `pool`, `agentId`, `value`, `block`, `timestamp`, `txHash` |

Note the `Commitment` entity field is named `block`, not `blockNumber`.
The SDK aliases it (`blockNumber: block`) so its public type stays stable (§9.1).

| Event signature (`subgraph.yaml`) | Handler (`mapping.ts`) |
|---|---|
| `Committed(indexed address,uint256)` | `handleCommitted` |
| `Settled(uint256)` | `handleSettled` |
| `DroppedOut(indexed address,uint256)` | `handleDroppedOut` |
| `ExpiredFinalized(uint256,uint256)` | `handleExpiredFinalized` |
| `Refunded(indexed address,uint256)` | `handleRefunded` |
| `CompletionRecorded(indexed uint256,int128)` | `handleCompletionRecorded` |

Pool target handling: the live target is seeded once in `getOrCreatePool`
(`10000000`) and never overwritten by handlers.

## 5. SDK integration — graph functions and files

| File | Exports | Notes |
|---|---|---|
| `sdk/src/graph/client.ts` | `createGraphClient` | Endpoint is always caller-supplied, never hardcoded; optional Bearer `apiKey`; default 10s timeout |
| `sdk/src/graph/queries.ts` | `getPoolFill`, `getCommitments`, `getDropouts` | Strict parse-or-throw (`GraphError` on GraphQL `errors` or malformed payloads; never partial data); pool/wallet inputs validated as `0x` addresses |
| `sdk/src/graph/types.ts` | `GraphError`, `PoolFill`, `Commitment`, `Dropout` | Money is `bigint` atomic units across the wire as decimal strings; `Commitment.blockNumber` maps to schema field `block` via alias |
| `sdk/src/discovery/client.ts` | `listSubgraphPools`, `discoverPools`, `enrichPool` | `listSubgraphPools` issues `pools(first: $first) { id }`; malformed entries are skipped; `enrichPool` is subgraph-first for the fill snapshot (`resourceURI` still comes from chain `getPoolMetadata`) |

Query documents in `sdk/src/graph/queries.ts`:

- `GetPoolFill($id: ID!)` selects `pool(id:) { id target totalCommitted settled participantCount }`.
- `GetCommitments($pool: String!)` selects `commitments(where: { pool }) { wallet amount blockNumber: block }`.
- `GetCommitmentsByWallet($pool: String!, $wallet: String!)` adds the wallet filter (split document; see §9.2).
- `GetDropouts($pool: String!)` selects `dropouts(where: { pool }) { wallet forfeited }`.

## 6. App integration — Graph-backed routes

| Path | Graph role | Fallback |
|---|---|---|
| `readPoolState()` (`app/lib/pool-state.ts`) | Subgraph-FIRST: `getPoolFill` when `SUBGRAPH_ENDPOINT` is set (only the `expired` flag still comes from chain `getPoolState`) | Chain `getPoolState` when the endpoint is unset or the subgraph read fails; zeroed view only when both fail |
| `GET /api/roster` → `readRoster()` (`app/app/api/roster/route.ts`, `app/lib/pool-state.ts`) | SUBGRAPH-OR-BUST (mandatory): `getCommitments` + `getDropouts`; throws `"subgraph roster unavailable: SUBGRAPH_ENDPOINT is not configured"` when unset, or `"subgraph roster unavailable: …"` on query failure | NONE. This is the clearest proof The Graph is load-bearing |
| `GET /api/pools` (`app/app/api/pools/route.ts`) | Uses the subgraph via `discoverPools` when the endpoint is set (candidate scan + subgraph-first fill enrichment) | Explicit `POOL_ADDRESSES` + `POOL_ADDRESS` singleton; an unreachable subgraph degrades silently to those sources |
| `GET /api/agents` | Pool state portion is subgraph-first via `readPoolState` | Chain fallback per `readPoolState` |

Where The Graph is mandatory (no fallback): `readRoster`. Where it is
subgraph-first (chain fallback): `readPoolState`, `discoverPools` /
`GET /api/pools`. `app/README.md` documents that `SUBGRAPH_ENDPOINT` /
`SUBGRAPH_API_KEY` are server-only and stay in route handlers.

## 7. Configuration — env vars and API key

| Var | Scope | Meaning |
|---|---|---|
| `SUBGRAPH_ENDPOINT` | Server-only (never `NEXT_PUBLIC_`) | Studio query URL, e.g. `https://api.studio.thegraph.com/query/1760135/coalition-resource-pool/v0.0.1` |
| `SUBGRAPH_API_KEY` | Server-only (never `NEXT_PUBLIC_`) | Bearer key sent as `Authorization: Bearer …`; optional on the Studio dev endpoint |

`app/.env` now sets both (`SUBGRAPH_API_KEY` carries the existing
`GRAPH_API_KEY` value, mapped across). `app/.env.example` defines
`SUBGRAPH_ENDPOINT=` and `SUBGRAPH_API_KEY=` as empty server-only slots.

Where to obtain the key: Subgraph Studio → API Keys tab. The Studio dev
endpoint does not require the key (verified: HTTP 200 with and without it,
§3). The key is required for the decentralized-network gateway URL
`https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>`,
which only exists after publishing; this subgraph has not been published,
so that URL does not exist for it today.

## 8. The Graph feature map

| Feature | Status | Coalition usage |
|---|---|---|
| Subgraphs (Studio) | USED | `coalition-resource-pool` (ID `1760135`, `v0.0.1`, IPFS `Qmahg6CnFDDhW4J86iSsoxKXsGfzprXY2mkN8AFgnvAqh4`); six handlers on `arc-testnet` (§2, §4) |
| Subgraph queries in app + SDK | USED (load-bearing) | `getPoolFill` / `getCommitments` / `getDropouts` + `listSubgraphPools`; `readRoster` has no fallback (§5, §6) |
| Subgraph MCP | NOT USED | No MCP server, no `get_schema_by_deployment_id` / `execute_query_by_deployment_id` calls; `plans/subgraph.md` §5 sketched the wiring but it was never built |
| Substreams | NOT USED | None exists |
| x402 (for Graph queries) | NOT USED | The project's x402 flow is Circle Gateway compute-quota payment, not payment for Graph queries; no x402 is involved in any subgraph read |
| A2A | NOT USED | No A2A integration exists |
| Decentralized-network publication | NOT DONE | Studio-only deployment; the gateway URL pattern is documented in §7 but does not resolve for this subgraph |

Do not claim any Substreams, MCP, A2A, or Graph-targeted x402 usage. Do not
claim publication to the decentralized network.

## 9. Defects found and fixed during deployment

Both defects were in `sdk/src/graph/queries.ts`. Regression tests live in
`sdk/test/graph.test.ts`. After the fixes: `npm run check --prefix sdk`
clean; `npm test --prefix sdk` = 78 tests passing across 9 files;
`npm run check --prefix app` clean.

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | Query for commitments failed schema validation | The SDK selected `blockNumber`, but the schema field is `block` (`subgraph/schema.graphql`) | Alias in the query: `blockNumber: block`; the SDK public type (`Commitment.blockNumber`) stays stable |
| 2 | `getCommitments` with no wallet returned 0 rows despite 47 indexed commitments | The single document always carried a `wallet: $wallet` filter; with no wallet passed the variable was omitted and Graph coerced it to null, so the pool filter matched zero rows | Split into two documents: `GetCommitments` (pool only) and `GetCommitmentsByWallet` (pool + wallet); the wallet filter is only sent when a wallet is given |

Regression tests added (`sdk/test/graph.test.ts`):

- "filters by pool only when no wallet is given": asserts the outgoing query contains no `wallet: $wallet` filter and variables are exactly `{ pool }`.
- "filters by wallet when one is given": asserts the wallet-filtered document and `{ pool, wallet }` variables are used.

## 10. Honest limitations (do not overclaim)

- The subgraph is NOT published to the decentralized network. The Studio dev
  endpoint is for testing and is rate-limited (about 3,000 queries/day).
- The Studio dev endpoint does not require an API key; do not present the
  key as load-bearing on this URL. The key matters only for the gateway URL,
  which does not exist until publication.
- There is no MCP server, no Substreams, and no A2A integration. These are
  the tooling half of the track and are unused; the entry scores on the
  from-scratch subgraph plus its load-bearing app reads.
- The project's x402 flow is Circle Gateway compute-quota payment, not
  payment for Graph queries. No x402 touches the subgraph path.
- The AI decision loop (`POST /api/agents/run`) currently decides from
  on-chain reads. Today The Graph is load-bearing for the app's roster and
  pool views, not for the agent's reasoning; that positioning gap must be
  closed before submission (TODO-c).
- Pool target (`10000000`) is seeded once in the mapping, not read from the
  contract; a target change on-chain without a mapping update would desync
  the indexed `Pool.target`.
- Only the v1 event legs are indexed. Coverage holds because the v2
  overloads fire in the same transactions, but a future contract that emits
  only v2 shapes would index nothing until the manifest is extended.
- Live numbers in §3 are a point-in-time snapshot (2026-09-11,
  `_meta.block.number = 61567239`). Re-query at demo time; counts move as
  the pool does.

## 11. TODO fill-in list (owner + command)

- TODO-a (owner: Day-10 editor): record the 2-4 minute demo video showing a
  live subgraph query. The roster path is the best proof because it has no
  fallback (`readRoster` in `app/lib/pool-state.ts`). No video exists yet.
  Record: screen-capture the query in §3 plus the roster UI with
  `SUBGRAPH_ENDPOINT` set, then unset it to show the explicit error.
- TODO-b (owner: Day-10 deployer): publish the subgraph to the decentralized
  network for the API-key gateway URL
  (`https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>`).
  Record: `graph publish coalition-resource-pool` (or the Studio publish
  flow) + the returned Subgraph ID + a 200 against the gateway URL.
- TODO-c (owner: agent-loop owner): make an agent reason over subgraph data
  (for example `Dropout` history via `getDropouts`) so The Graph feeds the
  AI loop, not just the UI. Record: the `POST /api/agents/run` diff + a
  before/after decision trace with MCP dead (GraphQL fallback driving the
  decision, per `plans/subgraph.md` §5).
- TODO-d (owner: submitter): add a "The Graph" section to the root
  `README.md` linking this file, mirroring the existing ENS section.
  Record: `git diff README.md`.
