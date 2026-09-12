# ARC.md: Circle DeFi + Circle Agentic Economy submission receipt

**Overall: Arc is load-bearing, not cosmetic.** Coalition settles its N-agent
pooling contract (`ResourcePool`) on Arc testnet, moves USDC through Circle
Developer-Controlled Wallets, settles a resale buy as one atomic Multicall3 USDC
aggregate, and uses Arc's native ERC-8004 identity and reputation registries.
Gas is paid in native USDC. This single receipt covers both Circle tracks under
the ETHOnline 2026 Arc partner slot: **Circle DeFi** and **Circle Agentic
Economy**.

Repo is PUBLIC: https://github.com/Jashk120/Coalition.

## 1. Qualification fit (per track requirement)

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 1 | Working frontend + backend + reusable SDK | PASS | `app/` (Next.js dashboard), `orchestrator/` (Go service, stdlib only), `sdk/` (`@jx-nexus/coalition`, consumed by the app via `file:../sdk`) |
| 2 | Custom `ResourcePool` (N-way threshold pooling) | PASS (live) | `contracts/src/ResourcePool.sol`; deployed at `0x8b9f…F692` on Arc testnet, deploy tx `0xb314…a279` (§3) |
| 3 | Native ERC-8004 identity + reputation | PASS on integration, PARTIAL on live outcomes | SDK `identity/` + `reputation/` wrappers (`registerAgent` / `resolveAgent` / `findAgentsByOwner`; `getReputationSummary` / `readFeedback`); the pool writes objective outcomes via `IPoolReputation.giveFeedback` and is Forge-tested. No live dropout/completion feedback transaction is recorded (§6, §10) |
| 4 | Agent-initiated USDC transactions | PASS via Circle Developer-Controlled Wallets | `POST /api/agents/fund` drives DCW `approve` + `commit` on Arc; no local keys and no self-custody path (§4.1) |
| 5 | Circle App Kit "where relevant" | PASS | `POST /api/agents/treasury` uses App Kit `kit.send` to re-fund agents on Arc Testnet (§4.2) |
| 6 | Circle Contracts (Smart Contract Platform) | PASS | `app/deploy-pool-circle.mjs` deploys `ResourcePool` through Circle Contracts on `ARC-TESTNET` (§4.3) |
| 7 | x402 / Nanopayments resale rail as a complement | PASS (server-side) | `POST /api/resale/quota` settles through Circle Gateway middleware on `eip155:5042002`; the atomic buyer settlement itself is Multicall3 + USDC (§4.4, §4.5) |
| 8 | Public GitHub repo + receipt | PASS | Repo public; this file |
| 9 | Demo video | PENDING | Not yet published (§10) |
| 10 | Architecture diagram | PASS | §2 |
| 11 | Business narrative | PASS | §9 |

## 2. Architecture at a glance

```text
┌────────────────────── Arc testnet (chain 5042002, gas in native USDC) ──────────────────────┐
│                                                                                             │
│   ERC-8004 IdentityRegistry             ERC-8004 ReputationRegistry                          │
│   0x8004A818…BD9e                        0x8004B663…8713                                    │
│   (agent identity, SDK reads)            (feedback graph; pool writes objective outcomes)   │
│                                                                                             │
│   ResourcePool  0x8b9f38c7B005Dd67203e27240F45335a9e64F692                                  │
│   commit / dropOut / settle / finalizeExpired / claimRefund / recordCompletions              │
│   ── USDC 0x3600…0000 (6-dec ERC-20 view) ── provider payout on threshold ──►               │
│                                                                                             │
│   Circle Developer-Controlled Wallets ── approve + commit                                    │
│   Multicall3 0xcA11…CA11 ── atomic transferFrom resale settlement                           │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲                                        │ events
        │ ENS subname → Arc wallet (Sepolia)     ▼
   agentN.agentpool.eth                  Subgraph Studio (arc-testnet)
                                         coalition-resource-pool (ID 1760135)
```

Identity/discovery is ENSv2 (§`ENS.md`), indexing is The Graph (§`GRAPH.md`), and
Arc is the settlement, wallet, and agent-standard layer documented here.

## 3. Arc deployment facts

