# Demo agent loop — deterministic 4-agent seeds + LLM-driven skill flow

SPEC ONLY. No on-chain writes, fund moves, or CLI wallet commands are executed
by this document or by `demo/agents.seeds.json`. All commands below are
reference syntax for the demo operator / LLM to run live on video.

## 0. Sources of truth (read before running)

| Area | File / endpoint | Symbols used (do not invent others) |
|---|---|---|
| Pool reads/writes | `sdk/src/pool/client.ts` | `getPoolState`, `wouldExceedTarget`, `commitToPool`, `getPoolMetadata` |
| Pool rules | `contracts/src/ResourcePool.sol` | `commit` (approve-first, `OverTarget`, `maxParticipants`), `settle` (only when filled), `dropOut`/`finalizeExpired`/`claimRefund` |
| Reputation | `sdk/src/reputation/client.ts` | `getReputationSummary` (`clientAddresses` must be non-empty), `readFeedback` |
| ENS identity (live) | `sdk/src/ens/client.ts`, `sdk/src/demo/client.ts` | `resolveEnsToAgents` (subname → Arc wallet → agent ids), `resolveSeedAgents` / `resolveSeedAgent` (seed-order ENS-first resolution with wallet cross-check), `DEMO_SEED_AGENTS` |
| Resale quotes | `sdk/src/market/quotes.ts` | `fetchQuote` (`GET /quote?seller=`), `quoteCost` |
| Orchestrator | `orchestrator/README.md` | `GET /terms.json`, `GET /quote`, `POST /allocate` (operator `X-App-Key`), `POST /run` (agent bearer token) |
| Wallet skills | `plans/circle-agent-kit.md` §§3–6 | System A runtime skills: `setup`, `wallet-login`, `wallet-fund`, `wallet-pay`, `discover-services`; System B dev skills; §4 Arc runbook (`ARC-TESTNET`); §6 Nanopayments CLI buyer flow |
| Enforcer (reference only) | `orchestrator/internal/backend/docker.go` | Container enforcement behind `/allocate` + `/run`; flow below stays chain-accurate and does not depend on its internals |

Fixed context: pool `0xC6f9A1559f9a02755aC7Ba4865C558B0ed46B4fd`,
target `10.00` USDC = `10000000` atomic (6-dec ERC-20 view), Arc `5042002`,
RPC `https://rpc.testnet.arc.network` (SDK canonical `https://rpc.testnet.arc.io`
per `sdk/src/chains/arc.ts` — either reaches testnet).

## 1. Seeds (`demo/agents.seeds.json`)

4 of the 5 funded wallets. The 5th is held back as the outside resale buyer
and never commits. Funding is Circle Developer-Controlled Wallets only:
`CIRCLE_WALLET_IDS[i]` maps to `SEED_META[i].ensName` (agent`i+1`). No
self-custody path exists (`app/lib/seed-keys.ts`,
`~/.coalition/seed-keys.json`, `SEED_KEYS_FILE`, `SEED_PRIVATE_KEYS`, and
`fund-pool.mjs` for agent funding are removed).

| # | subname (`ensName`) | Circle funder (`CIRCLE_WALLET_IDS[i]`, ENS cross-check, no fallback) | cpu | mem | share |
|---|---|---|---|---|---|
| agent-1 | `agent1.agentpool.eth` | `0x4f188f3da697984f0fc02e61fda4a34b00abf39a` | 0.2 | 800 MB | $2.50 = `2500000` atomic |
| agent-2 | `agent2.agentpool.eth` | `0x8c4d4ca5fe56c4aef3e7b424879f25693e9d5a2b` | 0.15 | 600 MB | $2.50 = `2500000` atomic |
| agent-3 | `agent3.agentpool.eth` | `0xde086aa43915670c74444b3e5a464d992e1f7770` | 0.1 | 400 MB | $2.50 = `2500000` atomic |
| agent-4 | `agent4.agentpool.eth` | `0x0a6415e892972214bceb0271746cb45932f7eaf1` | 0.25 | 1000 MB | $2.50 = `2500000` atomic |

