# Circle Agent Kit — What It Is and How We Use It

Verified 2026-09-07 against npm, GitHub, and official docs.

## 1. What "Agent Kit" actually means

There is **no `@circle-fin/agent-kit` SDK** (404 on npm for `agent-kit`,
`agentkit`, `agents`, `circle-agent-kit` — checked). "Agent Kit" is the
collective name for **Circle Agent Stack** (launched 2026-05-11) plus three
things around it:

1. **Circle CLI** (`@circle-fin/cli` v1.0.0) — the agent-native interface and
   the *only* Agent Wallet interface.
2. **Circle Skills** — prompt-text that tells agents which CLI commands to run
   (two systems, §3).
3. **Starter kits** (`circlefin/agent-stack-starter-kits`) — 6 framework
   adapters plus `circle-tools`, TS wrappers that shell out to the CLI.

The kit **wraps** CLI calls; it does not replace them or change custody.
Do not migrate off the `circle` binary. Do not mix in the
`developer-controlled-wallets` SDK — separate custodial model (API key +
entity secret, Circle co-signs server-side).

Key pages: Agent Stack overview (`developers.circle.com/agent-stack`), CLI
reference (`.../agent-stack/circle-cli/command-reference`), Agent Wallets
(`.../agent-stack/agent-wallets`), doc index (`developers.circle.com/llms.txt`),
skills runtime index (`agents.circle.com/.well-known/agent-skills/index.json`),
repos `circlefin/skills` and `circlefin/agent-stack-starter-kits`.

## 2. Custody model (unchanged by the kit)

Agent Wallets are built on user-controlled wallets with 2-of-2 MPC: key
shares never reach the agent, the user retains custody, Circle cannot move
funds unilaterally, all transfers sanctions-screened. Gas is sponsored
(capped, fair-use). `circle wallet import` (local wallets) **bypasses** all
controls — never use it for demo agents.

## 3. The skills — the "use heavily" part

Two complementary systems, not duplicates.

### System A — runtime skills (agents.circle.com, fetched live by agents)

| Skill | URL suffix (`agents.circle.com/skills/…`) | Use |
|---|---|---|
| `setup` | `setup.md` | One-prompt bootstrap: install CLI → login → create/fund wallet → discover/pay services |
| `wallet-login` | `wallet-login.md` | Email+OTP, `--init`/`--request` non-interactive flow for agents, `--testnet` sessions |
| `wallet-fund` | `wallet-fund.md` | Testnet faucet (omit `--method`), fiat/crypto, Gateway deposit |
| `wallet-pay` | `wallet-pay.md` | **Fetch before every `services pay`.** Gateway-vs-vanilla triage, `-X` requirement, error table |
| `wallet-policy` | `wallet-policy.md` | `limit` read / `limit set` / `limit reset` (OTP-gated, **mainnet-only**) |
| `discover-services` | `discover-services.md` | Discovery API search/filter/pagination |
| `recover-eco-funds` | `recover-eco-funds.md` | Legacy Eco recovery only — ignore |
| `feedback` | `feedback.md` | `circle feedback submit` for bugs/questions |

Canonical bootstrap prompt (from the Agent Wallets doc):

```text
Run curl -sL https://agents.circle.com/skills/setup.md, and use the returned setup instructions to set up my agent wallet.
```

### System B — dev skills (`circlefin/skills` repo, install once per host)

```sh
circle skill install --tool opencode   # claude-code|cursor|codex|opencode|amp
# fallback: npx skills add circlefin/skills -g
```

Agent-flow (heavy use): `use-circle-cli` (master front-door), `use-agent-wallet`
(bootstrap), `pay-via-agent-wallet`, `fund-agent-wallet`, `agent-wallet-policy`.
App-code (when writing SDK code): `use-usdc`, `use-arc`, `use-gateway`,
`use-circle-wallets`, `accept-agent-payments` (+ bridge/swap/modular-wallets as needed).

## 4. Arc testnet runbook (chain 5042002, CLI id `ARC-TESTNET`)

```sh
npm install -g @circle-fin/cli
circle wallet login you@example.com --init
circle wallet login --request <id> --otp <CODE> --testnet
circle wallet list --chain ARC-TESTNET --type agent --output json
circle wallet fund --address 0xWALLET --chain ARC-TESTNET   # faucet, 20 USDC
circle wallet balance --address 0xWALLET --chain ARC-TESTNET --output json
circle wallet transfer 0xTO --amount 5.0 --address 0xWALLET --chain ARC-TESTNET
circle wallet execute "approve(address,uint256)" 0xSPENDER 1000000 \
  --contract 0xUSDC --address 0xWALLET --chain ARC-TESTNET
circle contract query --help   # reads, no wallet/gas needed
```

