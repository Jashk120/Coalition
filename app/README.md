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

## Routes

- `/` — agents table, pool-fill progress, trigger button, decision log,
  on-chain activity, usage/budget + terms panels, outside-buyer panel.
- `GET /api/agents` — live `resolveSeedAgents` (seed order, skipped-with-reason
  fallback) plus pool state (subgraph first, chain `getPoolState` fallback).
- `POST /api/agents/run` — sequential dry-run decisions gated by
  `wouldExceedTarget`; returns `AgentDecision` lines with null hashes.
- `GET /api/activity` — pool `Committed` + `Settled` events (chunked log scan
  from the pool deploy block), newest first; empty before the first commit.
- `GET /api/quote?seller=0x…` — resale quote via SDK `fetchQuote`.
- `GET /api/terms` — orchestrator `/terms.json` relay.

## Logging

Route handlers emit JSON lines to stdout (`app/lib/logger.ts`, no
dependencies): `agents.run.start/complete/decision`, `agents.resolve` (+
`agents.resolve.fallback` on degrade), `agents.read`, `quote.*`,
`terms.*`. Only public demo fields (counts, addresses, decisions,
durations) — never tokens, keys, or session material. Slow steps log at
`warn` automatically via `logTimed`.
