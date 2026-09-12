# Coalition — judge guide

## The project in one minute

**Agents buy compute together, then sell spare capacity to another agent.**

Imagine four agents that each need only part of a server. Coalition lets them
combine their budgets to fund one shared VPS. Each receives a compute slice;
an outside buyer can then pay for spare capacity, compensating participants
according to the resale payment plan.

The question to evaluate is: **can agent identity, pooled payment, resource
allocation, and resale work together in one observable lifecycle?**

Coalition lets autonomous agents jointly fund a resource that would be
uneconomical for each agent alone. In this MVP, the resource is a shared VPS:
four agents commit USDC to a threshold pool on Arc; the contract pays the
provider only when the target is reached, or preserves a refund path when the
round expires. Once funded, the orchestrator enforces each agent's compute
slice. An outside agent can purchase spare capacity, with one atomic USDC
payment split among the participants who have paid most relative to their use.

The differentiator is that the whole lifecycle is connected: ENSv2 proves who
may fund, Circle wallets submit the payments, the contract enforces pool
economics, The Graph supplies indexed state, and the orchestrator enforces the
off-chain resource that was bought.

## Fast evaluation path

### Watch for these three outcomes

| Stage | What to look for in the dashboard | What it demonstrates |
|---|---|---|
| Buy together | Pool funding reaches its target and the round becomes settled; inspect the funding transaction hashes | The final contribution triggers payment to the provider |
| Use the resource | “Each agent gets a share” shows participant allocations and usage | The orchestrator tracks the compute slices; confirm Docker enforcement in the deployment evidence |
| Sell spare capacity | Resale market previews recipients and amounts; after payment, check both the transaction and the buyer's allocation | Spare capacity can be purchased and participants compensated |

Funding settlement and compute allocation are separate steps. Likewise, the
resale payment is atomic across its payment legs, while quota delivery is an
off-chain operation. Verify both outcomes; a payment receipt alone does not
prove compute was delivered.

### Then inspect the evidence

1. Read the [root README](README.md) for the architecture and lifecycle.
2. Open `app/` to see the dashboard: identities, round state, funding, usage,
   and the resale buyer are all visible in one place.
3. Inspect [`contracts/src/ResourcePool.sol`](contracts/src/ResourcePool.sol)
   and [`contracts/test/ResourcePool.t.sol`](contracts/test/ResourcePool.t.sol)
   for the on-chain pooling, settlement, dropout, and refund rules.
4. Inspect [`app/app/api/agents/fund/route.ts`](app/app/api/agents/fund/route.ts)
   for the ENS-attested Circle-wallet funding path, and
   [`app/lib/resale-execute.ts`](app/lib/resale-execute.ts) for the atomic
   resale settlement.
5. Use the track receipts below for live addresses, transaction/query
   evidence, reproducibility, and stated limitations.

## What is actually implemented

| Capability | Where to verify |
|---|---|
| Threshold USDC pool, inline settlement, expiry refunds, dropout economics, reusable rounds | `contracts/` + [`contracts/README.md`](contracts/README.md) |
| ENSv2 name-to-Arc-wallet attestation before funding | `app/app/api/agents/fund/route.ts` + [`ENS.md`](ENS.md) |
| Circle Developer-Controlled Wallet funding, Circle Contracts deployment, App Kit treasury top-ups | `app/` + [`ARC.md`](ARC.md) |
| Indexed pool roster/state and a subgraph-gated resale decision | `subgraph/` + [`GRAPH.md`](GRAPH.md) |
| Docker-backed resource quotas and spare-capacity sale | `orchestrator/` + [`orchestrator/README.md`](orchestrator/README.md) |
| Reusable TypeScript client | `sdk/` + [`sdk/README.md`](sdk/README.md) |

## Suggested demo story

1. Resolve `agentN.agentpool.eth` to its Arc wallet; show that a mismatch is
   rejected before any funding transaction is sent.
2. Fund a fresh round. The final commit settles the pooled USDC to the VPS
   provider in that same transaction.
3. Show the subgraph-backed roster and the usage limits applied by the
   orchestrator.
4. Request spare capacity as agent 5. Show the generated payment plan, then
   the single Multicall3 settlement that pays eligible participants, then
   separately verify the orchestrator granted the buyer's quota.
5. For the unhappy path, show an expired round's refundable balances or a
   dropout's effect on the remaining participants.

## Quick local verification

The repository has separate packages rather than a root workspace. These are
the most useful checks for a code review:

```sh
npm install --prefix sdk && npm run check --prefix sdk && npm test --prefix sdk
npm run build --prefix sdk
npm install --prefix app && npm run check --prefix app && npm run build --prefix app
(cd contracts && forge test)
(cd orchestrator && go test ./...)
```

Live services need their documented environment variables and testnet funding;
the code checks above do not submit transactions or require credentials.

## Evidence and scope

- [Arc / Circle receipt](ARC.md) — deployed pool, Circle product mapping, and
  explicit scope limits.
- [The Graph receipt](GRAPH.md) — deployed Studio subgraph, query evidence,
  and indexing limits.
- [ENSv2 receipt](ENS.md) — names, resolver state, wallet alignment, and beta
  caveats.
- [ENS bring-up record](DEBUG-1.md) — historical troubleshooting evidence;
  use `ENS.md` as the current source of truth.

This is an Arc-testnet MVP. The receipts deliberately distinguish shipped
paths from planned or unavailable integrations; judges should score the
implemented paths above rather than inferred future work.