Held out: `0x2e07588b8180c8235c2a1be7ffa2639545630dd1` (resale buyer,
optional `agent5.agentpool.eth` — never commits, stays outside the loop).

Parent `agentpool.eth`, Arc coin type `2152525650` (`ARC_COIN_TYPE`,
`0x80000000 | 5042002`) — see the `ens` block in `demo/agents.seeds.json`
and `sdk/src/demo/seeds.ts` (`DEMO_SEED_AGENTS`, same order, same values).
`ensName` is the live identity; the Circle funder address is the ENS
cross-check (resolved Arc wallet must equal `CIRCLE_WALLET_IDS[i]`).
There is no fallback: an unresolved seed carries no wallet and cannot run;
`resolveSeedAgents` returns `unresolved` with a reason. Sequential order
agent-1 to agent-4 is unchanged. `CIRCLE_PROVIDER_WALLET_ID` is funder 4
(`0x0a6415e892972214bceb0271746cb45932f7eaf1`), so agent4 is also the pool
provider. Demo pool round 11 is settled: open a fresh round before funding.
`CIRCLE_TREASURY_WALLET_ID` (App Kit `kit.send` re-funding rail) is
currently UNSET (503 until set) and must not be the provider.

Totals: cpu `0.70 / 1.0`, mem `2800 / 4096 MB` (fits orchestrator defaults
`CPU_UNITS=1`, `MEM_MB=4096`, `MAX_AGENTS=5`); funding `10.00 / 10.00` —
4 x 2.50 fills the target exactly, no headroom remains. `agentId` is `null` in seeds —
filled at runtime via `registerAgent`; seeds stay deterministic pre-registration.
Agent-2 is the designated deliberate-dropout candidate per the Days 6–7/9 plan
(decision made live, never pre-scripted in the seed file).

## 2. Button trigger — single entrypoint

One action starts the whole loop. No randomness: seeds load verbatim, agents
run sequentially in seed order (agent-1 → agent-4) so `totalCommitted` grows
deterministically and the video has stable timestamps.

### 2a. CLI entry

```sh
npm run demo:agents
```

Proposed `sdk/package.json` addition (spec — not added by this change):

```json
{ "scripts": { "demo:agents": "node --no-warnings demo/run-agents.mjs" } }
```

Runner contract (`demo/run-agents.mjs`, to be written at demo-build time):

1. `readFile demo/agents.seeds.json` — parse, freeze (`Object.freeze`), no RNG.
2. For each seed in order: build `SkillInput` (§5), run the LLM skill chain
   (§§3–4), append one `DecisionLog` line (§4e).
3. Exit non-zero on any unexpected exception; `skip` decisions are normal
   output, not errors.

### 2b. Request / response shapes

The "button" is either the CLI above or a single POST that enqueues the same
runner (pick one for the video; both shapes are fixed):

```text
POST /demo/agents  (Content-Type: application/json)
{ "seeds": "demo/agents.seeds.json", "dryRun": true }
→ 202 { "runId": "demo-YYYYMMDD-001", "agents": 4, "mode": "sequential" }
```

Per-agent result (also the `DecisionLog` line shape):

```ts
type AgentDecision =
  | { agent: "agent-1" | "agent-2" | "agent-3" | "agent-4";
      decision: "join"; reason: string; amountAtomic: "2500000";
      poolFillBefore: string; poolFillAfter: string;
      approveHash: `0x${string}`; commitHash: `0x${string}` }
  | { agent: "agent-1" | "agent-2" | "agent-3" | "agent-4";
      decision: "skip"; reason: string; amountAtomic: "0";
      poolFillBefore: string; poolFillAfter: string;
      approveHash: null; commitHash: null };
```

`reason` is a human string (e.g. `"fill 8.00/10.00 allows +2.00; no dropout tag"`).
`dryRun: true` runs steps (a)–(c) + prompt and logs `join|skip` with null hashes.

## 3. Skill flow per agent

Each agent runs the same 5-step chain. Steps (a)–(b) are reads; (c) is the LLM
decision; (d) executes only on `join`; (e) always logs.

### (a) Discover the pool — Subgraph MCP first, GraphQL fallback

