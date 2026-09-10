# Coalition contracts

Foundry project for the `ResourcePool` contract (round-scoped USDC pooling
on Arc testnet). Solidity `0.8.30`, optimizer on.

## Layout

- `src/ResourcePool.sol`: the pool (rounds, commits, dropouts, settle,
  refunds, ERC-8004 completion feedback)
- `test/ResourcePool.t.sol`: Forge tests (unit plus fuzz on the commit cap)
- `script/Deploy.s.sol`: deploy script (one pool, one VPS, no factory)
- `lib/`: vendored dependencies (do not hand-edit)

## Commands (all run inside `contracts/`)

```sh
forge build   # compiles src/ + script/, writes out/
forge test    # runs test/
```

`sdk/src/pool/abi.ts` is generated from
`out/ResourcePool.sol/ResourcePool.json`, so rebuild before re-syncing the
SDK (`node sdk/scripts/sync-pool-abi.mjs`).

## v1 shims vs v2 round methods

Round methods take an explicit `roundId` (`commit(roundId, amount)`,
`startRound`, `dropOut(roundId, agentId)`, `settle(roundId)`,
`finalizeExpired(roundId)`, `claimRefund(roundId)`,
`recordCompletions(roundId, maxRecords)`). The single-argument overloads
(`commit(amount)`, `dropOut(agentId)`, `settle()`, and the rest) are v1 shims
that forward to the current round on-chain. New rounds last longer than 0
and no longer than `MAX_ROUND_DURATION` (2 hours); the filling commit pays
the provider inline, so no separate `settle` call is needed on the happy
path.

## Dual Settled events

`_commit` emits both `Settled(total)` and `Settled(roundId, total)` in the
same transaction (likewise `Committed` in both shapes), so a v1 listener
still sees funds leave. Consumers must treat `Settled` as "funds left", not
"threshold met": it also fires on the `finalizeExpired` all-dropped sweep.

## Deploy

All params come from the environment (see the `Deploy` NatSpec header):

```sh
USDC=0x3600000000000000000000000000000000000000 PROVIDER=0x... TARGET=10000000 \
  DEADLINE=1893456000 REPUTATION_REGISTRY=0x8004B663056A597Dffe9eCcC1965A193B7388713 \
  RESOURCE_URI=ipfs://... MAX_PARTICIPANTS=200 \
  forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.arc.io
```

Live, append `--broadcast --verify --verifier blockscout --verifier-url
https://testnet.arcscan.app/api`. `TARGET`/`DEADLINE` seed round 1 only;
later rounds set their own target/duration/maxParticipants via `startRound`
(capped by `MAX_PARTICIPANTS_CAP`). After deploy, point the dashboard
(`NEXT_PUBLIC_POOL_ADDRESS`, `POOL_DEPLOY_BLOCK`), the subgraph
(`subgraph.yaml`), and the orchestrator (`POOL_V2_ADDRESS`) at the new
address.