| Fact | Value |
|---|---|
| Network | Arc testnet |
| Chain id / CAIP-2 | `5042002` / `eip155:5042002` |
| RPC (canonical) | `https://rpc.testnet.arc.io` (viem preset carries `rpc.testnet.arc.network` as fallback) |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com` |
| Gas token | Native USDC, 18 decimals (ERC-20 view of the same balance: 6 decimals) |
| USDC (ERC-20, pool token) | `0x3600000000000000000000000000000000000000` |
| Arc ENS coin type | `2152525650` (`0x80000000 \| 5042002`) |
| `ResourcePool` (current) | `0x8b9f38c7B005Dd67203e27240F45335a9e64F692` |
| Pool deploy tx | `0xb314fdfeeb9a873b84fa90f9ab38126e30d1ccbebf80375227f73d5a5271a279` |
| Pool deploy block | `61221987` (2026-09-09T10:09:42Z) |
| Deployer | `0x78F31B03De0E6473db80f2Da8c1a1cf5DB44A42a` |
| Provider (settle payee) | `0x0a6415E892972214BCEb0271746CB45932F7EaF1` (agent-4 / funder 4) |
| Target | `10000000` atomic = 10.00 USDC |
| `maxParticipants` / cap | `4` / `10` |
| `resourceURI` | `ipfs://coalition-v2-judges` |
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Circle GatewayWallet (testnet) | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| Circle Gateway facilitator | `https://gateway-api-testnet.circle.com` |

The `ResourcePool` constructor order (matches `app/deploy-pool-circle.mjs`):
`(usdc, provider, target, deadline, reputationRegistry, resourceURI, maxParticipants, maxParticipantsCap)`.

## 4. Circle products used

### 4.1 Circle Developer-Controlled Wallets — agent funding

- Package: `@circle-fin/developer-controlled-wallets` (`app/package.json`).
- Helper: `app/lib/circle-fund.ts` — `initiateDeveloperControlledWalletsClient`,
  `createContractExecutionTransaction`, `getTransaction`, `getWallet`, wrapped by
  `executeContractAndWait` (submits, polls to CONFIRMED/COMPLETE, 120s timeout).
- Route: `POST /api/agents/fund` (`app/app/api/agents/fund/route.ts`). Phase 1
  attests each funder against its ENS subname (`funderWallet === ENS wallet`);
  phase 2 fires the USDC `approve(address,uint256)` calls; phase 3 commits
  strictly sequentially with `commit(uint256)` / `commit(uint256,uint256)`.
- Env (server-only): `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`,
  `CIRCLE_WALLET_IDS`, `CIRCLE_PROVIDER_WALLET_ID`, `CIRCLE_BUYER_WALLET_ID`.
- Custody: Circle co-signs; there are no local keys and no `seed-keys.ts` /
  `SEED_PRIVATE_KEYS` path in the repository.

### 4.2 Circle App Kit — treasury re-funding rail

- Packages: `@circle-fin/app-kit`, `@circle-fin/adapter-circle-wallets`.
- Helper: `app/lib/appkit.ts` — `new AppKit()`, `createCircleWalletsAdapter`,
  `kit.send({ from, to, amount, token: "USDC" })` on App Kit chain `Arc_Testnet`.
- Route: `POST /api/agents/treasury` tops each agent wallet up to
  `CIRCLE_TREASURY_FUND_USDC` (default 2.50) only when its on-chain balance is
  below target, so it is idempotent. App Kit cannot call arbitrary contracts, so
  `approve` + `pool.commit` stays on the DCW path (§4.1).
- Env (server-only): `CIRCLE_TREASURY_WALLET_ID`, `CIRCLE_TREASURY_FUND_USDC`.

### 4.3 Circle Contracts (Smart Contract Platform) — deployment

- Package: `@circle-fin/smart-contract-platform`.
- Script: `app/deploy-pool-circle.mjs` — `initiateSmartContractPlatformClient`,
  `deployContract({ blockchain: "ARC-TESTNET", walletId, abiJson, bytecode,
  constructorParameters })`, then `getContract` polling to `COMPLETE`. Foundry
  stays the compiler; `contracts/foundry.toml` pins `evm_version = "paris"`
  so Circle Contracts accepts the bytecode.
- Env: `CIRCLE_DEPLOYER_WALLET_ID` (defaults to `CIRCLE_PROVIDER_WALLET_ID`).

### 4.4 Circle Gateway + x402 — resale quota leg

- Packages: `@circle-fin/x402-batching` (server middleware), `@x402/core`,
  `@x402/evm`.
- Route: `POST /api/resale/quota` — `createGatewayMiddleware({ sellerAddress,
  networks: ["eip155:5042002"], facilitatorUrl:
  "https://gateway-api-testnet.circle.com" })`. Unpaid callers get `402` +
  `PAYMENT-REQUIRED`; paid callers get `{ settlementId, amountAtomic, seller }`,
  where `settlementId` is the Gateway settle transaction surfaced by the
  middleware (`app/app/api/resale/quota/route.ts`). The orchestrator
  `/transfer-quota` verifies that settlement id.
