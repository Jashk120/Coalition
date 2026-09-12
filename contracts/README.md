# Coalition contracts

Foundry project for `ResourcePool`, the on-chain core of Coalition. It is a
round-scoped USDC pool on Arc testnet: a threshold-filling commit settles to
the provider inline; an unfilled expired round preserves individual refund
claims; and a dropout's stake stays in the round for the remaining agents.
See the repository [judge guide](../JUDGES.md) for how this component connects
to identity, resource enforcement, and resale.

Solidity `0.8.30`, optimizer on.

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

## Deploy via Circle Contracts (Smart Contract Platform)

`app/deploy-pool-circle.mjs` deploys the same compiled `ResourcePool` through
Circle Contracts (`@circle-fin/smart-contract-platform`) on Arc Testnet with
no local key. Foundry stays the compiler:

```sh
(cd contracts && forge build)          # foundry.toml pins evm_version = "paris"
cd ../app && set -a; source .env; set +a
USDC=0x3600000000000000000000000000000000000000 PROVIDER=0x... TARGET=10000000 \
  DEADLINE=1893456000 REPUTATION_REGISTRY=0x8004B663056A597Dffe9eCcC1965A193B7388713 \
  RESOURCE_URI=ipfs://... MAX_PARTICIPANTS=200 \
  node deploy-pool-circle.mjs
```

Requires `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, and a deployer wallet id
(`CIRCLE_DEPLOYER_WALLET_ID`, else `CIRCLE_PROVIDER_WALLET_ID`) — an
ARC-TESTNET developer-controlled wallet funded with testnet USDC, since the
deployer pays gas. The script prints the deployed
address plus the env lines to repoint the stack. `evm_version = "paris"` in
`foundry.toml` is load-bearing for this path: Circle Contracts on Arc rejects
Shanghai/PUSH0 bytecode compiled by the Solidity ≥0.8.20 default.
