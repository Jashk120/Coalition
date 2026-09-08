# Coalition orchestrator

Go service enforcing paid resource limits on the shared VPS via Docker. It
serves the resale-market endpoints and generates the pool terms document live
from its own config. Stdlib only — no third-party dependencies.

## Run

```sh
PORT=8080 PROVIDER_ADDRESS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 go run ./cmd/orchestrator
```

With Docker:

```sh
docker build -t coalition-orchestrator .
docker run -p 8080:8080 -v /var/run/docker.sock:/var/run/docker.sock \
  -e PROVIDER_ADDRESS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
  coalition-orchestrator
```

Without a reachable daemon the service boots on the in-memory backend (loud
startup warning) and still serves terms/quotes/metering; container enforcement
is inert until a daemon appears. With `REQUIRE_DOCKER=1` an unreachable daemon
is fatal instead — use it in production so the service never bills for
enforcement that is not there.

## Environment

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `RESOURCE_NAME` | `Coalition Pool #1` | no | Pool display name used in `/terms.json` |
| `CPU_UNITS` | `1` | no | Total pool CPU cores; per-wallet slices must fit. `NaN`/`Inf` rejected |
| `MEM_MB` | `4096` | no | Total pool memory in MB |
| `MAX_AGENTS` | `5` | no | Cap on distinct wallets holding entitlement; re-allocate/top-up of an existing wallet never counts against it |
| `TARGET_USDC` | `10.00` | no | Funding target, decimal USDC (6-decimal atomic view). Format: digits with optional `.`, max 6 fractional digits, no signs, nonzero (e.g. `10.00`, `0.000001`); anything else is fatal at startup |
| `WINDOW_HOURS` | `72` | no | Compute window; metering budgets scale with it. Bearer tokens expire at `settledAt + window` once settled, else `allocatedAt + window` |
| `PROVIDER_ADDRESS` | — | **yes** | `0x` provider wallet; startup fails fast if empty |
| `POOL_ADDRESS` | — | no | Pool contract; empty disables the settle listener |
| `PORT` | `8080` | no | HTTP listen port |
| `DOCKER_HOST` | default socket | no | `unix://` or `tcp://` daemon address. `tcp://` is refused unless `ALLOW_INSECURE_DOCKER_TCP=1` — plaintext Engine API carries root-equivalent access |
| `ALLOW_INSECURE_DOCKER_TCP` | empty (deny) | no | Set `1` to allow a `tcp://` `DOCKER_HOST`. Prefer the unix socket |
| `REQUIRE_DOCKER` | empty (warn+memory fallback) | no | Set `1` to fatal when the daemon is unreachable |
| `DOCKER_NETWORK_MODE` | `none` | no | Pinned `NetworkMode` for every wallet container. Demo exec workloads need no network, so the default isolates them; set `bridge` only if workloads must egress |
| `RPC_URL` | `https://rpc.testnet.arc.io` | no | Arc JSON-RPC endpoint for settle polling and transfer receipt checks. Must be `https`, except `http://localhost`/`127.0.0.1` (allowed for httptest boot tests) — anything else is fatal at startup |
| `POLL_INTERVAL` | `5s` | no | Settle poll cadence |
| `CONFIRMATIONS` | `1` | no | Minimum confirmations for settle logs and transfer receipts alike |
| `REAPER_INTERVAL` | `10s` | no | Background reaper tick: kills containers whose billed usage plus in-flight estimate exceeds budget |
| `RATE_LIMIT_RPS` | `20` | no | Per-IP token-bucket refill rate (requests/second). Malformed values are fatal — no silent defaults |
| `RATE_LIMIT_BURST` | `40` | no | Per-IP token-bucket capacity. Malformed values are fatal — no silent defaults |
| `PUBLIC_BASE_URL` | empty (request-derived) | no | Canonical origin (e.g. `https://pool.example`) for `/terms.json` `self` and quote `termsURI`. Empty keeps request-derived behavior gated by `TRUST_PROXY` |
| `TRUST_PROXY` | empty (ignore) | no | Set `1` to honor `X-Forwarded-Host/Proto` when deriving `termsURI`. Only enable behind a proxy you control that strips client headers — otherwise any client can poison the signed terms URL |