- `app/lib/constants.ts` carries the rail config: `RESALE_NETWORK`
  (`eip155:5042002`), `RESALE_FACILITATOR_URL`, `RESALE_GATEWAY_WALLET`.

### 4.5 Multicall3 atomic resale settlement (with DCW)

- Helper: `app/lib/resale-execute.ts` (`executeResaleBuy`) — buyer USDC
  `approve(address,uint256)` to Multicall3, then one
  `aggregate((address,bytes)[])` of `transferFrom` payout legs
  (`app/lib/resale.ts` `buildSettlementCalls`), then the orchestrator
  `/commit-mint` against that single settlement hash.
- Buyer wallet: `CIRCLE_BUYER_WALLET_ID` (agent-5, held out of
  `CIRCLE_WALLET_IDS`), paid from its own on-chain USDC balance — no Gateway
  deposit is needed for this path.

## 5. Contract methods and parameters

Funding and lifecycle calls are issued through Circle DCW contract execution
(`abiFunctionSignature` + decimal-string `abiParameters`):

| Call | Signature | Params |
|---|---|---|
| Approve | `approve(address,uint256)` | USDC `0x3600…0000`, amount in 6-dec atomic |
| Commit (v1 shim) | `commit(uint256)` | amount |
| Commit (v2 round) | `commit(uint256,uint256)` | roundId, amount |
| Start round | `startRound(uint256,uint64,uint256)` | target, durationSec, maxParticipants |
| Finalize expired | `finalizeExpired(uint256)` | roundId |
| Resale settlement | `aggregate((address,bytes)[])` | one `transferFrom(buyer, seller, amount)` per fill-plan output, wallet-asc |

The pool also exposes `dropOut`, `settle`, `claimRefund`, `recordCompletions`,
and `bindAgentId`; the single-argument v1 overloads forward to the current round.
The happy path needs no separate `settle` call: the commit that fills the target
pays the provider inline and emits both `Settled(uint256)` and
`Settled(uint256,uint256)`.

## 6. Native ERC-8004 identity and reputation

- Identity: `sdk/src/identity/` — `registerAgent(metadataURI)` (parses the
  `Registered` event for the new `agentId`), `setAgentWallet` (EIP-712/1271
  wallet binding), `resolveAgent` (`tokenURI` + `getAgentWallet`), and
  `findAgentsByOwner` (a `balanceOf` fast path plus an indexed `Registered`
  log scan from `IDENTITY_REGISTRY_FROM_BLOCK` because the public Arc RPC
  prunes early history).
- Reputation: `sdk/src/reputation/` — `getReputationSummary`
  (`getSummary(uint256,address[],string,string)`, clients must be non-empty) and
  `readFeedback(uint256,address,uint64)`. The demo resolution path reads both
  and flags an unrevoked `dropout` tag with a negative value.
- Pool → reputation: `contracts/src/ResourcePool.sol` writes objective outcomes
  (`dropout = -1`, `completion = +1`) through `IPoolReputation.giveFeedback`
  (`try/catch`, best-effort), covered by `contracts/test/ResourcePool.t.sol`.
- ENS composition: `resolveEnsToAgents` chains the Sepolia subname to the Arc
  wallet (`coinType 2152525650`) to `findAgentsByOwner` and per-agent
  reputation — see `ENS.md` §7b for the load-bearing enforcement.

## 7. Live verification

- **Deploy receipt (Arc).** `ResourcePool` at `0x8b9f…F692`, deploy tx
  `0xb314…a279`, block `61221987`, from `0x78F3…A42a`
  (`contracts/broadcast/Deploy.s.sol/5042002/run-latest.json`).
- **Indexed pool state (2026-09-11).** Via the `arc-testnet` subgraph
  (`_meta.hasIndexingErrors = false`, `_meta.block.number = 61567239`): one
  `Pool` (`0x8b9f…F692`), target `10000000`, `totalCommitted` `110000000`,
  `settled` `true`, `participantCount` `47`, 47 commitments, 0 dropouts. Full
  query and reproduce steps are in `GRAPH.md` §3.
- **ENS ↔ Arc wallet (2026-09-11).** All four `agentN.agentpool.eth` subnames
  resolve to the Circle funder wallets via `cast` against Sepolia, independent
  of the repo's earlier receipts (`ENS.md` §3).