Rules that bite on testnet:

- **Vanilla flows on Arc, Gateway flows elsewhere.** Gateway pay/deposit chains
  are BASE/MATIC/ETH/ARB/AVAX/OP/UNI — Arc is not Gateway-payable. Contract
  calls (`wallet execute`) and transfers on Arc use the vanilla path.
- **Policies are mainnet-only.** `wallet limit set/reset` is rejected on
  testnet — enforce pool-address checks in SDK core instead (already planned).
- Chain facts: RPC `https://rpc.testnet.arc.io`, explorer
  `testnet.arcscan.app`, faucet `faucet.circle.com`, CCTP domain 26, USDC
  `0x3600000000000000000000000000000000000000` (6-dec view; 18 native).

## 5. Starter kits (pick one framework, clone — `circle-tools` is not published)

Repo `circlefin/agent-stack-starter-kits` (Apache-2.0, bun workspace):
`kits/langchain`, `kits/claude-agent-sdk`, `kits/openai-agents`,
`kits/vercel-ai`, `kits/mastra`, `kits/google-adk`, sharing
`packages/circle-tools` (CLI wrappers: session/login, wallet + Gateway
balances, marketplace search) and `packages/agent-cli` (terminal chat UI).
Each kit: `bun install` → copy `.env.example` → `bun run demo` (bootstrap →
fund → Marketplace search → pay). Arc-testnet-only samples, not production code.

## 6. Resale market: buyer via Nanopayments CLI, seller via SDK on Arc

Official Agent Nanopayments path
(`developers.circle.com/agent-stack/agent-nanopayments/quickstart`) is
buyer-side and CLI-native — deposit, discover, pay, check balance:

```sh
circle gateway deposit --amount 5 --address 0xBUYER --chain BASE --method direct
circle services search "compute"
circle services inspect https://seller.example/compute
circle services pay https://seller.example/compute \
  --address 0xBUYER --chain BASE --max-amount 0.01
circle gateway balance --address 0xBUYER --chain BASE
```

Docs use cases name ours verbatim: "On-demand compute and data" and
"Agent-to-agent commerce". This CLI flow is the blessed Nanopayments demo
moment for the Agentic bounty — prefer it over hand-rolled buyer code.
(App-code alternative: `gateway/nanopayments/quickstarts/buyer`.)

Arc is Gateway-Nanopayments-supported (verified live, consistent with
Circle's own Arc Testnet seller blog), so the seller side is a supported
path, not a workaround. The remaining CLI question is narrow: the quickstart
examples run deposit/pay on BASE, so whether `circle services pay --chain
ARC-TESTNET` works with an Agent Wallet needs a live CLI run (email OTP)
to settle. Separately, the SDK seller path on Arc is verified live
(`eip155:5042002` in `GET /v1/x402/supported`, method
`GatewayWalletBatched`, USDC `0x3600…0000`):

```ts
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server"; // v3.4.0
const gateway = createGatewayMiddleware({ sellerAddress: "0xSURPLUS_AGENT" });
app.get("/compute", gateway.require("$0.01"), handler);
```

Buyer via SDK (if CLI is unsuitable):
`GatewayClient({ chain: "arcTestnet" })` from
`@circle-fin/x402-batching/client` (+ `@x402/core`, `@x402/evm`, `viem`).
REST alternative (no SDK): `POST /v1/x402/settle` on
`https://gateway-api-testnet.circle.com` (verify/settle routes confirmed
live). EOA restriction is confirmed at scheme level for BOTH rails: Circle
states EOA-only signing for the x402 flow, and Nanopayments signs offchain
EIP-3009 authorizations (single-key ECDSA) that a 2-of-2 MPC Agent Wallet
cannot produce directly. Narrowed open question: does the CLI derive an
EOA-compatible signer internally for nanopayment signing, or genuinely fail?
Settles with the same live CLI run as the Arc pay question above.

## 7. What NOT to adopt

- `developer-controlled-wallets` / `smart-contract-platform` SDKs (custodial
  model; only as fallback if a contract call proves unavailable via Agent Stack).
- `circle wallet import` (bypasses custody/controls).
- `bridge-kit` / `swap-kit` (frontend UI kits, not agent flows).
- Marketplace onboarding on the critical path (optional discovery surface).