Malformed values are fatal at startup, never silently defaulted.

Config note (`FUNDING_DEADLINE_HOURS` removed): the field was stored but never
read — no handler, poller, or refund path consulted it, so it was dead config
implying a deadline guarantee the service did not enforce. It is deleted
(env, struct, `/terms.json` `deadlineHours`) rather than half-enforced; the
funding rule is now "atomic settle to provider at threshold; over-commit
capped at target".

## Auth — opaque bearer tokens

`POST /allocate` returns `{wallet, containerId, token}`. The token is 32
`crypto/rand` bytes hex-encoded; only its sha256 is stored and comparison uses
`crypto/subtle`. Token lifecycle:

- First allocate for a new wallet needs no token; every later call for that
  wallet (`re-allocate`, `/run`, `/transfer-quota` as sender) requires
  `Authorization: Bearer <token>`.
- Every successful allocate rotates the token — use the newest one.
- Tokens expire at `settledAt + WINDOW_HOURS` once the pool settles (the
  compute window starts at settlement, so pre-settle allocations stay usable
  through it); before settle they expire at `allocatedAt + WINDOW_HOURS`.
- Dropout revokes: a quota kill (`/run` over budget) or a reaper kill revokes
  the wallet's token, so a dropped agent cannot keep executing.
- Transfer-created wallets are issued a token by the same mint helper as
  `/allocate` (identical format/expiry); the transfer response carries it as
  `toToken`, and `/allocate` for that wallet accepts it (rotating a new one).

```sh
TOKEN=$(curl -s -X POST localhost:8080/allocate \
  -H 'Content-Type: application/json' \
  -d '{"wallet":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8","cpu":0.2,"mem":800}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
curl -s -X POST localhost:8080/run \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"wallet":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8","cmd":["echo","hi"]}'
```

Status codes: `401 {"code":"unauthorized"}` for missing/unknown tokens,
`403 {"code":"forbidden"}` for revoked/expired tokens,
`409 {"code":"pool_settled"}` for any `/allocate` after settle,
`409 {"code":"pool_closed"}` for `/allocate`, `/quote`, `/transfer-quota` once
the on-chain pool expires unfilled (`/run` keeps serving — see pool awareness),
`409 {"code":"pool_exhausted"}` when a slice would oversubscribe the pool or
breach `MAX_AGENTS` (allocate and transfer-recipient paths alike),
`409 {"code":"duplicate_payment"}` when a transfer reuses a spent `txHash`,
`402 {"code":"payment_required"}` when a transfer's payment proof fails,
`429 {"code":"quota_exceeded"}` for over-budget exec,
`429 {"code":"rate_limited"}` for per-IP rate limiting.

## Pool awareness

When `POOL_ADDRESS` is set, `/allocate`, `/quote`, and `/transfer-quota` read
`settled()`, `expired()`, and `totalCommitted()` via `eth_call` first: an
expired-but-unsettled pool closes the funding endpoints with 409
`pool_closed`. `/run` is deliberately ungated — existing allocations keep
local continuity because no funds ever moved, so there is nothing to unwind,
and killing running work on expiry would destroy value for free. An
unreachable node (or an unset `POOL_ADDRESS`) fails open with a warning, never
a denial: a down node must not brick local metering.

## Endpoints

### POST /allocate — create (or resize) a wallet container

```sh
curl -s -X POST localhost:8080/allocate \
  -H 'Content-Type: application/json' \
  -d '{"wallet":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8","cpu":0.2,"mem":800}'
# {"wallet":"0x7099...79c8","containerId":"abc123","token":"..."}
```