- **Circle credentials.** The Circle environment is server-only; missing
  `CIRCLE_*` env returns a 503 with a setup hint rather than a partial run
  (`app/lib/circle-fund.ts`).

Re-query the subgraph and explorer at demo time; counts move as the pool does.

## 8. Feature map

| Feature | Status | Coalition usage |
|---|---|---|
| Arc testnet (chain 5042002) | USED | `ResourcePool`, USDC, native-USDC gas, dual-decimal handling in `sdk/src/chains/` |
| Native USDC gas (18-dec native / 6-dec ERC-20) | USED | All on-chain amounts are `bigint` atomic; `toAtomicUsdc` / `fromAtomicUsdc` keep the 10¹² gap explicit |
| ERC-8004 IdentityRegistry | USED (SDK reads; runtime registration available) | `registerAgent` / `resolveAgent` / `findAgentsByOwner` |
| ERC-8004 ReputationRegistry | USED (reads + contract writer) | SDK reads gate the demo; the pool writes objective dropout/completion feedback |
| Custom `ResourcePool` | USED (live) | `0x8b9f…F692` |
| Circle Developer-Controlled Wallets | USED (live) | Agent funding, resale buyer, deployer, treasury source |
| Circle App Kit | USED | Treasury `kit.send` re-funding rail |
| Circle Contracts (SCP) | USED | `deploy-pool-circle.mjs` |
| Circle Gateway / x402 | USED (server-side) | `POST /api/resale/quota` per-seller 402 + settlement id |
| Multicall3 atomic resale | USED | `executeResaleBuy` aggregate settlement |
| Circle Agent Stack *Agent Wallets* | NOT USED | The 2-of-2 MPC Agent Wallet path is documented in planning but not shipped; Developer-Controlled Wallets are the working custody path |
| Circle wallet policies | NOT USED | `wallet limit` is mainnet-only; pool-address checks and caps are enforced in the contract/SDK instead |
| Agent Marketplace | NOT USED | Discovery runs through ENS + The Graph |
| ERC-8183 escrow | NOT USED | Its 1:1:1 model cannot express N-way pooling; `ResourcePool` is the only custom escrow |

## 9. Business narrative

Agent infrastructure is priced for a single user but used by many partial ones:
an H100 at roughly $20/hr is wasted on one agent that consumes a fraction of it.
Coalition lets a fleet of agents pool USDC on Arc toward one shared resource,
settle atomically to the provider at the threshold, and refund everyone if the
target is missed; an agent that drops out after committing forfeits its stake
to the rest and takes an ERC-8004 reputation hit. Because equal payment is not
equal usage, an outside agent can buy the spare capacity through the resale
rail, compensating the most-overpaying participants until the pool's
cost-to-compute ratios trend back toward 1:1. Arc supplies the settlement layer
(gas in USDC, sub-second finality), Circle supplies agent-controlled USDC
custody and App Kit movements, and ERC-8004 supplies portable identity and
reputation — the pieces a multi-agent pooling protocol needs and should not
rebuild.

## 10. Scope and limitations

- Agent funding uses **Circle Developer-Controlled Wallets**, not Circle Agent
  Stack Agent Wallets. The Agent Wallet path (2-of-2 MPC, `circle` CLI skills)
  is documented but was not shipped; do not present it as live.
- Circle **wallet policies** are mainnet-only and are not used on testnet; the
  pool enforces contribution caps on-chain instead.
- The ERC-8004 **objective-outcome loop** (dropout/completion → reputation) is
  implemented in `ResourcePool` and Forge-tested, but no live dropout or
  completion feedback transaction is recorded, and the live funding route
  attests ENS without minting/binding an `agentId`. Treat the live ERC-8004
  usage as reads plus an available writer, not as a proven live feedback write.
- **No Arc pool funding/settle/resale transaction hashes are checked into the
  repo.** Live funding evidence lives in the subgraph's `Commitment` /
  `Settlement` entities (`GRAPH.md` §3); re-query the subgraph and explorer at
  demo time.
- The x402/Gateway rail covers the server-side resale quota leg; the buyer's
  actual settlement is a DCW + Multicall3 aggregate, not an x402 payment.
- `app/lib/constants.ts` still carries the earlier v1 pool address
  (`0xC6f9…B4fd`) as a code fallback; the live deployment and every checked-in
  config point at `0x8b9f…F692` (`.env.example`, subgraph manifest, deploy
  broadcast). Read `NEXT_PUBLIC_POOL_ADDRESS` from env as the source of truth.
- The demo video and live demo URL are not yet published.
