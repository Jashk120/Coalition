# Coalition app

Next.js + TypeScript dashboard for the deterministic 4-agent pool flow.
It dogfoods the published `@jx-nexus/coalition` surface (local `file:../sdk`
dependency) — no SDK logic is copied into `app/`, and the UI performs no
on-chain writes.

## Dev commands (all run inside `app/`)

```sh
npm install
npm run dev     # local dashboard with hot reload
npm run check   # tsc --noEmit
npm run build   # production build
```

## Environment

Copy `.env.example` to `.env` and adjust. Only `NEXT_PUBLIC_*` values reach
the browser (pool address, chain id, orchestrator URL). RPC URLs and the
subgraph endpoint/API key are server-only and stay in route handlers.

`NEXT_PUBLIC_POOL_ADDRESS` must equal the orchestrator's `POOL_V2_ADDRESS`
when both point at the same pool, otherwise the dashboard funds one round
while the orchestrator tracks another. `ARC_RPC_URL` should be a private
endpoint when available: the public `rpc.testnet.arc.io` free tier 429s
under the combined polling load (dashboard agents state every 10s, activity
every 15s, orchestrator usage every 1s, plus the orchestrator settle poller
at `POLL_INTERVAL` 5s). Funding needs `CIRCLE_API_KEY`,
`CIRCLE_ENTITY_SECRET`, and `CIRCLE_WALLET_IDS` (create ARC-TESTNET wallets,
then fund each wallet with per-wallet USDC via faucet.circle.com; the
approve passes empty but the commit needs balance).

## Routes

- `/` — agents table, pool-fill progress, trigger button, decision log,
  on-chain activity, usage/budget + terms panels, outside-buyer panel.
- `GET /api/agents` — live `resolveSeedAgents` (seed order, skipped-with-reason
  fallback) plus pool state (subgraph first, chain `getPoolState` fallback).
- `POST /api/agents/run` — sequential dry-run decisions gated by
  `wouldExceedTarget`; returns `AgentDecision` lines with null hashes.
- `POST /api/agents/fund` — headless on-chain funding via Circle
  Developer-Controlled Wallets (parallel USDC approves, strictly sequential
  pool commits sharing one remainder snapshot, last commit auto-settles);
  returns `FundStep` lines with on-chain hashes, 503 without `CIRCLE_*` env.
  Each funded wallet also provisions its orchestrator slice (see Fund flow).
- `GET /api/activity` — pool `Committed` + `Settled` + `RoundStarted` events
  (chunked log scan from the pool deploy block), newest first; empty before
  the first commit. Served from a 60s server cache that goes stale instead
  of 502ing while throttled (502 only on a cold cache).
- `GET /api/quote?seller=0x…` — resale quote via SDK `fetchQuote`.
- `GET /api/terms` — orchestrator `/terms.json` relay.

## Fund flow (`app/api/agents/fund/route.ts`, `lib/circle-fund.ts`)

Phase 1 gates every wallet against one live round snapshot in seed order
(splitting the remainder across the wallets still to run, capped at the
standard share). Phase 2 fires all USDC approves in parallel via
`Promise.all`. Phase 3 commits strictly sequentially in seed order: commits
share the round remainder and the filling one settles inline, so they must
not race. Each commit round-trips Circle `getTransaction` at 1s plus jitter
with a 120s timeout. After each commit lands, the route provisions that
wallet's orchestrator slice; the allocate retries about every 750ms up to
about 12s on round-tracker-lag 409s only, and fails fast on terminal
`pool settled: allocations are final` denials. A failed allocate never flips
a funded step to failed (the money moved, it is only recorded on the step).

## Round reads (`lib/pool-state.ts`)

`readCurrentRound` is chain-first with a legacy round-0 fallback: v2 pools
serve `currentRoundId`/`getRoundState`, while a v1 pool reverts those calls
and is mapped onto round 0 with a zero deadline. Chain reads retry
rate-limits and transient timeout/network blips with 1.5s/3s/6s backoff.
When funding proceeds on the fallback, the route logs
`agents.fund.round-fallback` at warn. The activity log scan runs in 10k-block
chunks with 400ms spacing to stay under the public RPC throttle.

## Usage badges (`app/page.tsx`, orchestrator `GET /usage`)

`/usage` rows are allocation records, not liveness probes. The badge reads
`running` only while in-flight usage is above zero; `hasContainer` alone
renders `active`, which means bound-but-idle (entitlement held, container
attached, nothing executing). No container at all renders `no container`.

## Logging

Route handlers emit JSON lines to stdout (`app/lib/logger.ts`, no
dependencies): `agents.run.start/complete/decision`, `agents.resolve` (+
`agents.resolve.fallback` on degrade), `agents.read`, `quote.*`,
`terms.*`. Only public demo fields (counts, addresses, decisions,
durations) — never tokens, keys, or session material. Slow steps log at
`warn` automatically via `logTimed`.