LLM natural-language query via the Subgraph MCP (pool fill %, prior dropouts):

```text
"Pool 0xC6f9A1559f9a02755aC7Ba4865C558B0ed46B4fd on Arc 5042002:
 current totalCommitted vs target, participant count, and any DroppedOut events?"
```

Deterministic fallback when MCP is unavailable — same question as GraphQL:

```graphql
query PoolStatus($pool: ID!) {
  pool(id: $pool) {
    totalCommitted target participantCount settled expired
    commits { agent amount }
    dropouts { agent forfeited }
  }
}
# variables: { "pool": "0xc6f9a1559f9a02755ac7ba4865c558b0ed46b4fd" }
```

Cross-check on-chain (read-only) before deciding:

```ts
import { getPoolState } from "@jx-nexus/coalition";
const state = await getPoolState({ publicClient, pool });
// state: { target, totalCommitted, settled, expired, participantCount }
```

Also fetch `GET /terms.json` (the on-chain `resourceURI` target) so the LLM
quotes live terms, and optionally `getPoolMetadata` for `maxParticipants` /
`resourceURI` / `feedbackCursor`.

### (b) Identity + reputation check, ENS-first, wallet cross-check, no fallback

Each seed resolves live before anything else. The runner calls
`resolveSeedAgents({ sepoliaClient, arcClient, seeds: DEMO_SEED_AGENTS,
reviewers: [provider, ...committedPeers] })` (Sepolia via the viem `sepolia`
preset; Arc reads are free log/call reads). Per seed, in seed order:

1. `resolveEnsToAgents({ sepoliaClient, arcClient, name: seed.ensName })`:
   subname → Arc wallet (`ARC_COIN_TYPE`) → agent ids (`findAgentsByOwner`
   on `Registered` logs, zero gas).
2. The resolved Arc wallet **must equal** the seed `wallet`
   (case-insensitive compare). Mismatch = `unresolved` with reason
   `"arc wallet mismatch for \"<ensName>\": ENS resolves to <actual>,
   seed expects <expected>"`, and the agent cannot run. No wallet is
   carried on failure (`fallbackWallet` removed).
3. Per agent id: `resolveAgent` (URI + bound wallet) plus
   `getReputationSummary` over the reviewers, then the dropout scan —
   `readFeedback` per reviewer per index, failing on any unrevoked entry
   with `tag1 === "dropout"` and `value < 0`.

```ts
import { resolveSeedAgents } from "@jx-nexus/coalition";

const resolutions = await resolveSeedAgents({
  sepoliaClient, arcClient,
  seeds: DEMO_SEED_AGENTS, // ensName live, wallet cross-check
  reviewers: [provider, ...committedPeers], // MUST be non-empty (Sybil rule)
});
for (const r of resolutions) {
  if (r.status === "unresolved") continue; // reason logged, no wallet, agent cannot run
  for (const a of r.agents) {
    if (a.dropout) continue; // skip: dropout tag from ${a.dropoutClient}
    // a.agent (resolveAgent) + a.summary (getReputationSummary) feed the gate
  }
}
```

Null handling (never crash, never abort the loop, one missing record does
not stop the other three; unresolved means the agent cannot run):

- No Arc record (`resolveEnsToAgents` returns `null`) → `unresolved` with
  reason `"no Arc record for \"<ensName>\""`; no wallet is carried and the
  runner cannot proceed for that seed.
- Wallet mismatch → `unresolved` with the mismatch reason above (identity
  stays strict; no fallback mode exists).
- Zero agent ids for a matching wallet → `resolved` with `agents: []`
  (no history = pass with reason `"no history"`, same as the legacy rule).

Pass rule (unchanged): `summary.count > 0n` (or zero-history = pass with
reason `"no history"`) AND no unrevoked `dropout` tag with negative value.
The legacy direct-`getReputationSummary`-by-`agentId` path remains for
entries already resolved; the scored path above is now the default first.

### (c) Join / skip gate (deterministic inputs → LLM judgment)

Join IFF **all** hold, else skip with a reason string:

1. `settled === false && expired === false` (from `getPoolState`);
2. capacity: `wouldExceedTarget(state, 2500000n) === false` **and**
   `participantCount < maxParticipants` (from `getPoolMetadata`);
3. reputation passes per (b) — no unrevoked `dropout` tag.

```ts
import { wouldExceedTarget } from "@jx-nexus/coalition";
const fits = !wouldExceedTarget(state, 2500000n); // 2500000n = $2.50
```

Skip reasons are fixed strings, e.g. `"skip: would exceed 10.00 target"`,
`"skip: pool settled/expired"`, `"skip: maxParticipants reached"`,
`"skip: dropout tag from <client>"`, `"skip: ENS unresolved — …"`,
`"skip: ENS resolution unavailable …"`. An unresolved seed cannot join.
A skip never touches the wallet.

### (d) Commit, approve first then commit (join path only)

Funding requires ENS attestation: `POST /api/agents/fund` resolves each
`SEED_META[i].ensName` live and requires `funderWallet == ENS wallet`
(case-insensitive). A funder whose Circle address != the live
`agentN.agentpool.eth` record fails the step with no transaction: no
approve, no commit, no allocate. `FundStep` carries `wallet` (funder
address), `ensName`, `ensWallet`, `funderWallet`, `ensAttested`. No fallback
wallet exists anywhere. `POST /api/agents/run` is a dry-run that resolves
every seed live under the same rule.

Agents sign via Circle Developer-Controlled Wallets (`CIRCLE_WALLET_IDS`):
index `i` maps to `SEED_META[i].ensName` (agent`i+1`), so
`CIRCLE_WALLET_IDS[i]`'s address must equal `agentN.agentpool.eth`'s Arc
record (verified 2026-09-11) — `POST /api/agents/fund` runs the `approve`
then `commit` through Circle (`circle wallet execute` / DCW), waits for
receipts, and provisions the orchestrator slice.
USDC `0x3600000000000000000000000000000000000000` (6-dec view).

CLI equivalent (same order, same cap rule; `--address` is the Circle funder):

```sh
circle wallet execute "approve(address,uint256)" \
  0xC6f9A1559f9a02755aC7Ba4865C558B0ed46B4fd 2500000 \
  --contract 0x3600000000000000000000000000000000000000 \
  --address 0x4f188f3da697984f0fc02e61fda4a34b00abf39a \
  --chain ARC-TESTNET
circle wallet execute "commit(uint256)" \
  2500000 \
  --contract 0xC6f9A1559f9a02755aC7Ba4865C558B0ed46B4fd \
  --address 0x4f188f3da697984f0fc02e61fda4a34b00abf39a \
  --chain ARC-TESTNET
```

Substitute `--address` per Circle funder:

| # | Circle funder `--address` |
|---|---|
| agent-1 | `0x4f188f3da697984f0fc02e61fda4a34b00abf39a` |
| agent-2 | `0x8c4d4ca5fe56c4aef3e7b424879f25693e9d5a2b` |
| agent-3 | `0xde086aa43915670c74444b3e5a464d992e1f7770` |
| agent-4 | `0x0a6415e892972214bceb0271746cb45932f7eaf1` |

SDK equivalent:

```ts
import { commitToPool, wouldExceedTarget } from "@jx-nexus/coalition";
if (!wouldExceedTarget(state, 2500000n))
  await commitToPool({ walletClient, account, pool, amount: 2500000n });
```

Pool rules honored (`contracts/src/ResourcePool.sol`): cap at target
(`OverTarget` revert mirrors `wouldExceedTarget`), `maxParticipants` enforced
in `commit`, `approve` before every `commit`, `settle` callable by anyone but
only when filled (`totalCommitted >= target`). Deliberate dropout (agent-2,
live decision only): `dropOut(agentId)` forfeits the stake, writes
`dropout/-1` feedback, and counts toward the MCP "prior dropouts" narrative.

### (e) Log decision + tx hash (video timestamps)

One JSON line per agent to stdout (and `demo/run-log.jsonl`), in seed order:

```json
{"t":"2026-09-08T12:00:01Z","agent":"agent-1","wallet":"0x0427194a…","decision":"join","reason":"fill 0.00/10.00 allows +2.50; no dropout tag","amountAtomic":"2500000","approveHash":"0x…","commitHash":"0x…"}
{"t":"2026-09-08T12:00:20Z","agent":"agent-2","wallet":"0xd1a3c0…","decision":"skip","reason":"skip: dropout tag from 0x…","amountAtomic":"0","approveHash":null,"commitHash":null}
```

The runner prints `poolFillBefore/After` (from `getPoolState` re-reads) beside
each line so the video can point at fill % climbing `0 → 2.5 → … → 10 / 10`.

## 4. How the LLM drives it

Deterministic values in, LLM reasoning out. The runner feeds a fixed prompt
template; the LLM returns exactly one JSON object — no prose, no tool calls
of its own (the runner already fetched everything).

### Prompt template

```text
You are the Coalition demo decider for {agentId} (wallet {wallet}, cpu {cpu}, mem {memMB}MB).
Share: $2.50 = 2500000 atomic. Pool 0xC6f9…B4fd, target 10.00 USDC (10000000 atomic).

Pool state (getPoolState): totalCommitted={totalCommitted} target={target} settled={settled} expired={expired} participantCount={participantCount}, maxParticipants={maxParticipants}.
wouldExceedTarget(+2500000) = {wouldExceed}.
Subgraph MCP: fill {fillPct}% — {mcpSummary}; prior dropouts: {dropouts}.
Reputation (getReputationSummary over [{clients}]): count={repCount} value={repValue} decimals={repDecimals}; readFeedback flags: {feedbackFlags} (any "dropout"/negative?).
Terms (GET /terms.json): {termsExcerpt}
Resale context (fetchQuote/quoteCost, informational only): {quoteExcerpt}

Join IFF pool open AND wouldExceed=false AND capacity remains AND no unrevoked dropout tag.
Return ONLY this JSON: {"decision":"join|skip","reason":"<short human string>","amountAtomic":"2500000|<0 on skip>"}
```

### Example filled inputs → outputs

```text
agent-1 @ empty pool: wouldExceed=false, no dropout tag
→ {"decision":"join","reason":"fill 0.00/10.00 allows +2.50; no dropout tag","amountAtomic":"2500000"}

agent-4 @ 7.50 committed: wouldExceed=false, fills the target exactly
→ {"decision":"join","reason":"fill 7.50/10.00 allows +2.50; no dropout tag","amountAtomic":"2500000"}

any further join @ 10.00 committed: wouldExceed=true
→ {"decision":"skip","reason":"skip: would exceed 10.00 target","amountAtomic":"0"}
```

`amountAtomic` echoes the seed (`"2500000"` on join, `"0"` on skip) — the LLM
never invents amounts. The runner enforces the gate independently: a `join`
with `wouldExceedTarget === true` is downgraded to `skip` before any wallet
command, so the LLM can never overfill the pool.

## 5. Resale coda (outside buyer, no commit)

After the 4-agent loop, the held-out buyer `0x2e07…` prices spare capacity
without joining — the §6 Nanopayments beat:

```sh
curl -s 'http://localhost:8080/quote?seller=0x4f188f3da697984f0fc02e61fda4a34b00abf39a'
circle services search "compute"   # discover-services skill
circle services pay https://seller.example/compute --address 0x2e07588b8180c8235c2a1be7ffa2639545630dd1 --chain ARC-TESTNET --max-amount 0.01
```

SDK form: `fetchQuote({ baseUrl, seller })` then `quoteCost(quote, { mb, cu })`
for exact bigint pricing. `POST /allocate` (operator key) and `POST /run`
(agent token) stay out of the funding loop — allocation happens after settle
via the settle→allocate listener, not inside this flow.

## 6. What this change adds (and does not)

- Adds: `demo/agents.seeds.json` (this doc's §1) + this doc.
- Does not: run any wallet/chain command; add `app/` Next.js code or
  `subgraph/` code; invent reputation APIs (only `getReputationSummary` /
  `readFeedback`); store OTPs, keys, or session tokens (Circle `wallet-login`
  sessions stay in the operator's live CLI session, never in files).