Idempotent per wallet with auth: re-allocating replaces limits and container
and rotates the token. Admission is a single atomic reservation
(`SUM(entitlements) <= totals` in integer micro-CU/MB, wallet-sorted, plus
`MAX_AGENTS` for new wallets — no float epsilon, deterministic under
concurrency); the container is created after the reservation and confirmed,
or the reservation rolls back on failure (a failed create never leaves a
half-admitted wallet). Oversubscribing slices fail with 409 `pool_exhausted`.
A re-allocate that would drop entitlement below already-burned usage fails
with 409 `insufficient_quota` — grow-or-hold only, never a silent
instant-over-budget. After the pool settles every allocate fails with 409
`pool_settled` — allocations are final.

### POST /run — exec into the wallet container

```sh
curl -s -X POST localhost:8080/run \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"wallet":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8","cmd":["echo","hi"]}'
# {"stdout":"hi\n","stderr":"","exitCode":0}
```

Fully unknown wallets return `404 {"code":"not_found",...}`, never an empty
200. A wallet that holds entitlement but has no container bound (eviction,
restart, transfer-created) is auto-provisioned a fresh container inline —
only wallets with no entitlement at all stay 404. Wall-clock time times the
wallet slice is metered as CU-seconds/MB-hours under a reserve pattern
(`BeginExec` registers in-flight under the same lock that checks the budget,
`EndExec` bills actuals; zero-slice wallets are refused outright), so
concurrent execs cannot jointly overspend undetected; a background reaper
(`REAPER_INTERVAL`) kills containers whose billed usage plus in-flight
estimate exceeds budget, and also sweeps idle over-budget wallets with no
in-flight. A wallet already over budget gets
`429 {"code":"quota_exceeded",...}`, its container is killed, and its token is
revoked (dropout).

### GET /terms.json — pool terms generated live from config

```sh
curl -s localhost:8080/terms.json | head -c 400
```

No static file is served: every field (resource specs, funding target plus
atomic conversion, window, forfeiture and resale policy text) is built from
the current `Config` on each request. Deploy this endpoint's public URL as
the pool's immutable `resourceURI`; its shape is stable while values track
the environment. The `self` field carries the canonical document URL:
`PUBLIC_BASE_URL + /terms.json` when configured, else the request-derived URL
under the `TRUST_PROXY` policy (same rule as quote `termsURI` below).

### GET /quote — resale quote at cost basis

```sh
curl -s 'localhost:8080/quote?seller=0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
# {"seller":"0x7099...","payTo":"0x7099...",
#  "ratePerMBAtomic":"1220","ratePerCUAtomic":"5000000",
#  "availableMB":"800","availableCU":"200000",
#  "availableMBHours":"57600","availableCUSeconds":"51840",
#  "termsURI":"http://localhost:8080/terms.json"}
```

Field names match the TypeScript SDK `ComputeQuote`: all big integers cross
as decimal strings (uint format, so the SDK's `parseUint` keeps parsing).
`ratePerMBAtomic = targetAtomic / (2*totalMB)` and
`ratePerCUAtomic = targetAtomic / (2*totalCU)` use integer division. The
halving is the cost model, not a discount: the target pays for both dimensions
jointly, so each leg prices half the target and the SDK's
`mb*rateMB + cu*rateCU` composition lands on the funded share — the equal
slice 819MB + 0.2CU costs 1999180 atomic ≈ the seller's $2.00 share, with the
division dust staying unpriced with the pool. `availableMB`/`availableCU` are
the remaining slice in MB and micro-CU (cores × 1e6, floored — fractional cores
can never cross as a bare float); `availableMBHours`/`availableCUSeconds`
are the matching time-spread budgets (entitlement × window minus usage).
Unknown seller returns 404; expired-unfilled pool returns 409 `pool_closed`.

### POST /transfer-quota — shift entitlement between wallets

```sh
curl -s -X POST localhost:8080/transfer-quota \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $SELLER_TOKEN" \
  -d '{"from":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8","to":"0x90F79bf6EB2c4f870365E785982E1f101E93b906","mb":400,"cu":0.1,"txHash":"0xabc..."}'
# {"from":{"wallet":"0x7099...","cpu":0.1,"memMB":400,...},"to":{...}}
```

Requires the sender's bearer token plus a direct-payment proof `txHash`,
verified read-only against `RPC_URL` via `eth_getTransactionReceipt`: the
transaction must run buyer (`to`) → seller (`from`, the `payTo`), carry at
least the quoted cost (`mb × ratePerMB + floor(cu × ratePerCU)`), have success
status, and be at least `CONFIRMATIONS` deep. Handler order is
parse → auth → amount validation (negative or zero-zero amounts are 400
before any chain read) → quota pre-check including in-flight → receipt
verification → atomic commit. Proof failures return 402
`payment_required`; each hash spends once — a replay returns 409
`duplicate_payment`, and only a successful move consumes the hash.
Transferring to an unknown wallet creates its entitlement *and* mints its
token via the same helper as `/allocate`; the response carries it as
`toToken` for immediate use (that wallet can then allocate/run). A new
recipient past `MAX_AGENTS` fails with 409 `pool_exhausted`. Moves that would
leave the sender at exactly zero in a moved dimension fail with 409
`insufficient_quota`, as do senders whose remaining capacity (entitlement
minus window-spread usage *and* in-flight) cannot cover the slice.

Racer warning: the quota pre-check and the commit are separated by the receipt
read, so a concurrent spender can win in between and the loser's payment —
already sent on-chain — is inherently unrecoverable with direct transfers.

Explicit follow-up: x402-receipt verification (the `@x402` stack: facilitator
settlement proofs, replay protection, settle-on-delivery that also closes the
racer hole above) is out of Go stdlib scope and not implemented —
direct-transfer receipts are the supported rail; treat x402 as a future
pricing-rail addition, not a drop-in.

### GET /healthz

```sh
curl -s localhost:8080/healthz
# {"ok":true}
```

## Design notes

- `ContainerBackend` interface with `dockerBackend` (Engine REST API over
  stdlib `net/http`, unix socket or `DOCKER_HOST`) and `memoryBackend`
  (in-memory fake; all unit tests run against it).
- Container hardening: every wallet container is created with
  `CapDrop: ["ALL"]` (no Linux capabilities even if the workload escapes its
  user), `PidsLimit: 64` (fork-bomb containment), and a pinned `NetworkMode`
  (default `none` — demo exec workloads need no network; see
  `DOCKER_NETWORK_MODE`).
- Request hardening: POST bodies are capped at 1MB (`MaxBytesReader`), and a
  per-IP token-bucket limiter (`RATE_LIMIT_RPS`/`RATE_LIMIT_BURST`, keyed on
  the TCP peer — never on client headers, which are attacker-controlled)
  returns 429 `rate_limited`. Malformed limiter values are fatal at startup
  and `NewServer` rejects bad constructor params — there are no silent
  fallback limits.
- Metering budgets: `cpu * WINDOW_HOURS * 3600` CU-seconds and
  `memMB * WINDOW_HOURS` MB-hours. Exact fit passes; anything over kills.
  NaN/Inf inputs are rejected at every boundary (domain constructors, config
  CPU parse, rate math, usage/transfer paths) — float comparisons alone would
  let NaN slip past range checks.
- Settle rule: the listener polls `eth_getLogs` for `POOL_ADDRESS` from the
  latest block (boot cursor is `latest` — restarts never trigger a genesis
  rescan, which also means a `Settled` emitted while down is missed: accepted
  testnet posture, mainnet needs cursor persistence). The cursor never advances
  past unprocessed logs — it pins at the first below-target log — and every
  poll additionally re-evaluates the funding gate from chain state
  (`totalCommitted` `eth_call`), so a post-cursor top-up with no new event
  still flips. On a sufficiently-confirmed `Settled(uint256)` log it verifies
  `pool.totalCommitted()` via `eth_call` covers `TARGET_USDC` before flipping
  the ledger once (idempotent); below-target logs are logged and skipped.
  No keys, no signing; read-only RPC only.
- One error funnel (`writeJSONError`): typed `*APIError` plus sentinel
  mapping; unmapped errors log full and return generic 500.
